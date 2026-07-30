// exact-match-verify.mjs — the 650118-field-failure regression harness.
// Reconstructed 2026-07-30 into scripts/tests/ (previously lived at
// /tmp/hdb-test/ and evaporated between sessions).
//
// Covers:
//   1. 650118 end-to-end: town resolves to BUKIT BATOK, no Woodlands blocks
//      contaminate either pool.
//   2. qr-scope label matches the actual pool tier (block for tier 1-2,
//      street for tier 3-5, town for tier 6).
//   3. Composed SAINT assertion: abbrevStreet(canonStreet("SAINT GEORGE'S
//      ROAD")) === "ST. GEORGE'S RD".
//   4. Round-trip on the abbreviation classes named in CLAUDE.md §6.
//   5. Prefix-pair guard: AMK Ave 1 never returns Ave 10 rows.

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
  args: ['--no-sandbox', '--disable-web-security', '--user-data-dir=/tmp/hdb-test/pupp-profile-exact'],
});

async function driveQuick(page, { postal, flatType = '4 ROOM', floor = 10 }) {
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#postal', postal);
  await page.select('#quick_flat_type', flatType);
  await page.type('#quick_floor', String(floor));
  await page.click('#quickBtn');
  await page.waitForFunction(() => {
    const qr = document.getElementById('quickResult');
    const rt = document.getElementById('resolved-tag')?.textContent?.trim() || '';
    return (qr && qr.style.display !== 'none') || /has no|not found|Postal|Enter/i.test(rt);
  }, { timeout: 30000 }).catch(() => {});
}

// ── (1) 650118 exact-match: town = BUKIT BATOK, no Woodlands blocks ────────
console.log('\n=== 1) 650118 · 4 ROOM — town must be BUKIT BATOK, no Woodlands ===');
{
  const page = await browser.newPage();
  await driveQuick(page, { postal: '650118', flatType: '4 ROOM', floor: 10 });
  const s = await page.evaluate(() => ({
    resolvedTown: typeof resolvedTown !== 'undefined' ? resolvedTown : '?',
    resolvedStreet: typeof resolvedStreet !== 'undefined' ? resolvedStreet : '?',
    allBlockStreets: [...new Set((allBlockRecs||[]).map(r=>r.street_name))],
    allStreetStreets: [...new Set((allStreetRecs||[]).map(r=>r.street_name))],
    allBlockBlocks: [...new Set((allBlockRecs||[]).map(r=>r.block))],
    allStreetBlocks: [...new Set((allStreetRecs||[]).map(r=>r.block))],
  }));
  const woodlandsBlocks = ['780C','782D','782B','570A'];
  const woodlandsHit = [...s.allBlockBlocks, ...s.allStreetBlocks].some(b => woodlandsBlocks.includes(b));
  record('1.1 town resolves to BUKIT BATOK', s.resolvedTown === 'BUKIT BATOK', `town=${s.resolvedTown}`);
  record('1.2 allBlockRecs street = BT BATOK WEST AVE 6 (single street)',
    s.allBlockStreets.length === 1 && s.allBlockStreets[0] === 'BT BATOK WEST AVE 6',
    s.allBlockStreets.join('|'));
  record('1.3 allStreetRecs street = BT BATOK WEST AVE 6 (single street)',
    s.allStreetStreets.length === 1 && s.allStreetStreets[0] === 'BT BATOK WEST AVE 6',
    s.allStreetStreets.join('|'));
  record('1.4 no Woodlands blocks (780C/782D/782B/570A) in either pool',
    !woodlandsHit, `blocks=${[...s.allBlockBlocks].join(',')}|${[...s.allStreetBlocks].join(',')}`);
  await page.close();
}

// ── (2) qr-scope reflects tier ────────────────────────────────────────────
console.log('\n=== 2) qr-scope label matches pool tier ===');
{
  const page = await browser.newPage();
  await driveQuick(page, { postal: '560472', flatType: '4 ROOM', floor: 10 });
  const s = await page.evaluate(() => ({
    scope: document.getElementById('qr-scope')?.textContent || '',
    source: document.getElementById('qr-source')?.textContent || '',
  }));
  console.log('  scope:', s.scope, ' source:', s.source);
  const tier = +((s.source.match(/Pool tier (\d)/) || [])[1] || 0);
  record('2.1 tier 1/2 scope contains "Block N"', /Block \S+/i.test(s.scope), `tier=${tier} scope="${s.scope}"`);
  record('2.2 tier-1-source label present', /Pool tier [12]/.test(s.source), s.source);
  await page.close();
}
{
  const page = await browser.newPage();
  // Sparse block → likely tier ≥ 3
  await driveQuick(page, { postal: '650118', flatType: '4 ROOM', floor: 10 });
  const s = await page.evaluate(() => ({
    scope: document.getElementById('qr-scope')?.textContent || '',
    source: document.getElementById('qr-source')?.textContent || '',
  }));
  const tier = +((s.source.match(/Pool tier (\d)/) || [])[1] || 0);
  const okStreet = (tier >= 3 && !/Block \S+/i.test(s.scope) && /AVENUE|STREET|ROAD|CENTRAL/i.test(s.scope));
  const okBlock  = (tier <= 2 && /Block/i.test(s.scope));
  record('2.3 tier-appropriate scope (block vs street)', okStreet || okBlock, `tier=${tier} scope="${s.scope}"`);
  await page.close();
}

