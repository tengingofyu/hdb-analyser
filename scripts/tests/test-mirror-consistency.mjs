// test-mirror-consistency.mjs — the tripwire.
//
// The same abbreviation table lives in three places:
//   1. scripts/street-normalizers.mjs    (canonical source, imported by tests)
//   2. index.html                        (inline copy, shipped to the browser)
//   3. .github/workflows/update-coords.yml (inline copy, applied at ingest)
//
// Three copies of the same rules is how the 2026-07-15 field bug happened:
// `normStr` covered 7 abbreviations while `canonStreet` knew 20, and street
// filtering silently mis-matched. This test asserts all three copies are
// byte-identical (after canonicalising to a common tuple form). If any of
// them drifts, this test fails loudly BEFORE deploy.
//
// Extraction strategy: read each file as text, regex out the table literals,
// normalise to `sorted list of [abbrev, full]` pairs and to `sorted list of
// [regex-source, replacement]` for exceptions.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABBREVIATIONS as MJS_ABBREV, CANON_EXCEPTIONS as MJS_CANEX } from '../street-normalizers.mjs';

// Moved 2026-07-30 from scripts/ to scripts/tests/; REPO now walks up two dirs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const HTML_PATH = path.join(REPO, 'index.html');
const YML_PATH  = path.join(REPO, '.github', 'workflows', 'update-coords.yml');

let failed = 0;
function check(label, ok, extra='') {
  console.log(`  ${ok ? '✓' : '✘'} ${label}${extra ? '  — ' + extra : ''}`);
  if (!ok) failed++;
}

// ── (1) Canonicalise the .mjs source of truth ──────────────────────────────
// ABBREVIATIONS: [['AVE','AVENUE'], ...] → sorted "AVE|AVENUE" strings
const mjsAbbrevKey = (arr) => arr.map(([a, f]) => `${a}|${f}`).sort();
// CANON_EXCEPTIONS: [[/\bSAINT\b/g, 'ST.']] → sorted "/source/flags|repl" strings
const mjsCanexKey = (arr) => arr.map(([re, r]) => `/${re.source}/${re.flags}|${r}`).sort();

const truthAbbrev = mjsAbbrevKey(MJS_ABBREV);
const truthCanex  = mjsCanexKey(MJS_CANEX);

console.log('=== Mirror-consistency: three copies of the abbreviation table ===\n');
console.log(`Source of truth (scripts/street-normalizers.mjs):`);
console.log(`  ABBREVIATIONS    : ${truthAbbrev.length} pairs`);
console.log(`  CANON_EXCEPTIONS : ${truthCanex.length} rules\n`);

// ── (2) Extract from index.html ────────────────────────────────────────────
const html = await fs.readFile(HTML_PATH, 'utf8');
// Extract STREET_ABBREV_TABLE literal — comma-separated pairs [['AVE','AVENUE'],...]
// Regex respects quote type so entries like ["C'WEALTH", 'COMMONWEALTH'] parse
// (the apostrophe inside double-quotes is NOT a delimiter).
const htmlAbbrevMatch = html.match(/const\s+STREET_ABBREV_TABLE\s*=\s*(\[[\s\S]*?\]);/);
if (!htmlAbbrevMatch) {
  check('index.html STREET_ABBREV_TABLE found', false, 'literal not located');
} else {
  const literal = htmlAbbrevMatch[1];
  const PAIR_RE = /\[\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(?:'([^']*)'|"([^"]*)")\s*\]/g;
  const pairs = [...literal.matchAll(PAIR_RE)]
    .map(m => `${m[1] ?? m[2]}|${m[3] ?? m[4]}`).sort();
  check('index.html STREET_ABBREV_TABLE parses',
    pairs.length === truthAbbrev.length, `got ${pairs.length}, expected ${truthAbbrev.length}`);
  const identical = JSON.stringify(pairs) === JSON.stringify(truthAbbrev);
  check('index.html STREET_ABBREV_TABLE matches .mjs ABBREVIATIONS exactly', identical);
  if (!identical) {
    console.log('    .mjs   :', JSON.stringify(truthAbbrev));
    console.log('    html   :', JSON.stringify(pairs));
  }
}
// Extract CANON_STREET_EXCEPTIONS literal
const htmlCanexMatch = html.match(/const\s+CANON_STREET_EXCEPTIONS\s*=\s*(\[[\s\S]*?\]);/);
if (!htmlCanexMatch) {
  check('index.html CANON_STREET_EXCEPTIONS found', false);
} else {
  const literal = htmlCanexMatch[1];
  const pairs = [...literal.matchAll(/\[\s*(\/[^\/]+\/[gimsuy]*)\s*,\s*['"]([^'"]+)['"]\s*\]/g)]
    .map(m => {
      const rmatch = m[1].match(/^\/(.*)\/([gimsuy]*)$/);
      return `/${rmatch[1]}/${rmatch[2]}|${m[2]}`;
    }).sort();
  check('index.html CANON_STREET_EXCEPTIONS parses',
    pairs.length === truthCanex.length, `got ${pairs.length}, expected ${truthCanex.length}`);
  const identical = JSON.stringify(pairs) === JSON.stringify(truthCanex);
  check('index.html CANON_STREET_EXCEPTIONS matches .mjs CANON_EXCEPTIONS exactly', identical);
  if (!identical) {
    console.log('    .mjs   :', JSON.stringify(truthCanex));
    console.log('    html   :', JSON.stringify(pairs));
  }
}

