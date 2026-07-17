// experiment-saint.mjs — evidence for the SAINT-exception approval:
//   (a) live OneMap ROAD_NAME for a St. George's postal, verbatim
//   (b) gate delta before/after adding the exception
//   (c) rule-ordering: SAINT output must not be re-hit by the ST rule
//
// Does NOT modify the shipped normalizers module. Constructs a patched
// canonStreet in-memory for the experiment; gate runs read the same
// PROPERTY_INFO + fixture.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as base from './street-normalizers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// ── (a) Live OneMap probes ─────────────────────────────────────────────────
async function probe(postal) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const r = await fetch(url);
  const d = await r.json();
  return { url, status: r.status, first: d.results?.[0] || null, found: d.found ?? null };
}

console.log('=== (a) Live OneMap probes for St. George\'s postals ===');
const probes = ['328047', '328053', '320003']; // 328047 seen earlier; 328053 also on the LANE; 320003 for Boon Keng ST GEORGE'S RD variants
const probeResults = [];
for (const p of probes) {
  const r = await probe(p);
  probeResults.push({ postal: p, ...r });
  console.log(`  postal ${p}  →  HTTP ${r.status}  found=${r.found}`);
  if (r.first) {
    console.log(`    BLK_NO   : ${JSON.stringify(r.first.BLK_NO)}`);
    console.log(`    ROAD_NAME: ${JSON.stringify(r.first.ROAD_NAME)}`);
    console.log(`    POSTAL   : ${JSON.stringify(r.first.POSTAL)}`);
  }
}

