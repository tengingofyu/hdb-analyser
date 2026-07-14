// hdb-schools-parity Cloudflare Worker
//
// Proxies OneMap's private School Query endpoint to give our GitHub Pages
// origin the same HSD-based, P1-scoped school list the OneMap schoolfinder
// itself returns. OneMap's endpoint gates access on a Referer whitelist and
// returns no ACAO header for cross-origin browser calls; this Worker calls
// it server-side with the required Referer, caches per-postal for 24h, and
// forwards the JSON to us with a proper CORS header.
//
// Endpoint contract:
//   GET /?postalcode=560472&hbn=472
// Returns:
//   200 { "Timestamp": "...", "Disclaimer": " ", "SearchResults": [ {SCHOOLNAME, DIST_CODE, ...}, ... ] }
//   400 { "error": "bad_postal" | "bad_hbn", "message": "..." }
//   403 { "error": "forbidden_origin", "message": "..." }
//   405 { "error": "method_not_allowed", "message": "..." }
//   429 { "error": "rate_limited", "message": "..." }
//   502 { "error": "upstream_timeout" | "upstream_error" | "upstream_status" | "upstream_not_json" | "upstream_bad_json" | "upstream_shape", "message": "..." }
//   503 { "error": "daily_upstream_cap", "message": "..." }
//
// Stats endpoint:
//   GET /_stats                    → { days: [{date, requests, upstream_misses}, ...] } for the last 8 UTC days.
//
// Error codes are stable identifiers safe for the client to branch on. See RINGFENCE.md
// for the full ringfence layer stack and when to reach for the held-in-reserve options.

const ALLOWED_ORIGIN = 'https://tengingofyu.github.io';
const UPSTREAM_URL   = 'https://www.onemap.gov.sg/omapi/om/api/private/schooldataAPI/querySchools';
const UPSTREAM_REFERER = 'https://www.onemap.gov.sg/school';
const UPSTREAM_TIMEOUT_MS = 10_000;
const CACHE_TTL_SECONDS   = 24 * 60 * 60;

// Per-IP rate limit. CORS lock stops browser abuse from other origins, but any
// scripted caller can spoof Origin, so we still need an origin-independent
// abuse control. 30 req/min per IP is generous for a legit page user (a real
// search only fires 1 lookup per postal change) and hard-blocks scraping runs.
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

// Global daily circuit breaker. Independent of per-IP rate limiting — this caps
// total upstream calls in a day so a distributed scrape (many IPs) can't rack up
// unbounded OneMap traffic. Only cache MISSes count; a HIT-heavy day doesn't burn
// the budget. Reset happens naturally at UTC midnight (the counter key changes).
// 5000/day is comfortably above legitimate demand — a full Singapore-wide unique-
// postal sweep is ~9000 blocks but we'd cache 24h so a real user driving up the
// counter would need 5000+ *distinct* postal+hbn pairs in a single UTC day.
const DAILY_UPSTREAM_CAP = 5_000;
const STATS_RETENTION_DAYS = 8;

// OneMap's "no schools for this address" sentinel — a one-element array with
// a Results text instead of a school row. Normalise to an actual empty array
// so downstream iteration doesn't hit a phantom row.
const NO_RESULT_SENTINEL_TEXT = /^No result found/i;

function corsHeaders() {
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
    'vary': 'Origin',
  };
}

function jsonResponse(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extra,
    },
  });
}

function errorResponse(code, message, status) {
  return jsonResponse(status, { error: code, message });
}

function utcDateKey(d = new Date()) {
  // YYYY-MM-DD in UTC. Keys change atomically at UTC midnight, giving the
  // circuit breaker its natural daily reset.
  return d.toISOString().slice(0, 10);
}

// Server-side Origin/Referer check. Complements the ACAO lock: a browser at
// any origin other than ours can't READ our response, but a scripted caller
// with spoofed CORS still could. Requiring a matching Origin OR Referer header
// filters casual (non-browser) traffic without breaking any real user. Spoofing
// is trivial for a determined attacker — this is a rung, not a fence.
function originAllowed(request) {
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';
  if (origin === ALLOWED_ORIGIN) return true;
  if (referer && referer.startsWith(ALLOWED_ORIGIN + '/')) return true;
  // Preflight: browsers send Origin on OPTIONS too. If it matches, allow.
  // If not, block preflight so cross-origin fetch never even attempts the GET.
  return false;
}

// Postal codes in Singapore are exactly 6 digits. HDB block numbers are
// 1-4 digits + optional single uppercase letter suffix (e.g. 472, 104A, 2C).
// Reject anything else at the boundary so malformed inputs never reach OneMap.
function validate(postal, hbn) {
  if (!postal || !/^\d{6}$/.test(postal)) return { ok: false, code: 'bad_postal', msg: 'postalcode must be 6 digits' };
  if (!hbn    || !/^\d{1,4}[A-Z]?$/.test(hbn))   return { ok: false, code: 'bad_hbn',    msg: 'hbn must be 1-4 digits with an optional single uppercase letter suffix' };
  return { ok: true };
}

