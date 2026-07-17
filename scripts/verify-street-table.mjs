// verify-street-table.mjs — Commit-1 pre-ship gate.
//
// Two checks:
//   (1) Injectivity  — abbrevStreet() maps N distinct PROPERTY_INFO streets to
//       N distinct HDB abbreviations. Collisions mean the exceptions table is
//       missing an entry; runtime lookups would silently disagree with HDB.
//   (2) Existence    — every abbrevStreet(key) is present verbatim in the
//       cached distinct-street list from the resale dataset. Any miss means
//       the runtime filter `{street_name: hdbStreet}` would return zero rows
//       for those blocks. That is by definition a bug the exact-match design
//       must catch.
//
// Prints a COPY BACK block for the owner. Exits 1 on any failure so the shell
// caller / a git hook can hard-stop.
//
// Usage:  node scripts/verify-street-table.mjs [--fixture <path>]
// Env:    HTML_PATH (default: repo-root index.html)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonStreet, abbrevStreet, ABBREVIATIONS, CANON_EXCEPTIONS } from './street-normalizers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const HTML_PATH = process.env.HTML_PATH || path.join(REPO, 'index.html');
const FIXTURE_PATH = getArg('--fixture') || path.join(REPO, '.github', 'data', 'hdb-resale-street-names.json');

function getArg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function extractPropertyInfo(html) {
  const m = html.match(/const PROPERTY_INFO=(\{[\s\S]*?\n\});/m);
  if (!m) throw new Error(`PROPERTY_INFO constant not found in ${HTML_PATH}`);
  return JSON.parse(m[1]);
}

const html = await fs.readFile(HTML_PATH, 'utf8');
const propertyInfo = extractPropertyInfo(html);
const canonKeys = Object.keys(propertyInfo).sort();

const fixture = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8'));
const hdbSet = new Set(fixture.distinct_street_names || []);

console.log('=== Street-table verification gate ===');
console.log(`PROPERTY_INFO source : ${path.relative(REPO, HTML_PATH)}`);
console.log(`Fixture              : ${path.relative(REPO, FIXTURE_PATH)}  (pulled ${fixture.pulled_at})`);
console.log(`  fixture rows       : ${fixture.row_count_at_pull}`);
console.log(`  fixture streets    : ${hdbSet.size} distinct`);
console.log(`PROPERTY_INFO streets: ${canonKeys.length}`);
console.log(`Abbreviation pairs   : ${ABBREVIATIONS.length}`);
console.log(`Canon exceptions     : ${CANON_EXCEPTIONS.length}`);
console.log();

// ── (1) Injectivity ────────────────────────────────────────────────────────
const abbrevOf = {};
const collisions = new Map();
for (const c of canonKeys) {
  const h = abbrevStreet(c);
  if (h in abbrevOf) {
    if (!collisions.has(h)) collisions.set(h, [abbrevOf[h]]);
    collisions.get(h).push(c);
  } else {
    abbrevOf[h] = c;
  }
}
const uniqueOut = new Set(Object.values(abbrevOf)).size + [...collisions.values()].reduce((n, arr) => n + arr.length, 0);
const injective = collisions.size === 0;
console.log(`(1) INJECTIVITY: ${canonKeys.length} in → ${new Set(Object.keys(abbrevOf)).size} unique out`);
if (!injective) {
  console.log(`    ✘ ${collisions.size} collision(s):`);
  for (const [h, arr] of [...collisions.entries()].slice(0, 20)) {
    console.log(`        ${h}  ←  ${arr.join('  |  ')}`);
  }
} else {
  console.log(`    ✓ injective`);
}
console.log();

// ── (2) Existence ──────────────────────────────────────────────────────────
const misses = [];
for (const c of canonKeys) {
  const h = abbrevStreet(c);
  if (!hdbSet.has(h)) misses.push({ canon: c, hdb: h });
}
console.log(`(2) EXISTENCE: ${canonKeys.length - misses.length}/${canonKeys.length} PROPERTY_INFO streets found in HDB resale fixture`);
if (misses.length) {
  console.log(`    ✘ ${misses.length} miss(es):`);
  for (const m of misses.slice(0, 40)) {
    console.log(`        canon: ${JSON.stringify(m.canon)}`);
    console.log(`        hdb:   ${JSON.stringify(m.hdb)}`);
  }
  if (misses.length > 40) console.log(`    … and ${misses.length - 40} more`);
} else {
  console.log(`    ✓ all present`);
}
console.log();

// ── COPY BACK ──────────────────────────────────────────────────────────────
console.log('```');
console.log('===================== COPY BACK =====================');
console.log(`date            : ${new Date().toISOString().slice(0,10)}`);
console.log(`fixture pulled  : ${fixture.pulled_at} (${fixture.row_count_at_pull} rows, ${hdbSet.size} distinct streets)`);
console.log(`PROPERTY_INFO   : ${canonKeys.length} streets`);
console.log(`abbrevs         : ${ABBREVIATIONS.length} pairs, ${CANON_EXCEPTIONS.length} exceptions`);
console.log(`injectivity     : ${injective ? 'PASS' : `FAIL — ${collisions.size} collision(s)`}`);
console.log(`existence       : ${misses.length === 0 ? 'PASS' : `FAIL — ${misses.length} miss(es)`}`);
if (misses.length) {
  console.log('---- misses (up to 40) ----');
  for (const m of misses.slice(0, 40)) console.log(`  ${JSON.stringify(m.hdb)}  ←  ${JSON.stringify(m.canon)}`);
  if (misses.length > 40) console.log(`  … +${misses.length - 40} more`);
}
if (!injective) {
  console.log('---- collisions ----');
  for (const [h, arr] of [...collisions.entries()].slice(0, 20)) {
    console.log(`  hdb ${JSON.stringify(h)}  ←  ${arr.map(x => JSON.stringify(x)).join(', ')}`);
  }
}
console.log('======================================================');
console.log('```');

const ok = injective && misses.length === 0;
process.exit(ok ? 0 : 1);
