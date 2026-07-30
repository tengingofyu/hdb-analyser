# HDB Analyser — Handoff notes

Living doc. If you're picking this up cold, `CLAUDE.md` has the working rules; this file has the state of the world.

## What ships where

- **Frontend** — single-file `index.html`, deployed to GitHub Pages at `https://tengingofyu.github.io/hdb-analyser/` on every push to `main` via `.github/workflows/deploy.yml`.
- **Schools proxy Worker** — `worker/` — Cloudflare Worker at `https://hdb-schools-parity.hdb-analyser.workers.dev` proxying OneMap's School Query API. CORS-locked to the Pages origin AND behind an Origin/Referer allowlist + per-IP rate limit + daily upstream circuit breaker (see `RINGFENCE.md`). Deploy via `cd worker && CLOUDFLARE_API_TOKEN=... npx wrangler deploy`.
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
| Worker returns 403 forbidden_origin | amber fallback | ✓ live-site DOM check would fail (client browsers naturally send Origin) |
| Worker returns 429 | amber fallback | ✓ live-site DOM check would fail; health check would also |
| Worker returns 502 (OneMap flaky) | amber fallback | ✓ (only if the flaky condition persists across the run) |
| Worker returns 503 daily_upstream_cap (breaker tripped) | amber fallback | ✓ live-site DOM check would fail; usage-report headroom warning fires earlier at 80% |
| MOE rezones a postal | green live badge with new list | ✓ known-answer diff for 560472 fires |
| Client CSP misses Worker origin | amber fallback | ✓ live-site DOM check would fail |
| Sustained traffic spike (real growth OR abuse) | green or amber depending on breaker state | ✓ usage report flags yesterday > 3× trailing avg |

### Editing this system

- **Don't touch `PRIMARY_SCHOOLS` without also running Phase 0 verification.** The workflow is `update-coords.yml`; running it manually is the safe path.
- **Don't touch the Worker's CORS lock, Origin gate, or circuit breaker without re-reading `RINGFENCE.md`.** Each layer stops a specific attack shape; removing one silently downgrades everything else.
- **Any Worker change must be verified against RINGFENCE.md's checklist before deploy.**
- **Any change to any of the above requires the manual OneMap parity check** (see CLAUDE.md convention 5).

## Weekly watchdog — how to read a failure

`.github/workflows/schools-watchdog.yml` runs 4 checks and fails loud on drift. If it fires:

1. **Open the run** from the `Actions` tab and scroll to the `Run watchdog` step.
2. **Section 1 failures** (`worker-content`, `worker-shape`) mean the Worker's answer for 560472 differs from `.github/data/known-schools-560472.json`.
   - **Likely cause A: MOE rezoned.** Hit `https://www.onemap.gov.sg/school`, enter `560472`, note the new answer. If MOE is authoritative-and-different, update `.github/data/known-schools-560472.json` in a single commit with `chore(watchdog): resync 560472 known-answer to MOE current`. Include a note on what shifted.
   - **Likely cause B: pipeline broke.** Check `worker/src/index.js`, recent OneMap upstream headers, and whether the Worker is being blocked by OneMap's Referer check.
3. **Section 2 failures** (`worker-health`) mean the Worker is unreachable or the cache path is broken. Check the Cloudflare dashboard.
4. **Section 3 failures** (`site-render`) mean the client-side wiring diverged from the Worker output. Check CSP, `fetchOneMapSchools`, and the badge CSS classes.
5. **Section 4 failures** (`usage`) mean the traffic pattern shifted meaningfully. A yesterday-vs-trailing spike alert plus an upstream-headroom warning together are the trigger criterion for reaching for Cloudflare Turnstile — see `RINGFENCE.md` for the enable-in-half-a-day runbook.

## Exact-match street pipeline (shipped 2026-07-17, commits `4173f2a` / `e911e25` / `bfb4099`)