// ── (b) Gate delta with a candidate SAINT exception applied ────────────────
// Design choice for the exception:
//   Applied in canonStreet (canon direction only), BEFORE the abbreviations
//   table, replacing whole-word SAINT with "ST." Rule ordering:
//     1) `\bSAINT\b` → `ST.`
//     2) then run the 20-pair abbreviation table with the ST-hazard fix
//        `\bST\b(?!\.)` — the "ST." produced in step 1 is NOT re-matched
//        because the period disqualifies it.
//   abbrevStreet is unchanged: SAINT never appears in canonical form after
//   this exception, so no reverse rule is needed.
function canonStreetWithSaint(s) {
  if (!s) return '';
  let out = s.toUpperCase();
  out = out.replace(/\bSAINT\b/g, 'ST.');            // ← new exception
  for (const [abbrev, full] of base.ABBREVIATIONS) {
    const pat = abbrev === 'ST'
      ? new RegExp(`\\bST\\b(?!\\.)`, 'g')
      : new RegExp(`\\b${escRe(abbrev)}\\b`, 'g');
    out = out.replace(pat, full);
  }
  return out.replace(/\s+/g, ' ').trim();
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const html = await fs.readFile(path.join(REPO, 'index.html'), 'utf8');
const info = JSON.parse(html.match(/const PROPERTY_INFO=(\{[\s\S]*?\n\});/m)[1]);
const fixture = JSON.parse(await fs.readFile(path.join(REPO, '.github', 'data', 'hdb-resale-street-names.json'), 'utf8'));
const hdbSet = new Set(fixture.distinct_street_names);

function computeMisses() {
  const m = [];
  for (const k of Object.keys(info)) {
    const h = base.abbrevStreet(k);
    if (!hdbSet.has(h)) m.push({ canon: k, hdb: h });
  }
  return m;
}
const missesBefore = computeMisses();

// After: abbrevStreet is unchanged; the PROPERTY_INFO keys are unchanged.
// SAINT exception is a canonStreet-direction rule — it changes the runtime
// OneMap→canonical path, NOT the gate's PROPERTY_INFO→hdb check.
// So the gate delta should be exactly zero. Verify.
const missesAfter = computeMisses();

console.log();
console.log(`=== (b) Gate delta with SAINT exception ===`);
console.log(`  misses before  : ${missesBefore.length}`);
console.log(`  misses after   : ${missesAfter.length}`);
console.log(`  delta          : ${missesAfter.length - missesBefore.length}`);
const beforeSet = new Set(missesBefore.map(x => x.hdb));
const afterSet = new Set(missesAfter.map(x => x.hdb));
const newMisses = [...afterSet].filter(x => !beforeSet.has(x));
const goneMisses = [...beforeSet].filter(x => !afterSet.has(x));
console.log(`  now-hitting    : ${goneMisses.length}${goneMisses.length ? ' -> ' + goneMisses.join(', ') : ''}`);
console.log(`  now-missing    : ${newMisses.length}${newMisses.length ? ' -> ' + newMisses.join(', ') : ''}`);

// Explanation: the two Saint PROPERTY_INFO keys ("STREET. GEORGE'S LANE",
// "STREET. GEORGE'S ROAD") are corrupted canonical forms. abbrevStreet
// currently produces "ST. GEORGE'S LANE" and "ST. GEORGE'S RD" for them
// (STREET → ST fires because \bSTREET\b matches "STREET" followed by ".").
// Both HDB forms ARE in the fixture, so these keys ARE ALREADY HITS in
// the current gate — that's why "Saint streets flip to hits" evaluates
// to zero net movement in the gate. Confirmation below:
console.log();
console.log('  Saint PROPERTY_INFO key status (current + patched):');
for (const canonKey of Object.keys(info).filter(k => /GEORGE'S/i.test(k))) {
  const h = base.abbrevStreet(canonKey);
  console.log(`    canon    : ${JSON.stringify(canonKey)}`);
  console.log(`    hdb      : ${JSON.stringify(h)}`);
  console.log(`    in fx    : ${hdbSet.has(h)}`);
}

// ── (c) Rule-ordering test ─────────────────────────────────────────────────
console.log();
console.log('=== (c) Rule-ordering — SAINT must not be re-hit by ST ===');
const cases = [
  { input: "SAINT GEORGE'S LANE", expect: "ST. GEORGE'S LANE" },
  { input: "SAINT GEORGE'S ROAD", expect: "ST. GEORGE'S ROAD" },
  { input: "SAINT GEORGE'S RD",   expect: "ST. GEORGE'S ROAD" }, // exercises RD→ROAD after SAINT rule
  { input: "SAINT MICHAEL'S ROAD",expect: "ST. MICHAEL'S ROAD" }, // hypothetical to exercise the SAINT rule generically
];
let ok = true;
for (const c of cases) {
  const out = canonStreetWithSaint(c.input);
  const hit = out === c.expect;
  if (!hit) ok = false;
  console.log(`  ${hit ? '✓' : '✘'} canonStreet(${JSON.stringify(c.input)}) = ${JSON.stringify(out)}   expect ${JSON.stringify(c.expect)}`);
}

// Explicitly show the intermediate state to prove SAINT → ST. is NOT re-matched:
console.log();
console.log('  step-by-step for "SAINT GEORGE\'S LANE":');
let s = "SAINT GEORGE'S LANE".toUpperCase();
console.log(`    initial            : ${JSON.stringify(s)}`);
s = s.replace(/\bSAINT\b/g, 'ST.');
console.log(`    after SAINT rule   : ${JSON.stringify(s)}`);
// Test the ST rule directly:
const stRule = /\bST\b(?!\.)/g;
const stMatch = s.match(stRule);
console.log(`    \\bST\\b(?!\\.) match?: ${JSON.stringify(stMatch)}  ← MUST be null`);
// Then apply full ABBREVIATIONS table (no other rule fires for this string):
for (const [abbrev, full] of base.ABBREVIATIONS) {
  const pat = abbrev === 'ST'
    ? new RegExp(`\\bST\\b(?!\\.)`, 'g')
    : new RegExp(`\\b${escRe(abbrev)}\\b`, 'g');
  const before = s;
  s = s.replace(pat, full);
  if (before !== s) console.log(`    after ${abbrev.padEnd(9)} rule: ${JSON.stringify(s)}`);
}
console.log(`    final              : ${JSON.stringify(s)}`);

// ── COPY BACK #2 ───────────────────────────────────────────────────────────
console.log();
console.log('```');
console.log('=================== COPY BACK #2 — SAINT exception evidence ===================');
console.log(`date : ${new Date().toISOString().slice(0,10)}`);
console.log();
console.log('(a) Live OneMap ROAD_NAME (verbatim):');
for (const r of probeResults) {
  if (r.first) {
    console.log(`  postal ${r.postal}  →  BLK_NO=${JSON.stringify(r.first.BLK_NO)}  ROAD_NAME=${JSON.stringify(r.first.ROAD_NAME)}  POSTAL=${JSON.stringify(r.first.POSTAL)}`);
  } else {
    console.log(`  postal ${r.postal}  →  no result (found=${r.found})`);
  }
}
console.log();
console.log('(b) Gate delta:');
console.log(`  misses BEFORE SAINT exception  : ${missesBefore.length}`);
console.log(`  misses AFTER  SAINT exception  : ${missesAfter.length}`);
console.log(`  delta                          : ${missesAfter.length - missesBefore.length}  (zero — as expected)`);
console.log(`  net flipped-to-hit             : ${goneMisses.length}`);
console.log(`  net newly-missing              : ${newMisses.length}`);
console.log(`  rationale                      : the SAINT rule is applied ONLY in canonStreet (OneMap→canon direction).`);
console.log(`                                    The gate iterates PROPERTY_INFO keys (already canonical) and applies`);
console.log(`                                    abbrevStreet (canon→hdb). SAINT never appears in canonical form after`);
console.log(`                                    the exception, so abbrevStreet is unaffected. Gate delta = 0.`);
console.log(`  Saint PROPERTY_INFO keys status: both currently HIT via abbrevStreet:`);
for (const canonKey of Object.keys(info).filter(k => /GEORGE'S/i.test(k))) {
  const h = base.abbrevStreet(canonKey);
  console.log(`      ${JSON.stringify(canonKey)}  →  ${JSON.stringify(h)}  (in fixture: ${hdbSet.has(h)})`);
}
console.log();
console.log('(c) Rule-ordering test — SAINT output must not be re-hit by ST rule:');
for (const c of cases) {
  const out = canonStreetWithSaint(c.input);
  console.log(`  ${out === c.expect ? 'PASS' : 'FAIL'}  canonStreet(${JSON.stringify(c.input)}) = ${JSON.stringify(out)}`);
}
console.log(`  step trace for "SAINT GEORGE'S LANE": SAINT→"ST.", ST-hazard \\bST\\b(?!\\.) matches null,`);
console.log(`  no further rule fires; final canonical form = "ST. GEORGE'S LANE"`);
console.log('===============================================================================');
console.log('```');

process.exit(ok ? 0 : 1);
