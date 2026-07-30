// absent-block-verify.mjs — positive-evidence-only short-circuit contract.
// Reconstructed 2026-07-30 into scripts/tests/.
//
// Two cases:
//   (A) 650118 — block present in PROPERTY_INFO with {4:88}. Short-circuit
//       must fire for EVERY flat type NOT in that mix, and NOT fire for 4 ROOM.
//   (B) 400001 — Eunos Cres blk 1, rental-only, absent from PROPERTY_INFO
//       (buildPropertyInfo drops rental-only rows). resolvedBlockMix must
//       be null and no short-circuit fires for ANY flat type. This is the
//       invariant CLAUDE.md §6 formalises.

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
  args: ['--no-sandbox', '--disable-web-security', '--user-data-dir=/tmp/hdb-test/pupp-profile-absent'],
});

async function probe(postal, flatType) {
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#postal', postal);
  await page.select('#quick_flat_type', flatType);
  await page.type('#quick_floor', '10');
  await page.click('#quickBtn');
  await page.waitForFunction(() => {
    const rt = document.getElementById('resolved-tag')?.textContent?.trim() || '';
    const qr = document.getElementById('quickResult');
    const heroEl = document.getElementById('qr-hero-price');
    const heroSet = heroEl && heroEl.textContent.trim().length >= 1;
    if (/has no|not found|Enter/i.test(rt)) return true;
    if (qr && qr.style.display !== 'none' && heroSet) return true;
    return false;
  }, { timeout: 45000 }).catch(() => {});
  const state = await page.evaluate(() => ({
    resolvedTag: document.getElementById('resolved-tag')?.textContent?.trim() || '',
    resolvedBlockMixJson: JSON.stringify(typeof resolvedBlockMix !== 'undefined' ? resolvedBlockMix : '?'),
    quickVisible: document.getElementById('quickResult')?.style.display !== 'none',
    quickHero: document.getElementById('qr-hero-price')?.textContent || '',
  }));
  await page.close();
  return state;
}

console.log('\n══════ (A) 650118 — present in PROPERTY_INFO with {4:88} ══════');
for (const t of ['4 ROOM']) {
  const r = await probe('650118', t);
  console.log(`  ${t}:`);
  console.log(`    resolvedTag: "${r.resolvedTag.slice(0,120)}"`);
  console.log(`    resolvedBlockMix: ${r.resolvedBlockMixJson}`);
  console.log(`    quickVisible: ${r.quickVisible} hero: "${r.quickHero}"`);
  record(`A·650118·${t.replace(' ','_')} normal render`,
    !/has no/.test(r.resolvedTag) && r.quickVisible && r.quickHero.length >= 1,
    `hero="${r.quickHero}"`);
}
for (const t of ['1 ROOM', '2 ROOM', '3 ROOM', '5 ROOM', 'EXECUTIVE']) {
  const r = await probe('650118', t);
  record(`A·650118·${t.replace(' ','_')} short-circuit`,
    /has no.*flats/.test(r.resolvedTag) && !r.quickVisible,
    `tag matches? qr visible=${r.quickVisible}`);
}

console.log('\n══════ (B) 400001 — absent from PROPERTY_INFO (rental-only block) ══════');
console.log('       must NOT short-circuit for ANY flat type');
for (const t of ['1 ROOM', '2 ROOM', '3 ROOM', '4 ROOM', '5 ROOM', 'EXECUTIVE']) {
  const r = await probe('400001', t);
  console.log(`  ${t}:`);
  console.log(`    resolvedTag: "${r.resolvedTag.slice(0,120)}"`);
  console.log(`    resolvedBlockMix: ${r.resolvedBlockMixJson}`);
  console.log(`    quickVisible: ${r.quickVisible} hero: "${r.quickHero}"`);
  record(`B·400001·${t.replace(' ','_')} no short-circuit (unknown mix)`,
    !/has no.*flats/.test(r.resolvedTag),
    `tag="${r.resolvedTag.slice(0,80)}"`);
  record(`B·400001·${t.replace(' ','_')} resolvedBlockMix null (positive-evidence gate)`,
    r.resolvedBlockMixJson === 'null',
    `resolvedBlockMix=${r.resolvedBlockMixJson}`);
}

await browser.close();
console.log('\n═══ Summary ═══');
const failed = results.filter(r => !r.pass);
console.log(`${results.length - failed.length}/${results.length} pass`);
if (failed.length) for (const f of failed) console.log(`  FAIL: ${f.id} — ${f.evidence}`);
process.exit(failed.length === 0 ? 0 : 2);
