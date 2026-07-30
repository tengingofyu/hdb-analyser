// property-info-verify.mjs — flat-type existence + affirm-first short-circuit.
// Reconstructed 2026-07-30 into scripts/tests/.
//
// Covers:
//   * 560472 EXECUTIVE short-circuit (single-type block, affirm-first copy)
//   * 560472 4 ROOM happy path (mix header)
//   * 123311 3 ROOM multi-type mix
//   * 123311 EXECUTIVE short-circuit (multi-type block)
//   * Badge-click recovery
//   * Mobile 390px overflow assertions
//   * 650118 field-report short-circuit path

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
  args: ['--no-sandbox', '--disable-web-security', '--user-data-dir=/tmp/hdb-test/pupp-profile-prop'],
});

async function driveQuick(page, { postal, flatType, floor = 10 }) {
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
  return await page.evaluate(() => {
    const rt = document.getElementById('resolved-tag');
    const okChip = rt?.querySelector('.tag.t-ok');
    const warnCard = rt?.querySelector('.tag.t-warn');
    const box = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
    };
    return {
      text: (rt?.textContent || '').trim(),
      okChipText: (okChip?.textContent || '').trim(),
      warnCardText: (warnCard?.textContent || '').trim(),
      okChipBox: box(okChip),
      warnCardBox: box(warnCard),
      viewportWidth: window.innerWidth,
      quickVisible: document.getElementById('quickResult')?.style.display !== 'none',
      availableBadges: [...document.querySelectorAll('#resolved-tag button.pill')].map(b => b.textContent.trim()),
    };
  });
}

// ── (1) 560472 EXECUTIVE short-circuit ────────────────────────────────
console.log('\n=== 1) 560472 EXECUTIVE short-circuit (single-type block) ===');
{
  const page = await browser.newPage();
  const s = await driveQuick(page, { postal: '560472', flatType: 'EXECUTIVE' });
  console.log('  okChip:', s.okChipText);
  console.log('  warnCard:', s.warnCardText);
  record('1.1 green chip visible with "— found."',
    /Block 472,.*ANG MO KIO AVENUE 10.*— found/.test(s.okChipText), s.okChipText);
  record('1.2 green chip carries the ✓', /✓/.test(s.okChipText), s.okChipText);
  record('1.3 warning leads with "This block has no EXECUTIVE flats"',
    /This block has no EXECUTIVE flats/.test(s.warnCardText), s.warnCardText.slice(0, 100));
  record('1.4 mix sentence uses single-type "It\'s 144 × 4-room only."',
    /It's 144 × 4-room only\./.test(s.warnCardText), '');
  record('1.5 available badge for 4 ROOM', s.availableBadges.includes('4 ROOM'), s.availableBadges.join(','));
  record('1.6 quickResult NOT visible', !s.quickVisible, `visible=${s.quickVisible}`);
  record('1.7 warn card stacked BELOW green chip',
    s.okChipBox && s.warnCardBox && s.warnCardBox.top >= s.okChipBox.bottom - 1,
    `okChip.bottom=${Math.round(s.okChipBox?.bottom)} warnCard.top=${Math.round(s.warnCardBox?.top)}`);
  await page.close();
}

// ── (2) 560472 4 ROOM happy path with mix header ──────────────────────
console.log('\n=== 2) 560472 4 ROOM — happy path with mix header ===');
{
  const page = await browser.newPage();
  const s = await driveQuick(page, { postal: '560472', flatType: '4 ROOM' });
  record('2.1 no short-circuit warning', !/has no.*flats/.test(s.text), s.text.slice(0, 80));
  record('2.2 mix header shows "144 × 4-room"', /144\s*×\s*4-room/.test(s.text), '');
  record('2.3 quickResult visible', s.quickVisible, `visible=${s.quickVisible}`);
  await page.close();
}

// ── (3) 123311 3 ROOM multi-type mix ──────────────────────────────────
console.log('\n=== 3) 123311 · 3 ROOM — multi-type happy path ===');
{
  const page = await browser.newPage();
  const s = await driveQuick(page, { postal: '123311', flatType: '3 ROOM' });
  record('3.1 mix header includes 148 × 4-room', /148\s*×\s*4-room/.test(s.text), '');
  record('3.2 mix header includes 74 × 3-room', /74\s*×\s*3-room/.test(s.text), '');
  record('3.3 mix header includes 74 × 5-room', /74\s*×\s*5-room/.test(s.text), '');
  record('3.4 quickResult visible', s.quickVisible, `visible=${s.quickVisible}`);
  await page.close();
}

// ── (4) 123311 EXECUTIVE short-circuit ─────────────────────────────────
console.log('\n=== 4) 123311 EXECUTIVE short-circuit (multi-type block) ===');
{
  const page = await browser.newPage();
  const s = await driveQuick(page, { postal: '123311', flatType: 'EXECUTIVE' });
  record('4.1 green chip visible with "— found."',
    /Block 311C,.*CLEMENTI AVENUE 4.*— found/.test(s.okChipText), s.okChipText);
  record('4.2 warning leads with "This block has no EXECUTIVE flats"',
    /This block has no EXECUTIVE flats/.test(s.warnCardText), s.warnCardText.slice(0, 100));
  record('4.3 multi-type mix sentence uses "It has …, …, …."',
    /It has 148 × 4-room, 74 × 3-room, 74 × 5-room\./.test(s.warnCardText), '');
  record('4.4 badges include 3/4/5 ROOM',
    ['3 ROOM','4 ROOM','5 ROOM'].every(t => s.availableBadges.includes(t)),
    s.availableBadges.join(','));
  await page.close();
}

// ── (5) Badge-click recovery ──────────────────────────────────────────
console.log('\n=== 5) Click "4 ROOM" badge at 560472 → recovery ===');
{
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.type('#postal', '560472');
  await page.select('#quick_flat_type', 'EXECUTIVE');
  await page.type('#quick_floor', '10');
  await page.click('#quickBtn');
  await page.waitForFunction(() => /has no EXECUTIVE/.test(document.getElementById('resolved-tag').textContent||''), { timeout: 20000 }).catch(()=>{});
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#resolved-tag button.pill')].find(b => b.textContent.trim() === '4 ROOM');
    if (btn) { btn.click(); return true; }
    return false;
  });
  record('5.1 clicked 4 ROOM badge', clicked, '');
  await page.waitForFunction(() => {
    const qr = document.getElementById('quickResult');
    return qr && qr.style.display !== 'none';
  }, { timeout: 30000 }).catch(()=>{});
  const finalState = await page.evaluate(() => ({
    quickVisible: document.getElementById('quickResult')?.style.display !== 'none',
    scope: document.getElementById('qr-scope')?.textContent || '',
  }));
  record('5.2 quickResult now visible after badge click', finalState.quickVisible, `scope="${finalState.scope}"`);
  record('5.3 scope reflects 4 ROOM', /4 ROOM/.test(finalState.scope), finalState.scope);
  await page.close();
}

