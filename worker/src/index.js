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

    const responseBody = JSON.stringify(payload);
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
