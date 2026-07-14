// Weekly schools watchdog.
//
// Checks:
//   1. Worker returns the exact known answer for 560472 (shape + content, sorted).
//   2. Worker cache is warm (second call returns x-cache: HIT).
//   3. Live site renders the green "Source: OneMap School Query" badge for 560472.
//   4. Usage report from /_stats — yesterday's request + upstream counts;
//      flag loudly if yesterday's request count exceeds 3× the trailing 7-day
//      average (excluding zero-day preambles right after deploy).
//
// The watchdog sends `Origin: https://tengingofyu.github.io` on every Worker
// call — the Worker's ringfence rejects requests without a matching Origin or
// Referer with a 403. See RINGFENCE.md for the full layer stack.
//
// Fails loudly (process.exit(1)) on ANY drift and prints a machine-readable + human-readable
// diff. Reruns are OK — the check is idempotent modulo Worker cache and OneMap Timestamp.
//
// Env:
//   WORKER_URL  (defaults to prod: https://hdb-schools-parity.hdb-analyser.workers.dev)
//   SITE_URL    (defaults to prod: https://tengingofyu.github.io/hdb-analyser/)
//   CHROME_BIN  (path to Chrome/Chromium binary; from browser-actions/setup-chrome)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_URL = process.env.WORKER_URL || 'https://hdb-schools-parity.hdb-analyser.workers.dev';
const SITE_URL = process.env.SITE_URL || 'https://tengingofyu.github.io/hdb-analyser/';
const PAGES_ORIGIN = 'https://tengingofyu.github.io';
const CHROME_BIN = process.env.CHROME_BIN;

// Every Worker call from the watchdog sends this Origin so the ringfence 403
// doesn't block us. The Worker is trusting our stated Origin here (nothing
// stops a spoof), which is by design — the Origin gate filters casual traffic,
// it doesn't stand in for real auth.
const WORKER_HEADERS = { Accept: 'application/json', Origin: PAGES_ORIGIN };

const failures = [];
function fail(section, message, extra) {
  failures.push({ section, message, extra });
  console.error(`✘ FAIL [${section}] ${message}`);
  if (extra) console.error(indent(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2)));
}
function pass(section, message) { console.log(`✓ PASS [${section}] ${message}`); }
function indent(s, n = 4) { return s.split('\n').map(l => ' '.repeat(n) + l).join('\n'); }

// ── Load known answer ──────────────────────────────────────────────────────
const knownPath = path.join(__dirname, '..', '.github', 'data', 'known-schools-560472.json');
const known = JSON.parse(await fs.readFile(knownPath, 'utf8'));
const expected = known.schools
  .map(s => ({ SCHOOLNAME: s.SCHOOLNAME, DIST_CODE: s.DIST_CODE, SCH_POSTAL_CODE: s.SCH_POSTAL_CODE }))
  .sort((a, b) => a.DIST_CODE.localeCompare(b.DIST_CODE) || a.SCHOOLNAME.localeCompare(b.SCHOOLNAME));

console.log(`Watchdog target: worker=${WORKER_URL} site=${SITE_URL}`);
console.log(`Known-answer captured ${known.captured_at}, ${expected.length} schools`);

// ── 1. Worker known-answer parity ──────────────────────────────────────────
console.log('\n── 1) Worker known-answer parity (postal 560472, hbn 472) ──');
const workerUrl = `${WORKER_URL}/?postalcode=560472&hbn=472`;
let workerBody = null;
{
  const r = await fetch(workerUrl, { headers: WORKER_HEADERS }).catch(e => ({ ok: false, err: e.message }));
  if (r.err) { fail('worker-fetch', `Worker fetch threw: ${r.err}`); }
  else if (!r.ok) { fail('worker-fetch', `Worker returned HTTP ${r.status}`); }
  else {
    const text = await r.text();
    try { workerBody = JSON.parse(text); }
    catch (e) { fail('worker-fetch', 'Worker returned non-JSON body', text.slice(0, 300)); }
  }
}

