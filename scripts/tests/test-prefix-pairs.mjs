// test-prefix-pairs.mjs — structural guard against prefix-containment street
// collisions. For every pair of PROPERTY_INFO street names (X, Y) where X is a
// strict prefix of Y (e.g. "ANG MO KIO AVENUE 1" is a prefix of "ANG MO KIO
// AVENUE 10", or "TAMPINES AVE 1" of "TAMPINES AVE 12"), the two must NOT
// share any block number.
//
// If they ever did, a naive `includes()` matcher would silently pool blocks
// from both streets — the exact bug the 650118 field failure exposed. This
// test enforces the invariant so a future refactor can't recreate the
// hazard even by accident.
//
// Generates pairs programmatically from the shipped constant — no hardcoded
// list to drift.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Moved 2026-07-30 from scripts/ to scripts/tests/; HTML_PATH walks up two dirs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = process.env.HTML_PATH || path.join(__dirname, '..', '..', 'index.html');

function extractPropertyInfo(html) {
  const m = html.match(/const PROPERTY_INFO=(\{[\s\S]*?\n\});/m);
  if (!m) throw new Error('PROPERTY_INFO not found');
  return JSON.parse(m[1]);
}

const html = await fs.readFile(HTML_PATH, 'utf8');
const info = extractPropertyInfo(html);
const streets = Object.keys(info);

// Find all prefix-containment pairs. Prefix means: X is a strict prefix of Y
// AND either X === Y (excluded — reflexive), or Y starts with X followed by
// a non-word character (so "AVE 1" vs "AVE 11" counts; "AVE 1" vs "AVE 1A"
// counts; but "AVE 1" vs "AVE 12" — Y starts with "AVE 1" then "2", a word
// character, so no. Wait, that's wrong — we DO want to catch AVE 1 vs AVE 12.
// The correct test: Y === X + suffix where suffix begins with something that
// distinguishes a different street. Using tokens (space-separated):
// "AVE 1"  vs  "AVE 12"   → tokens ["AVE","1"] vs ["AVE","12"] — Y's last
// token is a superstring of X's last token. THAT'S the hazard.
// "AVE 10" vs "AVE 1"     → same shape, other direction.
//
// So the real check: two streets are a "prefix hazard" pair if their token
// sequences match on all-but-last, and one's last token is a prefix of the
// other's last token (numeric OR alphanumeric).

function tokens(s) { return s.split(/\s+/); }

const pairs = [];
for (let i = 0; i < streets.length; i++) {
  const ti = tokens(streets[i]);
  for (let j = i + 1; j < streets.length; j++) {
    const tj = tokens(streets[j]);
    if (ti.length !== tj.length) continue;
    let match = true;
    for (let k = 0; k < ti.length - 1; k++) if (ti[k] !== tj[k]) { match = false; break; }
    if (!match) continue;
    const li = ti[ti.length - 1], lj = tj[tj.length - 1];
    if (li === lj) continue;
    if (li.startsWith(lj) || lj.startsWith(li)) {
      pairs.push([streets[i], streets[j]]);
    }
  }
}

console.log(`Generated ${pairs.length} prefix-containment street pair(s) from ${streets.length} streets`);
console.log();

let violations = 0;
for (const [a, b] of pairs) {
  const blksA = new Set(Object.keys(info[a]));
  const blksB = new Set(Object.keys(info[b]));
  const shared = [...blksA].filter(x => blksB.has(x));
  if (shared.length) {
    violations++;
    console.log(`  ✘ ${a}  ×  ${b}   share block(s): ${shared.slice(0, 10).join(', ')}${shared.length>10?` …+${shared.length-10}`:''}`);
  }
}

// Sample a few pairs for evidence, up to 12
console.log(`\nSample pair(s) (evidence of enumeration working):`);
for (const [a, b] of pairs.slice(0, 12)) {
  console.log(`   ${a}   ×   ${b}`);
}
if (pairs.length > 12) console.log(`   … +${pairs.length - 12} more`);

console.log();
if (violations === 0) {
  console.log(`✓ ALL PASS — no shared block numbers across any of ${pairs.length} prefix-containment pair(s)`);
  process.exit(0);
} else {
  console.log(`✘ ${violations} pair(s) violate the invariant`);
  process.exit(1);
}
