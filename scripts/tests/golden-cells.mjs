// Golden harness for the state-grid cells A-J.
//
// Mix of real postals (cells A/B/D/E — hit live data.gov.sg, exercise the
// full resolve → fetch → ladder → render path) and synthetic in-page
// fixtures (cells C/F/H/I/J — deterministic, never rots as market drifts
// or new BTOs transact).
//
// Emits both text summaries and PNG screenshots to /tmp/hdb-goldens/.
// Baseline output is what the owner reviews once; smoke sweep asserts
// invariants against these fixtures on every future push.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import path from 'node:path';

const URL = process.env.URL || 'http://localhost:8765/index.html';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/tmp/hdb-goldens';
await fs.mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-web-security', '--user-data-dir=/tmp/hdb-test/pupp-profile-golden'],
});

const cells = [];  // collect summaries for the baseline emit
function record(id, meta, extra = {}) {
  cells.push({ id, ...meta, ...extra });
  console.log(`  [${id}] ${meta.title}`);
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string' && v.length > 200) console.log(`     ${k}: ${v.slice(0, 200)}…`);
    else console.log(`     ${k}: ${JSON.stringify(v)}`);
  }
}

async function newPage({ mobile = false } = {}) {
  const page = await browser.newPage();
  if (mobile) await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
  else await page.setViewport({ width: 1024, height: 900, deviceScaleFactor: 2 });
  return page;
}

async function shot(page, name) {
  const p = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: p, fullPage: true });
  return p;
}

// Automated truncation reviewer — replaces the owner's eyeball on mobile.
// For every visible TD/TH inside the facts panel or comparables table, check
// whether the CSS overflow:hidden + text-overflow:ellipsis is actually
// clipping the content. `scrollWidth > clientWidth + 1px` means content
// overflowed the cell's rendered width — visible as "…" in the DOM. Numeric
// columns MUST never do this (a truncated price is worse than a missing one).
async function truncationCheck(page) {
  return await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#blockFactsPanel td, #blockFactsPanel th, #txHead th, #txBody td')];
    const bad = [];
    for (const c of cells) {
      // Skip hidden cells (display:none via hide-mobile class at this width)
      if (c.offsetParent === null) continue;
      const cw = c.clientWidth, sw = c.scrollWidth;
      if (sw > cw + 1) {
        bad.push({
          text: c.textContent.trim().slice(0, 60),
          scrollWidth: sw,
          clientWidth: cw,
          overflowPx: sw - cw,
          scope: c.closest('#blockFactsPanel') ? 'facts' : (c.closest('#txHead') ? 'comparables-head' : 'comparables-body'),
        });
      }
    }
    return bad;
  });
}