if (workerBody) {
  // Shape
  if (!Array.isArray(workerBody.SearchResults)) {
    fail('worker-shape', 'Response has no SearchResults array', workerBody);
  } else {
    const badRows = workerBody.SearchResults.filter(s => !s.SCHOOLNAME || !s.DIST_CODE);
    if (badRows.length) fail('worker-shape', `${badRows.length} row(s) missing SCHOOLNAME or DIST_CODE`, badRows.slice(0, 3));
    else pass('worker-shape', `${workerBody.SearchResults.length} rows, all with SCHOOLNAME + DIST_CODE`);

    // Timestamp presence
    if (!workerBody.Timestamp) fail('worker-shape', 'Response missing Timestamp field');
    else pass('worker-shape', `Timestamp present: ${workerBody.Timestamp}`);

    // Content — sorted set-equality against known
    const actual = workerBody.SearchResults
      .map(s => ({ SCHOOLNAME: s.SCHOOLNAME, DIST_CODE: s.DIST_CODE, SCH_POSTAL_CODE: s.SCH_POSTAL_CODE }))
      .sort((a, b) => a.DIST_CODE.localeCompare(b.DIST_CODE) || a.SCHOOLNAME.localeCompare(b.SCHOOLNAME));

    if (actual.length !== expected.length) {
      fail('worker-content', `School count drift: expected ${expected.length}, got ${actual.length}`);
    }

    const expectedKeys = new Set(expected.map(s => `${s.DIST_CODE}|${s.SCHOOLNAME}`));
    const actualKeys = new Set(actual.map(s => `${s.DIST_CODE}|${s.SCHOOLNAME}`));
    const added = [...actualKeys].filter(k => !expectedKeys.has(k));
    const removed = [...expectedKeys].filter(k => !actualKeys.has(k));

    // Postal-code drift on rows that ARE in both (MOE occasionally re-issues postcodes)
    const expByKey = new Map(expected.map(s => [`${s.DIST_CODE}|${s.SCHOOLNAME}`, s.SCH_POSTAL_CODE]));
    const postalDrift = actual
      .map(s => ({ key: `${s.DIST_CODE}|${s.SCHOOLNAME}`, actualPostal: s.SCH_POSTAL_CODE, expectedPostal: expByKey.get(`${s.DIST_CODE}|${s.SCHOOLNAME}`) }))
      .filter(x => x.expectedPostal && x.actualPostal !== x.expectedPostal);

    if (added.length) fail('worker-content', `Unexpected schools in response (added)`, added);
    if (removed.length) fail('worker-content', `Expected schools missing from response (removed)`, removed);
    if (postalDrift.length) fail('worker-content', `SCH_POSTAL_CODE drift for known schools`, postalDrift);

    if (!added.length && !removed.length && !postalDrift.length) {
      pass('worker-content', `Exact match: ${actual.length} schools, all fields aligned`);
    }

    // Specific discriminators
    const has = re => actual.some(s => re.test(s.SCHOOLNAME));
    if (has(/ROSYTH/i)) pass('worker-content', 'Rosyth present (HSD-boundary discriminator)');
    else fail('worker-content', 'Rosyth SCHOOL missing — HSD boundary changed?');

    if (!has(/TOWNSVILLE/i)) pass('worker-content', 'Townsville absent (P1-intake-pause discriminator)');
    else fail('worker-content', 'Townsville present — MOE reopened intake or MOE list changed');
  }
}

// ── 2. Worker health: cache warm on repeat call ────────────────────────────
console.log('\n── 2) Worker health: cache warm on repeat call ──');
{
  const first = await fetch(workerUrl, { headers: WORKER_HEADERS }).catch(e => ({ err: e.message }));
  await new Promise(r => setTimeout(r, 500));
  const second = await fetch(workerUrl, { headers: WORKER_HEADERS }).catch(e => ({ err: e.message }));
  if (first.err || second.err) fail('worker-health', `Repeat call threw: ${first.err || second.err}`);
  else {
    const c1 = first.headers.get('x-cache'); const c2 = second.headers.get('x-cache');
    // First may be HIT or MISS depending on prior warmup; second must be HIT.
    if (c2 === 'HIT') pass('worker-health', `Second call cached (first=${c1}, second=${c2})`);
    else fail('worker-health', `Cache did not warm: first=${c1}, second=${c2}`);
    // Cache-Control has expected 24h
    const cc = first.headers.get('cache-control') || '';
    if (/max-age=86400/.test(cc)) pass('worker-health', `Cache-Control has max-age=86400`);
    else fail('worker-health', `Cache-Control unexpected: ${cc}`);
  }
}

