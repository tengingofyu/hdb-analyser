# hdb-schools-parity Worker

A Cloudflare Worker (free tier) that proxies OneMap's private School Query API so our GitHub Pages page can call it cross-origin. OneMap's endpoint:

- Requires a `Referer: https://www.onemap.gov.sg/school` header (only whitelisted referers get through — no header → 403).
- Returns no `Access-Control-Allow-Origin` on responses, so a browser at any non-onemap origin can send the request but not read the response.

The Worker calls OneMap server-side with the required Referer, caches per-postal for 24h, and returns the JSON to the browser with a proper CORS header for our origin only.

## Endpoint

```
GET https://hdb-schools-parity.<account>.workers.dev/?postalcode=<6 digits>&hbn=<block>
```

Success (200):
```json
{
  "Timestamp": "10 Jul 2026 12:58 AM (GMT+8)",
  "Disclaimer": " ",
  "SearchResults": [
    {
      "SCHOOLNAME": "CHIJ OUR LADY OF GOOD COUNSEL",
      "DIST_CODE": "1",
      "SCH_POSTAL_CODE": "558979",
      "LATITUDE": "1.35773...",
      "LONGITUDE": "103.86394...",
      "GEOMETRY": "…encoded polyline of school boundary…",
      "…": "…"
    }
  ]
}
```

`DIST_CODE` is OneMap's HSD band code: `"1"` = within 1 km, `"2"` = within 1–2 km. That's the exact same categorisation shown on onemap.gov.sg/school.

### hbn is required and semantic

HSD is per-building. `hbn` MUST be the block number that actually lives at that postal — the client should pass the block returned by OneMap's own geocoder for the postal, not a guess.

Empirically against OneMap:

- `postalcode=560472&hbn=472` (correct) → 9 schools with proper DIST_CODEs.
- `postalcode=560472&hbn=471` (a real neighbouring block, wrong for this postal) → OneMap returns `[{"Results":"No result found. "}]`. **Silent zero-schools answer with no error.**
- `postalcode=560472&hbn=999` (bogus) → same silent sentinel.
- `postalcode=560472` (hbn missing) → OneMap 400 "Your House Block No.(hbn) is missing". The Worker's validator rejects this before ever calling upstream (`bad_hbn` 400).

The Worker normalises the "No result found" sentinel to an actual empty `SearchResults` array so downstream code doesn't iterate a phantom row. But there is no way for the Worker to detect *"the client passed the wrong hbn for this postal"* — that would require its own postal→block index and re-derives complexity we're trying to remove. The correctness responsibility for `hbn` sits with the caller.

### Rate limit

30 requests/min per IP (from `cf-connecting-ip`, so per real client not per Worker frontend). Backed by the Cache API — not atomic, so bursty legitimate load may see approximate accounting, but any sustained scrape crosses the threshold within a couple of seconds and gets stuck at 429 until the 60s window rolls over. Rejected responses set `Retry-After: 60`.

The CORS lock (`Access-Control-Allow-Origin: https://tengingofyu.github.io`) stops a browser at any other origin from *reading* our response — but a scripted caller with a spoofed `Origin` header would still get through CORS. The rate limit is the origin-independent abuse control.

Errors are structured JSON with a stable `error` code:

| HTTP | code | when |
|---|---|---|
| 400 | `bad_postal` | postalcode is missing or not exactly 6 digits |
| 400 | `bad_hbn` | hbn is missing or not 1–4 digits with optional single upper-case suffix |
| 405 | `method_not_allowed` | non-GET, non-OPTIONS request |
| 429 | `rate_limited` | more than 30 requests/min from the same IP; `Retry-After: 60` header set |
| 502 | `upstream_timeout` | OneMap fetch didn't complete within 10s |
| 502 | `upstream_error` | fetch threw (DNS, network, TLS) |
| 502 | `upstream_status` | OneMap returned non-2xx |
| 502 | `upstream_not_json` | OneMap returned non-JSON (defends against HTML passthrough) |
| 502 | `upstream_bad_json` | OneMap JSON couldn't be parsed |
| 502 | `upstream_shape` | OneMap JSON is parsed but has no `SearchResults` array |

## Cache: Cache API, not KV

- 24h TTL per postal set via `Cache-Control: max-age=86400` on the cached response.
- Cache API is per-datacenter, but Singapore HDB traffic originates from the SIN datacenter so cross-datacenter distribution isn't a real hit-rate concern.
- Zero setup overhead vs. KV's namespace bindings and account bindings.
- KV's free-tier write cap (1000/day) would be a bottleneck long term for a Singapore-wide index; Cache API has no equivalent cap on our shape.

`x-cache: HIT | MISS` response header exposes cache state for verification.

## Deploy

Requires a Cloudflare API token with the `Workers Scripts:Edit` permission on the target account.

```
cd worker
npm install
CLOUDFLARE_API_TOKEN=<token> npx wrangler deploy
```

The default deploy target is `<name>.<account>.workers.dev` — the URL surfaces in the deploy output.

Free tier: 100,000 requests/day; each request runs well under the 10ms CPU budget. See headroom math after deploy.
