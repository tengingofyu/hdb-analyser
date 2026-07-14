# Worker ringfence — layers and escalation

The `hdb-schools-parity` Worker sits between our GitHub Pages client and OneMap's private School Query API. It's the only Cloudflare account resource with real-world dependencies (OneMap traffic quota, our identity as a caller) — everything else in this repo is static assets.

**Design principle:** proportionate, not paranoid. Each layer stops one attack shape at low cost; none of them tries to be a fence. The layers stack — a determined actor eventually gets through, and that's OK, because the client's fallback path never leaves users looking at a spinner.

## The layer stack

| # | Layer | Stops | Cost | Where |
|---|-------|-------|------|-------|
| 1 | CORS ACAO lock | Browsers at other origins reading our response | 0 | `corsHeaders()` in `worker/src/index.js` |
| 2 | Origin/Referer allowlist | Casual (non-browser) scripted callers who don't spoof `Origin` | 1 header check | `originAllowed()` |
| 3 | Per-IP rate limit (30/min) | Single-IP scrapers | 1 Cache API read+write per request | `checkRateLimit()` |
| 4 | Global daily circuit breaker (5000 upstream/day) | Distributed scrapes that clear layer 3 by rotating IPs | 1 Cache API read per cache-miss | `readCounter('upstream', today)` gate before `fetchUpstream()` |

Each layer has a **stable error code** clients can branch on. The client's `fetchOneMapSchools()` treats every non-2xx identically — falls back to the static list — so upgrading the ringfence never breaks users.

### Layer 1 — CORS ACAO lock

`Access-Control-Allow-Origin: https://tengingofyu.github.io` (single origin, no wildcards). A browser at any other origin can send the request but cannot read the response. Zero-cost, catches the accidental case (someone embeds our JS elsewhere).

Failure mode this DOES stop: `<script src="https://evil.example/steal.js">` at evil.example accidentally triggering the fetch. Browser blocks the response.

Failure mode this does NOT stop: `curl` with a spoofed Origin header.

### Layer 2 — Origin/Referer allowlist (added 2026-07-14)

`originAllowed()` requires either `Origin: https://tengingofyu.github.io` OR `Referer: https://tengingofyu.github.io/...`. Missing OR mismatching → 403 `forbidden_origin`. Applies to OPTIONS preflight too, so cross-origin fetches never even attempt the GET.

Failure mode this DOES stop: `curl https://hdb-schools-parity.hdb-analyser.workers.dev/?...` with no headers. The 90% of casual probing traffic.

Failure mode this does NOT stop: `curl -H "Origin: https://tengingofyu.github.io" ...`. That's fine — a determined caller with spoofed headers still hits layers 3 and 4.

The watchdog (`scripts/schools-watchdog.mjs`) sends the Origin header explicitly for this reason. It IS us; the header just declares that.

### Layer 3 — Per-IP rate limit

Cache API-backed. 30 requests per minute per `cf-connecting-ip`. Under legitimate use a single user's real search rate is ~1/postal — nowhere near the ceiling. Under a single-IP scrape the counter crosses the limit within a few seconds and stays over it for the rest of the window; `Retry-After: 60` header set on 429s.

Not atomically correct (two concurrent requests can both read count=N and each increment to N+1), which is fine — abuse control doesn't need microsecond precision, and legitimate concurrent load stays well below the limit.

Failure mode this DOES stop: a single scraper from a single IP.

Failure mode this does NOT stop: distributed scrapes rotating IPs (residential proxy pools, Tor exit nodes).

### Layer 4 — Global daily circuit breaker (added 2026-07-14)

Counts total upstream OneMap calls (cache MISSes only) per UTC day. When today's count reaches `DAILY_UPSTREAM_CAP` (5000), further cache misses return 503 `daily_upstream_cap` **without calling OneMap**. Cache HITs continue to serve normally. Counter resets automatically at UTC midnight (the counter key is date-keyed).

Sizing: 5000/day is comfortably above legitimate demand. A full Singapore-wide unique-block sweep is ~9000 blocks, but the 24 h cache means a real user driving up the counter would need 5000+ *distinct* (postal, hbn) pairs in one UTC day. That's not a real user; that's an attack.

Failure mode this DOES stop: distributed scrapes that clear layer 3 by rotating IPs — they still all count against the same daily counter.

Failure mode this does NOT stop: an attack timed for just before UTC midnight (2× the daily budget in a single wall-clock hour by crossing the reset). Real-world impact bounded to 24 hours of degraded live-badge state; client fallback keeps working.

## Observability — the /_stats endpoint

`GET /_stats` returns per-day counters (`requests`, `upstream_misses`) for the last 8 UTC days. Same Origin gate as the main endpoint. The watchdog reads this weekly and flags loudly if:

- Yesterday's requests > 3× trailing 7-day average (with a floor of 100 req/day so we don't alert on 1→10 amplification when everything is tiny).
- Yesterday's `upstream_misses` >= 80% of the daily cap (headroom warning — we're close to tripping the breaker in normal operation, which means either legitimate usage grew or someone found a way through the earlier layers).

## Escalation — held-in-reserve options

### Cloudflare Turnstile

**Trigger criterion:** sustained daily upstream cap breaches — i.e., the breaker (layer 4) firing on 2+ consecutive days OR the watchdog alerting on the >3× spike heuristic for 2+ consecutive weeks.

**Why held in reserve:** Turnstile adds a small user-facing challenge (invisible in the happy path, visible when Cloudflare's risk score flags a session). It's a UX regression for the median user, so we don't ship it until the current layers demonstrably fail to hold.

**How to enable when the criterion trips:**

1. In Cloudflare dashboard: Turnstile → Add site → managed challenge, hostname `tengingofyu.github.io`.
2. Client (`index.html`): include the Turnstile widget script and render an invisible widget in the schools section. On solve, pass the token to the Worker as `X-Turnstile-Token: <token>` on the schools request.
3. Worker: add a new `TURNSTILE_SECRET` env var (from the dashboard). In the request handler, before layer 4, POST the token to `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Reject 403 `turnstile_failed` on non-success.
4. Client fallback path: already handles non-2xx as fallback, so a Turnstile failure gracefully degrades to the static list.

Rough effort estimate: half a day including local test flow. Keep this doc updated with the runbook as more escalation options are researched.

### Not held in reserve (deliberately avoided)

- **Named domain + WAF.** Overkill for our traffic profile and adds a monthly cost. Only revisit if OneMap flags our IP as a scraper (untraceable → they blocklist us).
- **Server-issued signed tokens (JWT / HMAC).** Doesn't add much over Origin+rate-limit+cap for this threat model; adds meaningful complexity (key rotation, deploy coordination).
- **KV-backed atomic counters.** The soft race in the current Cache API counters is fine given the layer purposes. If we ever need strict correctness (e.g., billing), swap to KV, but not before.

## Verification checklist

Run after any change to `worker/src/index.js`:

- [ ] `worker/wrangler deploy` from a clean tree
- [ ] `curl -o /dev/null -w "%{http_code}"` without Origin → **403**
- [ ] `curl -H "Origin: https://evil.example" ...` → **403**
- [ ] `curl -H "Origin: https://tengingofyu.github.io" ...` → **200**
- [ ] `curl -H "Referer: https://tengingofyu.github.io/foo" ...` → **200**
- [ ] `/_stats` without Origin → **403**; with Origin → **200** with `days` array
- [ ] Watchdog local run (`node scripts/schools-watchdog.mjs` with `CHROME_BIN` set) → all green
- [ ] Live-site regression: legitimate browser flow at `https://tengingofyu.github.io/hdb-analyser/` still shows green badge for 560472
