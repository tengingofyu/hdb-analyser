// Prod self-verify — runs immediately after push to catch prod-only failures.
// Three probes:
//   1. Real 650118 quick + full: same tier, banner copy correct, scope-emphasis
//      renders, no divergence between quick/full estimates.
//   2. Real 560472 (dense block, tier 1-2 regression): cell A copy correct,
//      no scope-emphasis (tier 1-2 stays quiet), model column hidden
//      (uniform).
//   3. Mobile 390px on 650118: no truncation in facts panel or comparables.
// On ANY failure, exits 2 → caller auto-reverts the commit.

import puppeteer from 'puppeteer-core';

const URL = 'https://tengingofyu.github.io/hdb-analyser/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const failures = [];
function fail(id, msg, extra) { failures.push({ id, msg, extra }); console.error(`✘ FAIL [${id}] ${msg}`); if(extra) console.error('   ', extra); }
function pass(id, msg) { console.log(`✓ PASS [${id}] ${msg}`); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--user-data-dir=/tmp/hdb-test/pupp-profile-prodverify'],
});

async function drive(page, { postal, flatType, floor, mb = 12, mobile = false }) {
  if (mobile) await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.type('#postal', postal);
  await page.select('#quick_flat_type', flatType);
  if (mb !== 12) await page.select('#months_back', String(mb));
  if (floor) await page.type('#quick_floor', String(floor));
  await page.click('#quickBtn');
  await page.waitForFunction(() => {
    const qr = document.getElementById('quickResult');
    const rt = document.getElementById('resolved-tag')?.textContent?.trim() || '';
    return (qr && qr.style.display !== 'none') || /has no|not found|Postal|Enter/i.test(rt);
  }, { timeout: 60000 });
}
async function driveToFull(page, opts) {
  await drive(page, opts);
  const btn = await page.$('button.btn-secondary[onclick*="goToFullAnalysis"]');
  if (btn) await btn.click();
  await page.waitForFunction(() => {
    const fr = document.getElementById('fullResults');
    return fr && fr.style.display !== 'none';
  }, { timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));
}

async function readState(page) {
  return await page.evaluate(() => {
    const banner = document.getElementById('fallbackBanner');
    const facts  = document.getElementById('blockFactsPanel');
    const est    = document.getElementById('estimationCard');
    const th     = document.getElementById('txHead');
    const heroEl = est?.querySelector('div[style*="font-size:28px"], div[style*="font-size:32px"]');
    return {
      bannerTitle: banner?.querySelector('.fb-title')?.textContent?.trim() || '',
      factsHeader: facts?.querySelector('p')?.textContent?.trim() || '',
      factsRowCount: facts?.querySelectorAll('tbody tr').length || 0,
      estMethod: est?.querySelector('p.sl')?.textContent?.trim() || '',
      hero: heroEl?.textContent?.trim() || '',
      scopeEmphasis: est?.querySelector('div[style*="var(--warn-bg)"]')?.textContent?.trim() || '',
      qrScope: document.getElementById('qr-scope')?.textContent?.trim() || '',
      qrSource: document.getElementById('qr-source')?.textContent?.trim() || '',
      qrHero: document.getElementById('qr-hero-price')?.textContent?.trim() || '',
      modelInFacts: !!(facts?.querySelector('th')?.textContent?.includes('Model')),
      modelInComparables: !!(th?.textContent?.includes('Model')),
    };
  });
}

async function truncationCheck(page) {
  return await page.evaluate(() => {
    const cells = [...document.querySelectorAll('#blockFactsPanel td, #blockFactsPanel th, #txHead th, #txBody td')];
    const bad = [];
    for (const c of cells) {
      if (c.offsetParent === null) continue;
      if (c.scrollWidth > c.clientWidth + 1) {
        bad.push({ text: c.textContent.trim().slice(0, 60), sw: c.scrollWidth, cw: c.clientWidth, over: c.scrollWidth - c.clientWidth });
      }
    }
    return bad;
  });
}