// ── 3. Live site renders the green badge ───────────────────────────────────
console.log('\n── 3) Live site renders the green "Source: OneMap" badge ──');
if (!CHROME_BIN) {
  fail('site-render', 'CHROME_BIN env var not set — cannot render site check');
} else {
  const browser = await puppeteer.launch({
    executablePath: CHROME_BIN,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  }).catch(e => ({ err: e.message }));
  if (browser.err) { fail('site-render', `Chrome launch failed: ${browser.err}`); }
  else {
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(45000);
      await page.goto(SITE_URL, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.type('#postal', '560472');
      await page.select('#quick_flat_type', '4 ROOM');
      await page.type('#quick_floor', '10');
      await page.click('#quickBtn');
      await page.waitForFunction(() => {
        const qr = document.getElementById('quickResult');
        return qr && qr.style.display !== 'none';
      }, { timeout: 30000 });
      await page.evaluate(() => document.querySelector('button.btn-secondary[onclick*="goToFullAnalysis"]')?.click());
      await page.waitForFunction(() => {
        const fr = document.getElementById('fullResults');
        return fr && fr.style.display !== 'none';
      }, { timeout: 30000 });
      await page.evaluate(() => window.showTab && window.showTab('amenities'));
      const rendered = await page.waitForFunction(() => {
        const el = document.getElementById('schoolsSection');
        return el && (el.querySelector('.schools-source-live') || el.querySelector('.schools-source-fallback'));
      }, { timeout: 10000 }).catch(() => null);

      const state = await page.evaluate(() => {
        const el = document.getElementById('schoolsSection');
        const live = el?.querySelector('.schools-source-live');
        const fb = el?.querySelector('.schools-source-fallback');
        return {
          badge: live ? 'live' : fb ? 'fallback' : 'none',
          badgeText: (live || fb)?.textContent.trim() || '',
          names: [...(el?.querySelectorAll('.amenity-item .amenity-name') || [])].map(n => n.textContent.trim()),
        };
      });

      if (state.badge !== 'live') {
        fail('site-render', `Badge is ${state.badge}, not "live" — Worker unreachable from site or CSP blocked`, state.badgeText);
      } else {
        pass('site-render', `Green badge rendered: "${state.badgeText}"`);
      }
      const upper = state.names.map(n => n.toUpperCase());
      if (upper.some(n => n.includes('ROSYTH'))) pass('site-render', 'Rosyth visible in DOM');
      else fail('site-render', 'Rosyth not visible in rendered DOM', state.names);
      if (!upper.some(n => n.includes('TOWNSVILLE'))) pass('site-render', 'Townsville absent from DOM');
      else fail('site-render', 'Townsville rendered — client rendering diverges from Worker');
    } catch (e) {
      fail('site-render', `Browser flow threw: ${e.message}`);
    } finally {
      await browser.close();
    }
  }
}

// ── 4. Usage report + spike detection ──────────────────────────────────────
console.log('\n── 4) Usage report (yesterday vs. trailing 7-day average) ──');
{
  const statsUrl = `${WORKER_URL}/_stats`;
  const r = await fetch(statsUrl, { headers: WORKER_HEADERS }).catch(e => ({ err: e.message }));
  if (r.err) { fail('usage', `/_stats fetch threw: ${r.err}`); }
  else if (!r.ok) { fail('usage', `/_stats returned HTTP ${r.status}`); }
  else {
    const stats = await r.json();
    const days = stats.days || [];
    if (!days.length) fail('usage', '/_stats returned no days');
    else {
      // Days are today-first, descending. Report today + yesterday + last 7.
      const today = days[0];
      const yesterday = days[1];
      console.log(`  today       : requests=${today?.requests ?? '?'} upstream_misses=${today?.upstream_misses ?? '?'}`);
      console.log(`  yesterday   : requests=${yesterday?.requests ?? '?'} upstream_misses=${yesterday?.upstream_misses ?? '?'}`);

      // Trailing average over days 2..8 (indices 2..7 in 8-day window),
      // excluding zero-day preambles (a fresh deploy has all-zero counters).
      const trail = days.slice(2, 8).filter(d => d.requests > 0);
      if (trail.length < 2) {
        pass('usage', `Trailing window has <2 non-zero days (${trail.length}), spike-detection deferred until data accumulates`);
      } else {
        const trailAvg = trail.reduce((a, d) => a + d.requests, 0) / trail.length;
        const spikeThreshold = trailAvg * 3;
        const yReq = yesterday?.requests ?? 0;
        console.log(`  trail-avg   : ${trailAvg.toFixed(1)} req/day (n=${trail.length}); spike threshold = ${spikeThreshold.toFixed(1)}`);
        if (yReq > spikeThreshold && yReq > 100) {
          // 100-request floor guards against alerting on 1→10 amplification when
          // both numbers are tiny; a real spike moves into meaningful volume.
          fail('usage', `Yesterday's requests ${yReq} > 3× trailing avg ${trailAvg.toFixed(1)}`,
            `days: ${JSON.stringify(days, null, 2)}`);
        } else {
          pass('usage', `Yesterday's ${yReq} req is within 3× of trailing avg ${trailAvg.toFixed(1)}`);
        }
      }

      // Independent upstream check — if yesterday's upstream_misses is above 80%
      // of the daily cap, we're close to tripping the breaker. Not a failure per
      // se, but a heads-up warning.
      if (yesterday && yesterday.upstream_misses >= stats.daily_upstream_cap * 0.8) {
        fail('usage', `Yesterday's upstream_misses ${yesterday.upstream_misses} >= 80% of daily cap ${stats.daily_upstream_cap} — breaker close to tripping`);
      } else if (yesterday) {
        const pct = ((yesterday.upstream_misses / stats.daily_upstream_cap) * 100).toFixed(1);
        pass('usage', `Yesterday's upstream ${yesterday.upstream_misses} = ${pct}% of daily cap ${stats.daily_upstream_cap}`);
      }
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
console.log('\n══ SUMMARY ══');
if (failures.length === 0) {
  console.log(`ALL CLEAR — ${expected.length} schools verified against Worker + live site.`);
  process.exit(0);
} else {
  console.log(`${failures.length} FAILURE(S):`);
  for (const f of failures) console.log(`  [${f.section}] ${f.message}`);
  process.exit(1);
}