// ── (3) Composed SAINT assertion ─────────────────────────────────────────
console.log('\n=== 3) Composed SAINT assertion at runtime ===');
{
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const s = await page.evaluate(() => ({
    canonSaint: canonStreet("SAINT GEORGE'S ROAD"),
    composed: abbrevStreet(canonStreet("SAINT GEORGE'S ROAD")),
    canonHDB: canonStreet("ST. GEORGE'S RD"),
  }));
  record('3.1 canonStreet("SAINT GEORGE\'S ROAD") = "ST. GEORGE\'S ROAD"',
    s.canonSaint === "ST. GEORGE'S ROAD", s.canonSaint);
  record('3.2 abbrevStreet(canonStreet("SAINT GEORGE\'S ROAD")) === "ST. GEORGE\'S RD"',
    s.composed === "ST. GEORGE'S RD", s.composed);
  record('3.3 HDB round-trip: canonStreet("ST. GEORGE\'S RD") = "ST. GEORGE\'S ROAD"',
    s.canonHDB === "ST. GEORGE'S ROAD", s.canonHDB);
  await page.close();
}

// ── (4) Abbreviation-class round-trips at runtime ──────────────────────
console.log('\n=== 4) Abbreviation classes — round-trips at runtime ===');
{
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  const cases = [
    ['BT BATOK WEST AVE 6',      'BUKIT BATOK WEST AVENUE 6'],       // BT + AVE
    ['JLN TENTERAM',             'JALAN TENTERAM'],                  // JLN
    ['LOR AH SOO',               'LORONG AH SOO'],                   // LOR
    ['BEDOK NTH ST 2',           'BEDOK NORTH STREET 2'],            // NTH + ST
    ['UPP CROSS ST',             'UPPER CROSS STREET'],              // UPP
    ["C'WEALTH AVE",             'COMMONWEALTH AVENUE'],             // C'WEALTH
    ['KG BAHRU RD',              'KAMPONG BAHRU ROAD'],              // KG
    ['TG PAGAR PLAZA',           'TANJONG PAGAR PLAZA'],             // TG
    ['BT BATOK CTRL',            'BUKIT BATOK CENTRAL'],             // CTRL
    ['TAMAN HO SWEE PK',         'TAMAN HO SWEE PARK'],              // PK
    ['MARSILING MKT',            'MARSILING MARKET'],                // MKT
    ['SIMEI TER',                'SIMEI TERRACE'],                   // TER
    ["ST. GEORGE'S RD",          "ST. GEORGE'S ROAD"],               // ST-hazard
  ];
  let ok = true;
  for (const [hdb, canon] of cases) {
    const canonOut = await page.evaluate(x => canonStreet(x), hdb);
    const abbrevOut = await page.evaluate(x => abbrevStreet(x), canon);
    const roundOut = await page.evaluate(x => abbrevStreet(canonStreet(x)), hdb);
    if (!(canonOut === canon && abbrevOut === hdb && roundOut === hdb)) ok = false;
  }
  record('4.1 abbreviation class round-trips (13 fixtures)', ok, `${cases.length} cases`);
  await page.close();
}

// ── (5) Prefix-pair guard: AMK Ave 1 never returns Ave 10 rows ──────────
console.log('\n=== 5) Prefix-pair guard ===');
{
  const page = await browser.newPage();
  await driveQuick(page, { postal: '560172', flatType: '4 ROOM', floor: 10 });
  const s = await page.evaluate(() => ({
    resolvedStreet: typeof resolvedStreet !== 'undefined' ? resolvedStreet : '?',
    allBlockStreets: [...new Set((allBlockRecs||[]).map(r=>r.street_name))],
    allStreetStreets: [...new Set((allStreetRecs||[]).map(r=>r.street_name))],
  }));
  const contaminated = [...s.allBlockStreets, ...s.allStreetStreets]
    .some(x => /ANG MO KIO AVE 1[0-9]/i.test(x));
  record('5.1 AMK Ave 1/4 pool never contains Ave 10-19', !contaminated, `streets=${[...s.allBlockStreets, ...s.allStreetStreets].join(',')}`);
  await page.close();
}

await browser.close();

console.log('\n═══ Summary ═══');
const failed = results.filter(r => !r.pass);
console.log(`${results.length - failed.length}/${results.length} pass`);
if (failed.length) for (const f of failed) console.log(`  FAIL: ${f.id} — ${f.evidence}`);
process.exit(failed.length === 0 ? 0 : 2);
