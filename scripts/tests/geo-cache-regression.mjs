// geo-cache-regression.mjs — locks the fix for the 650118 field bug.
//
// The bug: failed OneMap lookups used to persist to localStorage under a
// 180-day TTL, so a single transient network blip could lock a postal out
// on the user's device for six months. The fix (2026-07-30) confines
// failure caching to sessionStorage only. This test asserts that specific
// regression can't return:
//   (a) A failed geocode NEVER writes a geo_<key> entry to localStorage.
//   (b) The session-only sentinel is present in sessionStorage.
//   (c) A subsequent lookup after failure does a FRESH network fetch
//       (proves localStorage isn't silently holding a stale bad answer).
//   (d) Legacy GEO_FAIL entries in localStorage (from the pre-fix code)
//       auto-evict on next access — old locked-out users get unstuck.
//   (e) Successful lookups still cache to localStorage under the 180-day
//       TTL (the wanted behaviour we didn't want to break).

import puppeteer from 'puppeteer-core';

const URL = process.env.URL || 'http://localhost:8765/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const results = [];
function record(id, pass, evidence) {
  results.push({ id, pass, evidence });
  console.log(`  ${id} ${pass ? 'PASS' : 'FAIL'} — ${evidence}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--user-data-dir=/tmp/hdb-test/pupp-profile-geocache'],
});

// ── (a) & (b): transient failure never touches localStorage ────────────
console.log('\n=== (a)+(b) transient failure → sessionStorage only ===');
{
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.includes('onemap.gov.sg/api/common/elastic/search')) {
      req.respond({ status: 500, contentType: 'application/json', body: '{"error":"synthetic failure"}' });
    } else req.continue();
  });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const result = await page.evaluate(async () => {
    const r = await geocodeOM('999123-trantest');
    return {
      result: r,
      lsKeys: Object.keys(localStorage).filter(k => k.startsWith('geo_')),
      ssKeys: Object.keys(sessionStorage).filter(k => k.startsWith('om_')),
    };
  });
  console.log('  geocode result:', result.result);
  console.log('  localStorage geo_ keys:', result.lsKeys);
  console.log('  sessionStorage om_ keys:', result.ssKeys);
  record('a.1 result is null on transient failure', result.result === null, `got ${result.result}`);
  record('a.2 NO geo_ key written to localStorage', result.lsKeys.length === 0, `keys=${JSON.stringify(result.lsKeys)}`);
  record('b.1 sessionStorage om_ key present with GEO_FAIL', result.ssKeys.length === 1, `keys=${JSON.stringify(result.ssKeys)}`);
  if (result.ssKeys.length === 1) {
    const val = await page.evaluate((k) => sessionStorage.getItem(k), result.ssKeys[0]);
    record('b.2 sessionStorage value is GEO_FAIL sentinel', /__FAIL__/.test(val), `value=${val}`);
  }
  await page.close();
}

// ── (c): subsequent lookup retries fresh ─────────────────────────────
console.log('\n=== (c) subsequent lookup after failure does fresh fetch ===');
{
  const page = await browser.newPage();
  let onemapCalls = 0;
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = req.url();
    if (u.includes('onemap.gov.sg/api/common/elastic/search')) {
      onemapCalls++;
      req.respond({ status: 500, contentType: 'application/json', body: '{}' });
    } else req.continue();
  });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(async () => { await geocodeOM('123321-retrytest'); });
  const callsAfterFirst = onemapCalls;
  await page.evaluate(() => sessionStorage.clear());
  await page.evaluate(async () => { await geocodeOM('123321-retrytest'); });
  const callsAfterSecond = onemapCalls;
  console.log('  onemap calls after 1st lookup:', callsAfterFirst);
  console.log('  onemap calls after 2nd lookup (post session-clear):', callsAfterSecond);
  record('c.1 first call hits OneMap', callsAfterFirst >= 1, `calls=${callsAfterFirst}`);
  record('c.2 second call ALSO hits OneMap (no stale localStorage block)', callsAfterSecond > callsAfterFirst, `+${callsAfterSecond-callsAfterFirst} calls`);
  await page.close();
}

// ── (d): legacy GEO_FAIL entries auto-evict on next access ─────────────
// Plants a __FAIL__ entry with the EXACT cacheKey format geoCacheGet reads.
// Then calls geoCacheGet directly and asserts the entry is (i) returned as
// undefined and (ii) removed from localStorage. Old locked-out users get
// unstuck on their next visit.
console.log('\n=== (d) legacy GEO_FAIL localStorage entries self-evict ===');
{
  const page = await browser.newPage();
  // Block outbound OneMap — this test asserts EVICTION only, not fetch.
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().includes('onemap.gov.sg/api/common/elastic/search')) req.abort('failed');
    else req.continue();
  });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const query = '888888';
  const lsKey = 'geo_' + query;  // digits-only → cleanStr + \W+ replace is identity
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ v: '__FAIL__', t: Date.now() })), lsKey);
  const before = await page.evaluate((k) => localStorage.getItem(k), lsKey);
  console.log('  BEFORE localStorage[' + lsKey + ']:', before);
  const getResult = await page.evaluate((q) => geoCacheGet(q), query);
  const after = await page.evaluate((k) => localStorage.getItem(k), lsKey);
  console.log('  geoCacheGet returned :', getResult);
  console.log('  AFTER  localStorage[' + lsKey + ']:', after);
  record('d.1 geoCacheGet returns undefined on stale __FAIL__', getResult === undefined, `got ${JSON.stringify(getResult)}`);
  record('d.2 stale __FAIL__ entry removed from localStorage', after === null, `still there: ${after}`);
  await page.close();
}

// ── (e): geoCacheSetSuccess persists real results, refuses null/GEO_FAIL ──
console.log('\n=== (e) geoCacheSetSuccess: writes real results, refuses null/GEO_FAIL ===');
{
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const query = '560472';
  const lsKey = 'geo_' + query;
  const syntheticResult = { BLK_NO: '472', ROAD_NAME: 'ANG MO KIO AVENUE 10', POSTAL: '560472', LATITUDE: '1.363', LONGITUDE: '103.85' };
  await page.evaluate((k) => localStorage.removeItem(k), lsKey);
  await page.evaluate((q, v) => geoCacheSetSuccess(q, v), query, syntheticResult);
  const cached = await page.evaluate((q) => geoCacheGet(q), query);
  console.log('  after geoCacheSetSuccess: cached =', cached ? `BLK ${cached.BLK_NO} ${cached.ROAD_NAME}` : 'null');
  record('e.1 successful result persists via geoCacheSetSuccess',
    cached && cached.BLK_NO === '472', JSON.stringify(cached).slice(0, 80));
  // Guardrail: refuse null
  await page.evaluate((k) => localStorage.removeItem(k), lsKey);
  await page.evaluate((q) => geoCacheSetSuccess(q, null), query);
  const afterNull = await page.evaluate((k) => localStorage.getItem(k), lsKey);
  record('e.2 geoCacheSetSuccess REFUSES null (guardrail)', afterNull === null, `wrote ${afterNull}`);
  // Guardrail: refuse the GEO_FAIL sentinel
  await page.evaluate((q) => geoCacheSetSuccess(q, '__FAIL__'), query);
  const afterFail = await page.evaluate((k) => localStorage.getItem(k), lsKey);
  record('e.3 geoCacheSetSuccess REFUSES GEO_FAIL sentinel (guardrail)', afterFail === null, `wrote ${afterFail}`);
  await page.close();
}

await browser.close();

console.log('\n═══ Summary ═══');
const failed = results.filter(r => !r.pass);
console.log(`${results.length - failed.length}/${results.length} pass`);
if (failed.length) for (const f of failed) console.log(`  FAIL: ${f.id} — ${f.evidence}`);
process.exit(failed.length === 0 ? 0 : 2);
