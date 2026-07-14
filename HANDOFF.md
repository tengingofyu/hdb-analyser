# HDB Analyser — Handoff notes

Living doc. If you're picking this up cold, `CLAUDE.md` has the working rules; this file has the state of the world.

## What ships where

- **Frontend** — single-file `index.html`, deployed to GitHub Pages at `https://tengingofyu.github.io/hdb-analyser/` on every push to `main` via `.github/workflows/deploy.yml`.
- **Schools proxy Worker** — `worker/` — Cloudflare Worker at `https://hdb-schools-parity.hdb-analyser.workers.dev` proxying OneMap's School Query API. CORS-locked to the Pages origin. Deploy via `cd worker && CLOUDFLARE_API_TOKEN=... npx wrangler deploy`.
- **Monthly geocode refresh** — `.github/workflows/update-coords.yml` — re-geocodes MRT / MOE schools / kindergartens / childcare via OneMap and writes the constants back into `index.html`. Scheduled 02:00 UTC on the 1st. Manual trigger: `touch .github/dispatch-coords && git commit -m ... && git push`.
- **Weekly watchdog** — `.github/workflows/schools-watchdog.yml` — verifies the Worker + live-site schools pipeline every Monday 03:00 UTC. Detailed below.
- **Analytics** — Google Apps Script beacon at the URL in `ANALYTICS_URL` (see `ANALYTICS_SETUP.md`).

## Two-source schools architecture (shipped 2026-07-12)

The `#schoolsSection` in the Amenities tab has two source paths, chosen at render time:

### Live path (Worker-first, authoritative)

- Client calls `SCHOOLS_WORKER_URL/?postalcode=<6-digit>&hbn=<block>` with a 3 s `AbortController` timeout.
- Worker calls OneMap's `schooldataAPI/querySchools` (Referer-gated, no CORS) and returns the JSON to us with a proper ACAO header, cached 24 h per (postal, hbn).
- Client renders OneMap's `DIST_CODE` bands verbatim: `"1"` = within 1 km, `"2"` = 1–2 km.
- Green badge: `Source: OneMap School Query · as of <Timestamp>`.
- HSD = Home-School Distance, MOE's boundary-based measure used in P1 registration.

### Fallback path (static straight-line)

Triggers on ANY failure of the live path: 3 s timeout, non-2xx (including 429), malformed JSON, empty `SearchResults` sentinel for a resolvable block.

- Client falls back to the in-page `PRIMARY_SCHOOLS` constant with a haversine 1 km / 1–2 km partition.
- Amber badge: `Approximate (straight-line) — live data unavailable`.
- Existing caveat and `onemap.gov.sg/school` link preserved.

### Why two sources

- **Worker path is correct** for P1 registration. HSD ≠ straight-line, so the static list can name schools MOE doesn't actually consider in-catchment (e.g. Townsville PS at 600 m from AMK 472 straight-line, but outside the HSD boundary).
- **Static path is a resilience floor.** OneMap gets rate-limited or takes an outage twice a year; the static list is stale by weeks but never blank. The `PRIMARY_SCHOOLS` constant is refreshed monthly by `update-coords.yml`.

### Failure modes and their signals

| Failure | Client renders | Watchdog catches |
|---|---|---|
| Worker down / DNS | amber fallback | ✓ live-site DOM check would fail |
| Worker returns 429 | amber fallback | ✓ live-site DOM check would fail; health check would also |
| Worker returns 502 (OneMap flaky) | amber fallback | ✓ (only if the flaky condition persists across the run) |
| MOE rezones a postal | green live badge with new list | ✓ known-answer diff for 560472 fires |
| Client CSP misses Worker origin | amber fallback | ✓ live-site DOM check would fail |

### Editing this system

- **Don't touch `PRIMARY_SCHOOLS` without also running Phase 0 verification.** The workflow is `update-coords.yml`; running it manually is the safe path.
- **Don't touch the Worker's CORS lock** — it's the only origin-independent abuse control alongside the rate limiter.
- **Any change to any of the above requires the manual OneMap parity check** (see CLAUDE.md convention 5).

## Weekly watchdog — how to read a failure

`.github/workflows/schools-watchdog.yml` runs 3 checks and fails loud on drift. If it fires:

1. **Open the run** from the `Actions` tab and scroll to the `Run watchdog` step.
2. **Section 1 failures** (`worker-content`, `worker-shape`) mean the Worker's answer for 560472 differs from `.github/data/known-schools-560472.json`.
   - **Likely cause A: MOE rezoned.** Hit `https://www.onemap.gov.sg/school`, enter `560472`, note the new answer. If MOE is authoritative-and-different, update `.github/data/known-schools-560472.json` in a single commit with `chore(watchdog): resync 560472 known-answer to MOE current`. Include a note on what shifted.
   - **Likely cause B: pipeline broke.** Check `worker/src/index.js`, recent OneMap upstream headers, and whether the Worker is being blocked by OneMap's Referer check.
3. **Section 2 failures** (`worker-health`) mean the Worker is unreachable or the cache path is broken. Check the Cloudflare dashboard.
4. **Section 3 failures** (`site-render`) mean the client-side wiring diverged from the Worker output. Check CSP, `fetchOneMapSchools`, and the badge CSS classes.

## Open threads

- **Phase 3 dashboarding.** The watchdog fails-loud but doesn't summarise. If drift becomes common, add a metrics push to whatever observability we have.
- **Multiple known-answer postals.** Currently the watchdog checks only 560472. If HSD boundaries drift, one postal may be a lagging indicator. Consider adding 123311 (Henry Park in 1–2 km) and 600268 (Yuhua in 1 km) as second and third canaries.

## Historical incidents worth remembering

- **560472 → 449 m Yuhua ambiguity**: Traced to a truncated `PRIMARY_SCHOOLS` constant, not a bad calculation. Fix in commit `82ea750`.
- **Workflow #11 push race**: Long-running geocode finished after a human tail-link commit landed. Fixed with proactive rebase in `update-coords.yml`. Do not skip the check `gh run list --branch main --status in_progress` before pushing (Convention 4).
- **False parity bug for Henry Park at 123311**: Mis-attribution — user was comparing OneMap site to our static list, not to Worker output. Confirmed Worker is clean; static list omits Henry Park because straight-line ≠ HSD.
- **macOS LibreSSL curl handshake failure on fresh workers.dev subdomain**: Not a Worker bug — TLS 1.3 quirk. Node's fetch works fine.