// ── (1) 650118 quick vs full ─────────────────────────────────────────────
console.log('\n== (1) 650118 · 4 ROOM · f10 · quick and full ==');
{
  const page = await browser.newPage();
  await drive(page, { postal: '650118', flatType: '4 ROOM', floor: 10 });
  const qState = await readState(page);
  console.log('   quick qr-source:', qState.qrSource);
  console.log('   quick hero     :', qState.qrHero);
  // Assert tier-3 pool with regression
  if (/Pool tier 3/.test(qState.qrSource)) pass('1.1', `quick reaches tier 3 (${qState.qrSource})`);
  else fail('1.1', 'quick did NOT reach tier 3', qState.qrSource);
  if (/^S\$\d{3},\d{3}$/.test(qState.qrHero)) pass('1.2', `quick hero looks like a real S$ figure: ${qState.qrHero}`);
  else fail('1.2', 'quick hero malformed', qState.qrHero);

  // Full analysis
  const btn = await page.$('button.btn-secondary[onclick*="goToFullAnalysis"]');
  if (btn) await btn.click();
  await page.waitForFunction(() => document.getElementById('fullResults')?.style.display !== 'none', { timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));
  const fState = await readState(page);
  console.log('   full banner    :', fState.bannerTitle.slice(0, 100));
  console.log('   full scope     :', fState.scopeEmphasis.slice(0, 100));
  console.log('   full hero      :', fState.hero);
  console.log('   facts header   :', fState.factsHeader.slice(0, 100));
  if (/Only \d+ recent sale|No recent sales/.test(fState.bannerTitle)) pass('1.3', 'full banner uses new C copy');
  else fail('1.3', 'full banner missing new C copy', fState.bannerTitle);
  if (/Based on nearby.*not Block 118 itself/.test(fState.scopeEmphasis)) pass('1.4', 'scope-emphasis line present');
  else fail('1.4', 'scope-emphasis missing', fState.scopeEmphasis);
  // Quick vs full hero should match (or full may show floor-adjusted; both same tier means close)
  if (qState.qrHero === fState.hero) pass('1.5', `quick and full hero match: ${qState.qrHero}`);
  else fail('1.5', `quick/full hero divergence: quick=${qState.qrHero} full=${fState.hero}`);
  await page.close();
}

// ── (2) 560472 · dense block cell A ─────────────────────────────────────
console.log('\n== (2) 560472 · 4 ROOM · f10 · cell A ==');
{
  const page = await browser.newPage();
  await driveToFull(page, { postal: '560472', flatType: '4 ROOM', floor: 10 });
  const s = await readState(page);
  console.log('   banner :', s.bannerTitle);
  console.log('   scope  :', s.scopeEmphasis || '(empty — expected)');
  console.log('   method :', s.estMethod);
  console.log('   hero   :', s.hero);
  console.log('   model col facts/comparables:', s.modelInFacts, '/', s.modelInComparables);
  if (/Block 472 transactions/.test(s.bannerTitle)) pass('2.1', 'cell A banner correct (tier 1-2 title)');
  else fail('2.1', 'cell A banner wrong', s.bannerTitle);
  if (s.scopeEmphasis === '') pass('2.2', 'no scope-emphasis on tier 1-2 (quiet treatment)');
  else fail('2.2', 'unexpected scope-emphasis on tier 1-2', s.scopeEmphasis);
  if (/regression|band median/.test(s.estMethod)) pass('2.3', `estimation method is not "none": ${s.estMethod}`);
  else fail('2.3', 'estimation method missing', s.estMethod);
  if (!s.modelInFacts && !s.modelInComparables) pass('2.4', 'Model column hidden (uniform models on this block)');
  else fail('2.4', 'Model column showing when uniform', `facts=${s.modelInFacts} comparables=${s.modelInComparables}`);
  await page.close();
}

// ── (3) Mobile 390px truncation ────────────────────────────────────────
console.log('\n== (3) 650118 · mobile 390px · truncation gate ==');
{
  const page = await browser.newPage();
  await driveToFull(page, { postal: '650118', flatType: '4 ROOM', floor: 10, mobile: true });
  const trunc = await truncationCheck(page);
  if (trunc.length === 0) pass('3.1', 'no truncated cells on mobile 390px');
  else fail('3.1', `${trunc.length} cell(s) truncated on mobile`, JSON.stringify(trunc));
  await page.close();
}

await browser.close();

console.log('\n══ Prod verify summary ══');
if (failures.length === 0) {
  console.log('✓ ALL PROD PROBES GREEN');
  process.exit(0);
} else {
  console.log(`✘ ${failures.length} PROD FAILURE(S)`);
  for (const f of failures) console.log(`   ${f.id}: ${f.msg}`);
  process.exit(2);
}