// ── Drive a real postal end-to-end (quick → full analysis → price tab) ─────
async function driveReal(page, { postal, flatType, floor, mb = 12 }) {
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#postal', postal);
  await page.select('#quick_flat_type', flatType);
  if (mb !== 12) await page.select('#months_back', String(mb));
  if (floor) await page.type('#quick_floor', String(floor));
  await page.click('#quickBtn');
  await page.waitForFunction(() => {
    const qr = document.getElementById('quickResult');
    const rt = document.getElementById('resolved-tag')?.textContent?.trim() || '';
    return (qr && qr.style.display !== 'none') || /has no|not found|Postal|Enter/i.test(rt);
  }, { timeout: 45000 }).catch(() => {});
  // Go to full analysis
  const btn = await page.$('button.btn-secondary[onclick*="goToFullAnalysis"]');
  if (btn) await btn.click();
  await page.waitForFunction(() => {
    const fr = document.getElementById('fullResults');
    return fr && fr.style.display !== 'none';
  }, { timeout: 45000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
}

// ── Synthesise a cell by directly invoking renderPriceTab with a crafted
//    pool. Bypasses network entirely. Requires initial resolve so
//    globals (resolvedBlock, resolvedStreet, resolvedTown, quickFlatType,
//    selectedFlatType, allBlockRecs) are populated realistically. ─────────
async function driveSynth(page, { setupPostal, flatType, floor, mb = 12, synthetic }) {
  // First resolve a real postal so globals populate + amenities/value tabs work
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#postal', setupPostal);
  await page.select('#quick_flat_type', flatType);
  if (floor) await page.type('#quick_floor', String(floor));
  if (mb !== 12) await page.select('#months_back', String(mb));
  await page.click('#quickBtn');
  await page.waitForFunction(() => {
    const qr = document.getElementById('quickResult');
    return qr && qr.style.display !== 'none';
  }, { timeout: 45000 }).catch(() => {});
  // Now overwrite globals + call renderers directly with the synthetic pool
  await page.evaluate((synth, flat, mb, userFloor) => {
    // Replace allBlockRecs / allStreetRecs with fixture rows
    allBlockRecs = synth.allBlockRecs || [];
    allStreetRecs = synth.allStreetRecs || [];
    selectedFlatType = flat;
    quickFlatType = flat;
    if (synth.resolvedBlock) resolvedBlock = synth.resolvedBlock;
    if (synth.resolvedStreet) resolvedStreet = synth.resolvedStreet;
    if (synth.resolvedTown) resolvedTown = synth.resolvedTown;
    if (userFloor) document.getElementById('floor_num').value = String(userFloor);
    document.getElementById('months_back').value = String(mb);
    const band = userFloor ? getBand(userFloor) : { label: 'Mid-low (7–12)', min: 7, max: 12 };
    selectedBand = band; adjBands = getAdj(band);
    // Show the price tab
    document.getElementById('fullResults').style.display = 'block';
    showTab && showTab('price');
  }, synthetic, flatType, mb, floor);
  // Trigger the render with the crafted result. runFullFallback needs the ladder;
  // we short-circuit by calling renderPriceTab directly with the constructed pool
  // (or with null for cells H/I).
  await page.evaluate(async (synth, flat, mb) => {
    const result = synth.result === null ? null : {
      tier: synth.tier,
      records: synth.records,
      attempted: synth.attempted || [],
    };
    await renderPriceTab(result, null, flat, mb);
    if (result) renderTable(result.records, (result.records.map(r=>+r.resale_price).sort((a,b)=>a-b)[Math.floor(result.records.length/2)]));
  }, synthetic, flatType, mb);
  await new Promise(r => setTimeout(r, 300));
}

// Extract the observable state of the render for the baseline text
async function readPriceTab(page) {
  return await page.evaluate(() => {
    const banner = document.getElementById('fallbackBanner');
    const facts  = document.getElementById('blockFactsPanel');
    const est    = document.getElementById('estimationCard');
    const th     = document.getElementById('txHead');
    const tb     = document.getElementById('txBody');
    // Parse the numeric hero from the estimation card
    const heroEl = est?.querySelector('div[style*="font-size:28px"], div[style*="font-size:32px"]');
    const heroText = heroEl?.textContent.trim() || '';
    // Observed range extraction
    const obsMatch = est?.textContent.match(/Observed range: (S\$[\d,]+K?) – (S\$[\d,]+K?)/);
    // Method: regression / band / none — parse from card headline
    const methodTitle = est?.querySelector('p.sl')?.textContent.trim() || '';
    const scopeEmphEl = est?.querySelector('div[style*="var(--warn-bg)"]');
    const scopeEmphText = scopeEmphEl?.textContent.trim() || '';
    const modelHeadInComparables = /Model/.test(th?.textContent || '');
    const modelHeadInFacts = /Model/.test(facts?.querySelector('thead')?.textContent || '');
    const factsRows = facts?.querySelectorAll('tbody tr').length || 0;
    return {
      bannerTitle: banner?.querySelector('.fb-title')?.textContent.trim() || '',
      bannerBody:  banner?.querySelector('.fb-title + div')?.textContent.trim() || '',
      factsHeader: facts?.querySelector('p')?.textContent.trim() || '',
      factsRowCount: factsRows,
      estimationMethodTitle: methodTitle,
      hero: heroText,
      observedRange: obsMatch ? `${obsMatch[1]} – ${obsMatch[2]}` : '',
      scopeEmphasis: scopeEmphText,
      comparablesHead: th?.textContent.trim().replace(/\s+/g, ' ') || '',
      comparablesRowCount: tb?.querySelectorAll('tr').length || 0,
      modelColInFacts: modelHeadInFacts,
      modelColInComparables: modelHeadInComparables,
    };
  });
}

// ── Synthetic pool builders ────────────────────────────────────────────────
// Base row shape matches data.gov.sg resale-flat-prices record.
function baseRow(overrides = {}) {
  return {
    month: '2026-05', town: 'ANG MO KIO', flat_type: '4 ROOM',
    block: '472', street_name: 'ANG MO KIO AVE 10', storey_range: '07 TO 09',
    floor_area_sqm: '90', flat_model: 'Improved', lease_commence_date: '1978',
    remaining_lease: '51 years 03 months', resale_price: '500000',
    ...overrides
  };
}

// Cell B — tier 1-2 with band-median. Small block pool (3 tx, all same band):
// enough to clear the tier gate but fails regression's n>=5.
const cellBFixture = {
  resolvedBlock: '472', resolvedStreet: 'ANG MO KIO AVENUE 10', resolvedTown: 'ANG MO KIO',
  allBlockRecs: [
    baseRow({ month:'2026-06', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'530000' }),
    baseRow({ month:'2026-04', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'545000' }),
    baseRow({ month:'2026-02', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'520000' }),
  ],
  allStreetRecs: [],
  tier: 2,
  records: null,
  attempted: [{ id: 2, used: true, count: 3, label: '' }],
};
cellBFixture.records = cellBFixture.allBlockRecs;

// Cell D — tier 3-5 with regression. Street pool 8 tx across 3 bands + floor.
const cellDFixture = {
  resolvedBlock: '999', resolvedStreet: 'ANG MO KIO AVENUE 10', resolvedTown: 'ANG MO KIO',
  allBlockRecs: [],
  allStreetRecs: [
    baseRow({ block:'470', month:'2026-06', storey_range:'01 TO 03', floor_area_sqm:'92', resale_price:'480000' }),
    baseRow({ block:'471', month:'2026-05', storey_range:'01 TO 03', floor_area_sqm:'92', resale_price:'490000' }),
    baseRow({ block:'473', month:'2026-05', storey_range:'04 TO 06', floor_area_sqm:'92', resale_price:'510000' }),
    baseRow({ block:'474', month:'2026-04', storey_range:'04 TO 06', floor_area_sqm:'92', resale_price:'515000' }),
    baseRow({ block:'475', month:'2026-04', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'535000' }),
    baseRow({ block:'476', month:'2026-03', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'540000' }),
    baseRow({ block:'477', month:'2026-03', storey_range:'10 TO 12', floor_area_sqm:'92', resale_price:'560000' }),
    baseRow({ block:'478', month:'2026-02', storey_range:'10 TO 12', floor_area_sqm:'92', resale_price:'565000' }),
  ],
  tier: 3,
  records: null,
  attempted: [{ id: 3, used: true, count: 8, label: '' }],
};
cellDFixture.records = cellDFixture.allStreetRecs;

// Cell E — tier 3-5 with band-median. Street pool 4 tx same band + floor.
const cellEFixture = {
  resolvedBlock: '999', resolvedStreet: 'ANG MO KIO AVENUE 10', resolvedTown: 'ANG MO KIO',
  allBlockRecs: [],
  allStreetRecs: [
    baseRow({ block:'470', month:'2026-06', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'520000' }),
    baseRow({ block:'471', month:'2026-04', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'535000' }),
    baseRow({ block:'473', month:'2026-03', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'528000' }),
    baseRow({ block:'474', month:'2026-02', storey_range:'07 TO 09', floor_area_sqm:'92', resale_price:'540000' }),
  ],
  tier: 3,
  records: null,
  attempted: [{ id: 3, used: true, count: 4, label: '' }],
};
cellEFixture.records = cellEFixture.allStreetRecs;

// Cell C₁₋₂ — block has 1-2 recent sales, ladder moves to street pool (5+ tx).
// Prices are anchored to the ACTUAL 2026 range observed at BB West Ave 6 via
// live probe (median ~S$647K, range S$511K–S$782K) so a reviewer comparing to
// the real prod render doesn't chase a phantom divergence. Updated 2026-07-30.
const cellCFixture = {
  resolvedBlock: '118', resolvedStreet: 'BUKIT BATOK WEST AVENUE 6', resolvedTown: 'BUKIT BATOK',
  allBlockRecs: [baseRow({ block:'118', street_name:'BT BATOK WEST AVE 6', town:'BUKIT BATOK',
                            month:'2026-04', storey_range:'07 TO 09', resale_price:'628000' })],
  allStreetRecs: [
    baseRow({ block:'110', street_name:'BT BATOK WEST AVE 6', town:'BUKIT BATOK', month:'2026-06', storey_range:'10 TO 12', resale_price:'655000' }),
    baseRow({ block:'112', street_name:'BT BATOK WEST AVE 6', town:'BUKIT BATOK', month:'2026-05', storey_range:'04 TO 06', resale_price:'605000' }),
    baseRow({ block:'118', street_name:'BT BATOK WEST AVE 6', town:'BUKIT BATOK', month:'2026-04', storey_range:'07 TO 09', resale_price:'628000' }),
    baseRow({ block:'115', street_name:'BT BATOK WEST AVE 6', town:'BUKIT BATOK', month:'2026-03', storey_range:'13 TO 15', resale_price:'688000' }),
    baseRow({ block:'116', street_name:'BT BATOK WEST AVE 6', town:'BUKIT BATOK', month:'2026-02', storey_range:'07 TO 09', resale_price:'640000' }),
  ],
  tier: 3,
  records: [
    baseRow({ block:'110', month:'2026-06', storey_range:'10 TO 12', resale_price:'655000' }),
    baseRow({ block:'112', month:'2026-05', storey_range:'04 TO 06', resale_price:'605000' }),
    baseRow({ block:'118', month:'2026-04', storey_range:'07 TO 09', resale_price:'628000' }),
    baseRow({ block:'115', month:'2026-03', storey_range:'13 TO 15', resale_price:'688000' }),
    baseRow({ block:'116', month:'2026-02', storey_range:'07 TO 09', resale_price:'640000' }),
  ],
  attempted: [{ id: 3, used: true, count: 5, label: '' }],
};

// Cell C₀ — block has 0 recent sales, ladder moves to street (same as above but empty allBlockRecs for flat_type)
const cellC0Fixture = { ...cellCFixture, allBlockRecs: [] };

// Cell F — tier 3-5 with method=none (pool 3-4 tx spread across bands, no target band)
const cellFFixture = {
  resolvedBlock: '999', resolvedStreet: 'TEST STREET', resolvedTown: 'TESTVILLE',
  allBlockRecs: [],
  allStreetRecs: [],
  tier: 4,
  records: [
    baseRow({ month:'2026-06', storey_range:'01 TO 03', resale_price:'400000', floor_area_sqm:'85' }),
    baseRow({ month:'2026-04', storey_range:'19 TO 21', resale_price:'620000', floor_area_sqm:'92' }),
    baseRow({ month:'2026-02', storey_range:'25 TO 27', resale_price:'700000', floor_area_sqm:'95' }),
  ],
  attempted: [{ id: 4, used: true, count: 3, label: '' }],
};

// Cell I — whole ladder failed, result === null (e.g. new estate with zero sales)
// Synthesised because a real Tengah postal is time-sensitive: first resales start
// landing ~2027-28 post-MOP, so any specific postal we pin would silently stop
// being a valid cell-I fixture the day it transacts.
const cellIFixture = {
  resolvedBlock: '801', resolvedStreet: 'TENGAH DRIVE', resolvedTown: 'TENGAH',
  allBlockRecs: [],
  allStreetRecs: [],
  result: null,
};

// Cell J (Model column) — 5-row pool with 4× "Model A" + 1× "Premium Apartment Loft"
// The loft row has a visibly-different price for identical floor area (Dawson-loft
// pattern), and the Model column self-explains the gap.
const cellJFixture = {
  resolvedBlock: '141', resolvedStreet: 'STRATHMORE AVENUE', resolvedTown: 'QUEENSTOWN',
  allBlockRecs: [
    baseRow({ month:'2026-06', block:'141', street_name:'STRATHMORE AVE', town:'QUEENSTOWN', flat_type:'5 ROOM',
              flat_model:'Model A', floor_area_sqm:'112', storey_range:'19 TO 21', resale_price:'1180000' }),
    baseRow({ month:'2026-05', block:'141', street_name:'STRATHMORE AVE', town:'QUEENSTOWN', flat_type:'5 ROOM',
              flat_model:'Model A', floor_area_sqm:'112', storey_range:'22 TO 24', resale_price:'1220000' }),
    baseRow({ month:'2026-04', block:'141', street_name:'STRATHMORE AVE', town:'QUEENSTOWN', flat_type:'5 ROOM',
              flat_model:'Model A', floor_area_sqm:'112', storey_range:'25 TO 27', resale_price:'1260000' }),
    baseRow({ month:'2026-03', block:'141', street_name:'STRATHMORE AVE', town:'QUEENSTOWN', flat_type:'5 ROOM',
              flat_model:'Model A', floor_area_sqm:'112', storey_range:'28 TO 30', resale_price:'1310000' }),
    baseRow({ month:'2026-02', block:'141', street_name:'STRATHMORE AVE', town:'QUEENSTOWN', flat_type:'5 ROOM',
              flat_model:'Premium Apartment Loft', floor_area_sqm:'110', storey_range:'40 TO 42', resale_price:'1720000' }),
  ],
  allStreetRecs: [],
  tier: 1,
  records: null,  // will be populated from allBlockRecs below
  attempted: [{ id: 1, used: true, count: 5, label: '' }],
};
cellJFixture.records = cellJFixture.allBlockRecs;

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Golden-cells baseline emit ===\n');

// ── Cell A: real postal, dense block, regression fires ─────────────────────
console.log('\n── Cell A (tier 1-2, regression) — 560472 · 4 ROOM · floor 10 · 12mo ──');
{
  const page = await newPage();
  await driveReal(page, { postal:'560472', flatType:'4 ROOM', floor:10, mb:12 });
  const s = await readPriceTab(page);
  const p = await shot(page, 'A-tier1-regression');
  record('A', { title: 'tier 1-2 · regression · 560472 4 ROOM f10' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell B: synthetic — tier 1-2 band-median (3 tx, floor entered) ────────
console.log('\n── Cell B (tier 1-2, band-median) — SYNTHETIC 3 tx same band + floor ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'560472', flatType:'4 ROOM', floor:8, mb:12, synthetic: cellBFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'B-tier1-band');
  record('B', { title: 'tier 1-2 · band-median · synthetic 3 tx same band' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell C₁₋₂: synthetic — block has 1 sale, tier moves to street ─────────
console.log('\n── Cell C₁₋₂ (tier 3-5, block has 1-2 recent sales) — SYNTHETIC ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'650118', flatType:'4 ROOM', floor:10, mb:12, synthetic: cellCFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'C1_2-tier3-block-has-some');
  record('C₁₋₂', { title: 'tier 3-5 · block n=1 · synthetic BB West Ave 6' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell C₀: synthetic — block has 0 sales, tier moves to street ──────────
console.log('\n── Cell C₀ (tier 3-5, block n=0 recent sales) — SYNTHETIC ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'650118', flatType:'4 ROOM', floor:10, mb:12, synthetic: cellC0Fixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'C0-tier3-block-empty');
  record('C₀', { title: 'tier 3-5 · block n=0 · synthetic BB West Ave 6' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell D: synthetic — tier 3-5 regression (8 tx across 3 bands + floor) ──
console.log('\n── Cell D (tier 3-5, regression) — SYNTHETIC 8 tx across 3 bands ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'560472', flatType:'4 ROOM', floor:8, mb:12, synthetic: cellDFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'D-tier3-regression');
  record('D', { title: 'tier 3-5 · regression · synthetic 8 tx' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell E: synthetic — tier 3-5 band-median (4 tx same band + floor) ──────
console.log('\n── Cell E (tier 3-5, band-median) — SYNTHETIC 4 tx same band ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'560472', flatType:'4 ROOM', floor:8, mb:12, synthetic: cellEFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'E-tier3-band');
  record('E', { title: 'tier 3-5 · band-median · synthetic 4 tx same band' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell F: synthetic tier 3-5 with method=none ─────────────────────────────
console.log('\n── Cell F (tier 3-5, method=none) — SYNTHETIC (3 tx spread across bands) ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'560472', flatType:'4 ROOM', floor:10, mb:12, synthetic: cellFFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'F-tier3-none');
  record('F', { title: 'tier 3-5 · none · synthetic 3 tx spread' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell I: synthetic — whole ladder failed ─────────────────────────────────
console.log('\n── Cell I (whole ladder failed, empty state) — SYNTHETIC (Tengah proxy) ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'560472', flatType:'4 ROOM', mb:12, synthetic: cellIFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'I-empty-state');
  record('I (12mo)', { title: 'result=null · 12mo copy' }, {...s, screenshot: p});
  await page.close();
}
console.log('\n── Cell I (empty state at 36mo) — SYNTHETIC ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'560472', flatType:'4 ROOM', mb:36, synthetic: cellIFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'I-empty-state-36mo');
  record('I (36mo)', { title: 'result=null · 36mo copy with "check back" suffix' }, {...s, screenshot: p});
  await page.close();
}

// ── Cell J: synthetic mixed-model pool ──────────────────────────────────────
console.log('\n── Cell J (Model column) — SYNTHETIC 4× Model A + 1× Loft ──');
{
  const page = await newPage();
  await driveSynth(page, { setupPostal:'123311', flatType:'5 ROOM', floor:20, mb:12, synthetic: cellJFixture });
  const s = await readPriceTab(page);
  const p = await shot(page, 'J-model-column');
  record('J', { title: 'Model column visible when mixed' }, {...s, screenshot: p});
  await page.close();
}

// ── Mobile 390px pass on multiple cells + truncation assertion (the gate) ──
const mobileFixtures = [
  { id: 'A · mobile 390px', title: 'cell A rendered at 390px', kind: 'real',
    opts: { postal:'560472', flatType:'4 ROOM', floor:10, mb:12 }, out: 'A-mobile-390px' },
  { id: 'C₁₋₂ · mobile 390px', title: 'cell C rendered at 390px', kind: 'synth',
    opts: { setupPostal:'650118', flatType:'4 ROOM', floor:10, mb:12, synthetic: cellCFixture }, out: 'C1_2-mobile-390px' },
  { id: 'D · mobile 390px', title: 'cell D rendered at 390px', kind: 'synth',
    opts: { setupPostal:'560472', flatType:'4 ROOM', floor:8, mb:12, synthetic: cellDFixture }, out: 'D-mobile-390px' },
  { id: 'F · mobile 390px', title: 'cell F rendered at 390px', kind: 'synth',
    opts: { setupPostal:'560472', flatType:'4 ROOM', floor:10, mb:12, synthetic: cellFFixture }, out: 'F-mobile-390px' },
  { id: 'I · mobile 390px', title: 'cell I rendered at 390px', kind: 'synth',
    opts: { setupPostal:'560472', flatType:'4 ROOM', mb:36, synthetic: cellIFixture }, out: 'I-mobile-390px' },
  { id: 'J · mobile 390px', title: 'cell J rendered at 390px (Model col hidden on mobile; outlier note carries the info)', kind: 'synth',
    opts: { setupPostal:'123311', flatType:'5 ROOM', floor:20, mb:12, synthetic: cellJFixture }, out: 'J-mobile-390px' },
];
let truncationFailures = [];
for (const mf of mobileFixtures) {
  console.log(`\n── Mobile 390px: ${mf.id} ──`);
  const page = await newPage({ mobile: true });
  if (mf.kind === 'real') await driveReal(page, mf.opts);
  else await driveSynth(page, mf.opts);
  const s = await readPriceTab(page);
  const p = await shot(page, mf.out);
  const trunc = await truncationCheck(page);
  record(mf.id, { title: mf.title }, {...s, screenshot: p, truncationBad: trunc});
  if (trunc.length) truncationFailures.push({ cell: mf.id, bad: trunc });
  await page.close();
}

await browser.close();

// Emit the baseline text file
const summary = {
  generated_at: new Date().toISOString(),
  url: URL,
  cells,
  truncationFailures,
};
await fs.writeFile(path.join(OUT, 'BASELINE.json'), JSON.stringify(summary, null, 2));
console.log(`\n=== ${cells.length} cells captured → ${OUT}/ ===`);
console.log(`Screenshots: ${cells.length} PNG files`);
console.log(`Baseline JSON: ${OUT}/BASELINE.json`);

// The gate — replaces owner's eyeball. Red exit blocks any push.
if (truncationFailures.length) {
  console.log(`\n✘ TRUNCATION GATE FAILED — ${truncationFailures.length} cell(s) have clipped content at 390px:`);
  for (const tf of truncationFailures) {
    console.log(`  ${tf.cell}:`);
    for (const b of tf.bad) console.log(`    ${b.scope} · "${b.text}" · scroll=${b.scrollWidth} client=${b.clientWidth} overflow=${b.overflowPx}px`);
  }
  process.exit(2);
}
console.log('\n✓ TRUNCATION GATE PASSED — no numeric column clipped at 390px');