// ── (6) Mobile 390px — both chip and warning fit ──────────────────────
console.log('\n=== 6) Mobile 390px — short-circuit at 560472 5 ROOM ===');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const s = await driveQuick(page, { postal: '560472', flatType: '5 ROOM' });
  const chipOk = s.okChipBox && s.okChipBox.right <= s.viewportWidth + 1 && s.okChipBox.left >= -1;
  const warnOk = s.warnCardBox && s.warnCardBox.right <= s.viewportWidth + 1 && s.warnCardBox.left >= -1;
  record('6.1 green chip does not overflow 390px', chipOk, `L=${s.okChipBox?.left} R=${s.okChipBox?.right}`);
  record('6.2 warn card does not overflow 390px', warnOk, `L=${s.warnCardBox?.left} R=${s.warnCardBox?.right}`);
  record('6.3 green chip height sane (< 80px)', s.okChipBox && s.okChipBox.height < 80, `h=${s.okChipBox?.height}`);
  record('6.4 warn card height sane (< 200px)', s.warnCardBox && s.warnCardBox.height < 200, `h=${s.warnCardBox?.height}`);
  record('6.5 warn stacked below chip on mobile',
    s.okChipBox && s.warnCardBox && s.warnCardBox.top >= s.okChipBox.bottom - 1,
    `okChip.bottom=${Math.round(s.okChipBox?.bottom)} warnCard.top=${Math.round(s.warnCardBox?.top)}`);
  await page.close();
}

// ── (7) 650118 EXECUTIVE — field-report case ──────────────────────────
console.log('\n=== 7) 650118 EXECUTIVE — the field-report case ===');
{
  const page = await browser.newPage();
  const s = await driveQuick(page, { postal: '650118', flatType: 'EXECUTIVE' });
  record('7.1 green chip: "Block 118, BUKIT BATOK WEST AVENUE 6 — found."',
    /Block 118,.*BUKIT BATOK WEST AVENUE 6.*— found/.test(s.okChipText), s.okChipText);
  record('7.2 warn: "This block has no EXECUTIVE flats"',
    /This block has no EXECUTIVE flats/.test(s.warnCardText), s.warnCardText.slice(0, 100));
  record('7.3 warn mix: "It\'s 88 × 4-room only."',
    /It's 88 × 4-room only\./.test(s.warnCardText), '');
  record('7.4 available badge for 4 ROOM', s.availableBadges.includes('4 ROOM'), s.availableBadges.join(','));
  await page.close();
}

await browser.close();
console.log('\n═══ Summary ═══');
const failed = results.filter(r => !r.pass);
console.log(`${results.length - failed.length}/${results.length} pass`);
if (failed.length) for (const f of failed) console.log(`  FAIL: ${f.id} — ${f.evidence}`);
process.exit(failed.length === 0 ? 0 : 2);