// ── (3) Extract from update-coords.yml ─────────────────────────────────────
const yml = await fs.readFile(YML_PATH, 'utf8');
// STREET_ABBREVIATIONS in the workflow uses [/\bAVE\b/g,'AVENUE'] regex form.
// Extract as [pattern, replacement] where pattern is the /source/flags string.
const ymlAbbrevMatch = yml.match(/const\s+STREET_ABBREVIATIONS\s*=\s*(\[[\s\S]*?\]);/);
if (!ymlAbbrevMatch) {
  check('update-coords.yml STREET_ABBREVIATIONS found', false);
} else {
  const literal = ymlAbbrevMatch[1];
  const pairs = [...literal.matchAll(/\[\s*(\/[^\/]+\/[gimsuy]*)\s*,\s*['"]([^'"]+)['"]\s*\]/g)]
    .map(m => {
      const rmatch = m[1].match(/^\/(.*)\/([gimsuy]*)$/);
      const src = rmatch[1];
      // Try to reverse-engineer the abbrev from `\bAVE\b` or `\bST\b(?!\.)`.
      const bareMatch = src.match(/^\\b(.+?)\\b(?:\(\?!\\\.\))?$/);
      if (!bareMatch) return `?${src}?|${m[2]}`;
      return `${bareMatch[1]}|${m[2]}`;
    }).sort();
  check('update-coords.yml STREET_ABBREVIATIONS parses',
    pairs.length === truthAbbrev.length, `got ${pairs.length}, expected ${truthAbbrev.length}`);
  const identical = JSON.stringify(pairs) === JSON.stringify(truthAbbrev);
  check('update-coords.yml STREET_ABBREVIATIONS matches .mjs ABBREVIATIONS exactly', identical);
  if (!identical) {
    console.log('    .mjs   :', JSON.stringify(truthAbbrev));
    console.log('    yml    :', JSON.stringify(pairs));
  }
}
// CANON_EXCEPTIONS in the workflow — same regex form as .mjs
const ymlCanexMatch = yml.match(/const\s+CANON_EXCEPTIONS\s*=\s*(\[[\s\S]*?\]);/);
if (!ymlCanexMatch) {
  check('update-coords.yml CANON_EXCEPTIONS found', false);
} else {
  const literal = ymlCanexMatch[1];
  const pairs = [...literal.matchAll(/\[\s*(\/[^\/]+\/[gimsuy]*)\s*,\s*['"]([^'"]+)['"]\s*\]/g)]
    .map(m => {
      const rmatch = m[1].match(/^\/(.*)\/([gimsuy]*)$/);
      return `/${rmatch[1]}/${rmatch[2]}|${m[2]}`;
    }).sort();
  check('update-coords.yml CANON_EXCEPTIONS parses',
    pairs.length === truthCanex.length, `got ${pairs.length}, expected ${truthCanex.length}`);
  const identical = JSON.stringify(pairs) === JSON.stringify(truthCanex);
  check('update-coords.yml CANON_EXCEPTIONS matches .mjs CANON_EXCEPTIONS exactly', identical);
  if (!identical) {
    console.log('    .mjs   :', JSON.stringify(truthCanex));
    console.log('    yml    :', JSON.stringify(pairs));
  }
}

// ── (4) ST-hazard sentinel — the special regex form must appear in both
//        the yml and the index.html inline table, not just the .mjs's
//        runtime construction. ──────────────────────────────────────────────
const hazardInHtml = /['"]ST['"]/.test(html) && /\\bST\\b\(\?!\\\.\)/.test(html);
const hazardInYml  = /\/\\bST\\b\(\?!\\\.\)\/g/.test(yml);
// (.mjs constructs the ST-hazard regex at runtime from the string 'ST', so
// the literal appears only there — no source-of-truth check needed.)
check('index.html contains the \\bST\\b(?!\\.) hazard fix at runtime', hazardInHtml);
check('update-coords.yml contains the \\bST\\b(?!\\.) hazard fix', hazardInYml);

console.log(`\n${failed === 0 ? '✓ ALL PASS — three copies are byte-identical' : `✘ ${failed} FAIL(S) — mirrors have drifted`}`);
process.exit(failed === 0 ? 0 : 1);
