// analyze-misses.mjs — enrich the 45 gate misses with:
//   (a) nearest fixture-string match (edit distance) — surfaces plausible neighbours
//   (b) HDB estate/lease context (town code + year_completed range + block count)
// so the owner can judge each miss as either "genuinely zero-resale" or
// "near-match → needs exceptions entry".
//
// Reads:
//   index.html                                (PROPERTY_INFO)
//   .github/data/hdb-resale-street-names.json (fixture)
//   /tmp/hdb-prop-pages/*.json                (raw HDB Property Info for context)
//
// Emits a single COPY BACK block at the end.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abbrevStreet, canonStreet } from './street-normalizers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// Levenshtein distance — classical O(m·n) DP. Fine for these strings.
function edit(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1); const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

// Load PROPERTY_INFO
const html = await fs.readFile(path.join(REPO, 'index.html'), 'utf8');
const info = JSON.parse(html.match(/const PROPERTY_INFO=(\{[\s\S]*?\n\});/m)[1]);

// Load fixture
const fixture = JSON.parse(await fs.readFile(path.join(REPO, '.github', 'data', 'hdb-resale-street-names.json'), 'utf8'));
const hdbList = fixture.distinct_street_names;
const hdbSet = new Set(hdbList);

// Load raw HDB Property Info for context (from /tmp cache from earlier pull)
const raw = [];
try {
  const dir = '/tmp/hdb-prop-pages';
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const d = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
    for (const r of (d.result?.records || [])) raw.push(r);
  }
} catch (e) {
  console.error(`WARN: raw HDB cache unavailable (${e.message}); context will be minimal`);
}

// Index raw records by HDB street form (already abbreviated in the dataset)
const rawByStreet = new Map();
for (const r of raw) {
  const s = (r.street || '').toUpperCase();
  if (!s) continue;
  if (!rawByStreet.has(s)) rawByStreet.set(s, []);
  rawByStreet.get(s).push(r);
}

// Enumerate misses
const misses = [];
for (const canonKey of Object.keys(info)) {
  const hdbKey = abbrevStreet(canonKey);
  if (!hdbSet.has(hdbKey)) {
    misses.push({
      canon: canonKey,
      hdb: hdbKey,
      blockCount: Object.keys(info[canonKey]).length,
    });
  }
}
misses.sort((a, b) => b.blockCount - a.blockCount);

// For each miss, find top-3 nearest fixture entries by edit distance
for (const m of misses) {
  const scored = hdbList.map(s => ({ s, d: edit(m.hdb, s) }));
  scored.sort((a, b) => a.d - b.d);
  m.nearest = scored.slice(0, 3);

  // Context from raw HDB
  const rawRecs = rawByStreet.get(m.hdb) || [];
  const years = rawRecs.map(r => +r.year_completed).filter(y => y >= 1900 && y <= 2100);
  const towns = [...new Set(rawRecs.map(r => r.bldg_contract_town).filter(Boolean))];
  m.context = {
    towns,
    yearMin: years.length ? Math.min(...years) : null,
    yearMax: years.length ? Math.max(...years) : null,
    rawBlocks: rawRecs.length,
  };
}

// Text output + COPY BACK block
console.log(`45-miss enrichment (fixture pulled ${fixture.pulled_at})`);
console.log();
for (const m of misses) {
  const c = m.context;
  const nearestStr = m.nearest.map(x => `${x.s}(d=${x.d})`).join(', ');
  const yearStr = c.yearMin ? `${c.yearMin}${c.yearMin!==c.yearMax?`–${c.yearMax}`:''}` : '?';
  const townStr = c.towns.length ? c.towns.join('/') : '?';
  console.log(`  ${m.hdb.padEnd(24)}  ${String(m.blockCount).padStart(3)} blks  town=${townStr.padEnd(4)}  year=${yearStr.padEnd(9)}  nearest: ${nearestStr}`);
}

console.log();
console.log('```');
console.log('=================== COPY BACK #1 — enriched misses ===================');
console.log(`date       : ${new Date().toISOString().slice(0,10)}`);
console.log(`fixture    : pulled ${fixture.pulled_at}, ${hdbList.length} distinct HDB streets`);
console.log(`misses     : ${misses.length} PROPERTY_INFO streets absent from HDB fixture`);
console.log('columns    : hdb-form | blks | town(s) | year(s) | nearest-3 fixture matches (edit distance)');
console.log('----- rows -----');
for (const m of misses) {
  const nearest = m.nearest.map(x => `${JSON.stringify(x.s)}(d=${x.d})`).join(', ');
  const yearStr = m.context.yearMin
    ? (m.context.yearMin === m.context.yearMax ? String(m.context.yearMin) : `${m.context.yearMin}-${m.context.yearMax}`)
    : '?';
  const townStr = m.context.towns.length ? m.context.towns.join('/') : '?';
  console.log(`  ${JSON.stringify(m.hdb)} | ${m.blockCount} | ${townStr} | ${yearStr} | ${nearest}`);
}
console.log('----- interpretation guide -----');
console.log('  d=0 : impossible — miss means no exact match in fixture');
console.log('  d=1 : one char diff — likely a real neighbour (same street, different number)');
console.log('  d=2-4: same street family, different subzone — usually still neighbour');
console.log('  d>=5: unrelated street — genuinely zero-resale');
console.log('======================================================================');
console.log('```');
