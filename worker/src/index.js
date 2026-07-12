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
//   405 { "error": "method_not_allowed", "message": "..." }
//   502 { "error": "upstream_timeout" | "upstream_error" | "upstream_status" | "upstream_not_json" | "upstream_bad_json" | "upstream_shape", "message": "..." }
//
// Error codes are stable identifiers safe for the client to branch on.

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

export default {
  async fetch(request, env, ctx) {
    // Preflight (browser sends this before actual GET; respond fast and cacheable)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders(), 'access-control-allow-headers': request.headers.get('access-control-request-headers') || '' },
      });
    }
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Only GET and OPTIONS are supported', 405);
    }

    const url = new URL(request.url);
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

    // Cache miss — call OneMap with a hard per-request timeout so a stalled
    // upstream connection can never hang the Worker (Node/CF fetch has no
    // default deadline).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchUpstream(postal, hbn, controller.signal);
    } catch (e) {
      clearTimeout(timer);
      const code = e.name === 'AbortError' ? 'upstream_timeout' : 'upstream_error';
      return errorResponse(code, e.message || 'upstream fetch failed', 502);
    }
    clearTimeout(timer);

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