// Coarse per-IP rate limit backed by the Cache API. Not atomically-correct —
// two requests inside a sub-second window can both read the same count and
// each increment to N+1 — but that's fine for abuse control. Under legitimate
// load the counter still reflects roughly-current traffic; under an attack
// the counter crosses the limit within a few requests and stays over it.
async function checkRateLimit(ip, ctx) {
  if (!ip) return { ok: true, count: 0 }; // no IP header (unusual but possible)
  const key = new Request(
    `https://ratelimit.internal/ip/${encodeURIComponent(ip)}`,
    { method: 'GET' }
  );
  const cache = caches.default;
  const cached = await cache.match(key);
  let count = 0;
  if (cached) {
    try { count = parseInt(await cached.text(), 10) || 0; } catch(e) {}
  }
  if (count >= RATE_LIMIT_PER_MINUTE) {
    return { ok: false, count };
  }
  const next = count + 1;
  const cachedResp = new Response(String(next), {
    headers: { 'cache-control': `public, max-age=${RATE_LIMIT_WINDOW_SECONDS}` },
  });
  ctx.waitUntil(cache.put(key, cachedResp));
  return { ok: true, count: next };
}

// Daily counters (requests, upstream_misses) keyed by UTC date, stored in the
// Cache API for STATS_RETENTION_DAYS. Same race semantics as the rate limiter —
// best-effort under concurrent load, but plenty accurate for a soft cap and for
// end-of-day reporting.
function counterKey(kind, date) {
  return new Request(`https://stats.internal/day/${date}/${kind}`, { method: 'GET' });
}

async function readCounter(kind, date) {
  const cached = await caches.default.match(counterKey(kind, date));
  if (!cached) return 0;
  try { return parseInt(await cached.text(), 10) || 0; } catch (e) { return 0; }
}

async function bumpCounter(kind, date, ctx, delta = 1) {
  const current = await readCounter(kind, date);
  const next = current + delta;
  const resp = new Response(String(next), {
    headers: { 'cache-control': `public, max-age=${STATS_RETENTION_DAYS * 86400}` },
  });
  ctx.waitUntil(caches.default.put(counterKey(kind, date), resp));
  return next;
}

async function fetchUpstream(postal, hbn, signal) {
  const url = `${UPSTREAM_URL}?hbn=${encodeURIComponent(hbn)}&postalcode=${encodeURIComponent(postal)}`;
  return fetch(url, {
    method: 'GET',
    headers: {
      // OneMap's private API gates on this exact Referer. Absent → 403.
      'Referer': UPSTREAM_REFERER,
      'User-Agent': 'hdb-analyser-schools-worker/1',
      'Accept': 'application/json',
    },
    signal,
  });
}

// Stats endpoint: last STATS_RETENTION_DAYS of counters. Returns dates in
// descending order (today first). Same Origin gate as the main endpoint.
async function statsResponse() {
  const days = [];
  const today = new Date();
  for (let i = 0; i < STATS_RETENTION_DAYS; i++) {
    const d = new Date(today.getTime() - i * 86400 * 1000);
    const date = utcDateKey(d);
    const [requests, upstream_misses] = await Promise.all([
      readCounter('requests', date),
      readCounter('upstream', date),
    ]);
    days.push({ date, requests, upstream_misses });
  }
  return jsonResponse(200, {
    generated_at: new Date().toISOString(),
    daily_upstream_cap: DAILY_UPSTREAM_CAP,
    rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
    days,
  });
}