Root cause of the 650118 field failure: the app had TWO street normalizers — `normStr` (7 abbreviations) and `canonStreet` (20 abbreviations) — plus an `includes()` partial-match fallback and a `towns[0]` silent-town-substitution fallback. For postal 650118, OneMap returned `"BUKIT BATOK WEST AVENUE 6"`, the resale dataset stores `"BT BATOK WEST AVE 6"`, `normStr` didn't handle `BT`/`AVE`, `includes()` also missed, and `towns[0]` silently rebuilt the analysis on Woodlands data.

Fix — exact translation table only, no fuzzy matching anywhere in the valuation path:

- **`canonStreet` / `abbrevStreet`** are exact inverses (source of truth: `scripts/street-normalizers.mjs`). ST-hazard fix `\bST\b(?!\.)` prevents `"ST. GEORGE'S"` from being rewritten to `"STREET. GEORGE'S"` at ingest. SAINT exception `\bSAINT\b → "ST."` in `canonStreet` only, so OneMap's `"SAINT GEORGE'S LANE"` maps to the same canonical form as HDB's `"ST. GEORGE'S LANE"`.
- **`doQuickSearch`** does one exact-match server-side query: `fetchRecs({block, street_name: abbrevStreet(canonStreet(resolvedStreet))}, 500)` for the block pool + one for the street pool. Zero results → honest empty state. No `includes()`. No `towns[0]`.
- **`qr-scope`** reflects the actual pool tier: `Block N` for tier 1-2, street name for tier 3-5, town for tier 6.
- **`#blockFactsPanel`** at the top of results always shows the exact block's in-window transactions verbatim (or `"No FLAT sales at Block N, STREET, in this N-month window."` for n=0). Facts, not aggregation.
- **`buildPropertyInfoConst`** in `update-coords.yml` sorts BOTH street keys and block keys before stringify — future PROPERTY_INFO diffs are byte-deterministic.
- **Verification gate** (`scripts/verify-street-table.mjs`) runs monthly in the workflow: asserts every PROPERTY_INFO street's `abbrevStreet` output exists in the HDB resale distinct-street list (fixture at `.github/data/hdb-resale-street-names.json`, 595 streets union across all 5 HDB resale datasets 1990-present). Report-only in the workflow log — surfaces vocabulary drift (e.g. Tengah's first resales post-MOP) at refresh time.
- **Mirror-consistency tripwire** (`scripts/tests/test-mirror-consistency.mjs`) asserts the abbreviation table is byte-identical in all three copies (`.mjs` source of truth, `index.html` inline, `update-coords.yml` inline).

Do NOT reintroduce `includes()` / `startsWith` / Levenshtein-style street matching. CLAUDE.md §6 codifies this. Vocabulary edits go into `scripts/street-normalizers.mjs` and both mirrors get updated in the same commit — the tripwire enforces it.

## Open threads

- **Phase 3 dashboarding.** The watchdog fails-loud but doesn't summarise. If drift becomes common, add a metrics push to whatever observability we have.
- **Multiple known-answer postals.** Currently the watchdog checks only 560472. If HSD boundaries drift, one postal may be a lagging indicator. Consider adding 123311 (Henry Park in 1–2 km) and 600268 (Yuhua in 1 km) as second and third canaries.
- **Demolished-block residual.** Blocks present in old resale transactions but absent from PROPERTY_INFO. Fallback deletion (Commit 1) closes the corruption vector anyway; low priority.

## Test harnesses (2026-07-30 reorganisation)

All puppeteer harnesses now live in `scripts/tests/` and are version-controlled. Previously they lived at `/tmp/hdb-test/*.mjs` and evaporated between sessions — that's how we lost `exact-match-verify`, `property-info-verify`, `absent-block-verify`, and `regression-suite-v2` between the property-info commit and the display-hardening commit.

Current suite:

- `scripts/tests/test-street-normalizers.mjs` — offline round-trip tests (65 cases, SAINT + ST-hazard + all abbrev classes).
- `scripts/tests/test-prefix-pairs.mjs` — structural: zero shared blocks across prefix-containment street pairs.
- `scripts/tests/test-mirror-consistency.mjs` — the tripwire: `.mjs` source of truth vs `index.html` inline vs `update-coords.yml` inline, byte-identical.
- `scripts/verify-street-table.mjs` — injectivity + existence gate.
- `scripts/tests/geo-cache-regression.mjs` — 11 assertions locking the 650118 field-failure fix (transient failures never persist to localStorage).
- `scripts/tests/exact-match-verify.mjs` — 12 assertions: 650118 town + Woodlands guard, qr-scope tier alignment, composed SAINT, abbrev round-trips, prefix-pair guard.
- `scripts/tests/property-info-verify.mjs` — 30 assertions: short-circuit copy + mobile 390px + badge-click recovery + field-report case.
- `scripts/tests/absent-block-verify.mjs` — 18 assertions: positive-evidence-only contract (650118 present + 400001 absent).
- `scripts/tests/regression-suite-v2.mjs` — 21-case suite covering estimation methods, banner scope, input edges, consistency, amenities, value tab wording.

- `scripts/tests/golden-cells.mjs` — golden-screenshot harness for state-grid cells A–J. Emits `/tmp/hdb-goldens/*.png` + `BASELINE.json`. Includes the mobile-truncation gate (`scrollWidth > clientWidth` at 390 px) — the automated reviewer that replaces owner eyeball on the "no numeric column clipped" invariant.
- `scripts/tests/prod-verify.mjs` — post-push self-verify against `https://tengingofyu.github.io/hdb-analyser/`. Three probes: 650118 quick vs full parity, 560472 cell A copy, 650118 mobile 390 px truncation. Runs immediately after every push; exits 2 on failure → caller auto-reverts.

All harness output (screenshots, BASELINE.json, puppeteer profile dirs) still goes to `/tmp` by convention — no repo pollution.

## Closed threads (former open items resolved)

- **Exact street matching + block-facts panel** — closed 2026-07-17 (Commit 1 `4173f2a`, Commit 2 `e911e25`, Commit 2b `bfb4099`). All work-order acceptance criteria met: exact-match pipeline shipped, PROPERTY_INFO regenerated with the corrupted Saint keys renamed, deterministic ordering, mirror-consistency tripwire, monthly gate integration in `update-coords.yml`.
- **GEO_FAIL localStorage lockout** — closed 2026-07-30. Failed geocodes now confined to sessionStorage; localStorage carries successes only under the existing 180-day TTL. `geoCacheGet` also self-evicts legacy `__FAIL__` entries so pre-fix locked-out users get unstuck on their next visit. Locked in by `scripts/tests/geo-cache-regression.mjs` (11 assertions).

## Historical incidents worth remembering

- **650118 field failure (2026-07-15)**: builder search on postal 650118 (Bukit Batok blk 118) silently pulled Woodlands comparables. Traced to `normStr` (7 abbrevs) vs `canonStreet` (20 abbrevs) mismatch + `includes()` fallback + `towns[0]` silent substitution. Fixed by the exact-match pipeline (see section above).
- **560472 → 449 m Yuhua ambiguity**: Traced to a truncated `PRIMARY_SCHOOLS` constant, not a bad calculation. Fix in commit `82ea750`.
- **Workflow #11 push race**: Long-running geocode finished after a human tail-link commit landed. Fixed with proactive rebase in `update-coords.yml`. Do not skip the check `gh run list --branch main --status in_progress` before pushing (Convention 4).
- **False parity bug for Henry Park at 123311**: Mis-attribution — user was comparing OneMap site to our static list, not to Worker output. Confirmed Worker is clean; static list omits Henry Park because straight-line ≠ HSD.
- **macOS LibreSSL curl handshake failure on fresh workers.dev subdomain**: Not a Worker bug — TLS 1.3 quirk. Node's fetch works fine.