export default {
  async fetch(request, env, ctx) {
    // Preflight (browser sends this before actual GET; respond fast and cacheable).
    // Also enforce Origin allowlist here so cross-origin fetches never even reach GET.
    if (request.method === 'OPTIONS') {
      if (!originAllowed(request)) {
        // No CORS headers on 403 — the browser will then block the actual fetch too.
        return new Response(JSON.stringify({ error: 'forbidden_origin', message: 'Origin not on allowlist' }), {
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), 'access-control-allow-headers': request.headers.get('access-control-request-headers') || '' },
      });
    }
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Only GET and OPTIONS are supported', 405);
    }

    // Origin/Referer gate. Applies to /_stats and the main endpoint alike — both
    // are for our Pages origin only.
    if (!originAllowed(request)) {
      return errorResponse('forbidden_origin', 'This endpoint accepts requests only from the hdb-analyser Pages origin', 403);
    }

    const today = utcDateKey();
    // Count every accepted request (post-Origin gate). Rate-limited and validation
    // rejects still count toward daily volume so operational visibility is honest.
    ctx.waitUntil(bumpCounter('requests', today, ctx));

    const url = new URL(request.url);

    // Ops endpoint — daily counters. No caching, no upstream, no rate-limit charge.
    if (url.pathname === '/_stats') {
      return await statsResponse();
    }

    const postal = url.searchParams.get('postalcode');
    const hbn    = url.searchParams.get('hbn');

    const v = validate(postal, hbn);
    if (!v.ok) return errorResponse(v.code, v.msg, 400);

    // Abuse guard runs BEFORE the cache lookup — a scraper can't get free cache
    // hits either (both would count against OneMap's identity when they miss).
    const ip = request.headers.get('cf-connecting-ip') || '';
    const rl = await checkRateLimit(ip, ctx);
    if (!rl.ok) {
      const resp = errorResponse('rate_limited', `Rate limit exceeded (${RATE_LIMIT_PER_MINUTE}/min per IP)`, 429);
      resp.headers.set('retry-after', String(RATE_LIMIT_WINDOW_SECONDS));
      return resp;
    }

    // Cache key: synthetic same-origin URL so the Cache API keys deterministically.
    // The real client URL isn't a good key because different query-param orderings
    // hash separately even when semantically identical.
    const cacheKey = new Request(`https://cache.internal/schools?p=${postal}&hbn=${hbn}`, { method: 'GET' });
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      // Rebuild the response so we can force x-cache: HIT and re-apply CORS
      // headers (the cached body is the upstream payload verbatim).
      const headers = new Headers(cached.headers);
      headers.set('x-cache', 'HIT');
      for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
      return new Response(cached.body, { status: cached.status, headers });
    }

    // Cache miss — before calling upstream, check the daily circuit breaker.
    // If today's upstream calls have already hit the cap, return the error shape
    // and let the client fall back. Breaker resets automatically at UTC midnight
    // because the counter key changes.
    const upstreamCount = await readCounter('upstream', today);
    if (upstreamCount >= DAILY_UPSTREAM_CAP) {
      const resp = errorResponse(
        'daily_upstream_cap',
        `Daily upstream cap reached (${DAILY_UPSTREAM_CAP}). Try again after 00:00 UTC.`,
        503
      );
      // Retry-After to next UTC midnight, capped so the header stays sensible.
      const now = new Date();
      const midnight = new Date(now); midnight.setUTCHours(24, 0, 0, 0);
      const retrySeconds = Math.max(60, Math.round((midnight - now) / 1000));
      resp.headers.set('retry-after', String(retrySeconds));
      return resp;
    }

    // Cache miss AND under the cap — call OneMap with a hard per-request timeout so
    // a stalled upstream connection can never hang the Worker (Node/CF fetch has no
    // default deadline).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchUpstream(postal, hbn, controller.signal);
    } catch (e) {
      clearTimeout(timer);
      // Count the failed upstream attempt — that traffic went out even if it errored.
      ctx.waitUntil(bumpCounter('upstream', today, ctx));
      const code = e.name === 'AbortError' ? 'upstream_timeout' : 'upstream_error';
      return errorResponse(code, e.message || 'upstream fetch failed', 502);
    }
    clearTimeout(timer);
    // Record the upstream call regardless of upstream's own status — we made the
    // outbound request, that's what the cap is protecting.
    ctx.waitUntil(bumpCounter('upstream', today, ctx));

    if (!upstream.ok) {
      // Includes 403 Referer-denied, 429 rate-limit, 5xx outage
      return errorResponse('upstream_status', `OneMap returned HTTP ${upstream.status}`, 502);
    }
    // Guard against HTML passthrough on some weird upstream state — never let
    // a bad content-type reach the client wrapped as if it were school data.
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return errorResponse('upstream_not_json', `Unexpected content-type: ${ct.slice(0, 100)}`, 502);
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch (e) {
      return errorResponse('upstream_bad_json', 'Failed to parse upstream JSON', 502);
    }

    // OneMap's response envelope is { Timestamp, Disclaimer, SearchResults[] }.
    // Shape check catches format drift without hard-failing on empty results
    // (empty SearchResults is a valid, expected response for a rural postal).
    if (!payload || !Array.isArray(payload.SearchResults)) {
      return errorResponse('upstream_shape', 'Upstream response missing SearchResults array', 502);
    }

    // Normalise OneMap's "no result" sentinel [{Results:"No result found. "}]
    // into an actual empty array. Downstream code should iterate SearchResults
    // as school rows; a phantom row with a Results text is a silent trap when
    // (for example) the client passes a syntactically-valid but wrong hbn for
    // the postal — OneMap returns 200 with the sentinel, not an error.
    if (payload.SearchResults.length === 1 &&
        typeof payload.SearchResults[0]?.Results === 'string' &&
        NO_RESULT_SENTINEL_TEXT.test(payload.SearchResults[0].Results)) {
      payload.SearchResults = [];
    }

    const response = jsonResponse(200, payload, {
      'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'x-cache': 'MISS',
    });

    // Store the response for cache hits. waitUntil runs after we've replied,
    // so the client doesn't wait on the cache write.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return response;
  },
};
