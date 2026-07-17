// Street-name normalizers — the ONLY route between OneMap's spelled-out form,
// our PROPERTY_INFO canonical form, and HDB's abbreviated street_name form.
//
// Design rule (CLAUDE.md §5): no fuzzy matching. `canonStreet` and
// `abbrevStreet` are exact inverses. Any name that doesn't round-trip cleanly
// gets a `STREET_EXCEPTIONS` entry; it never becomes a runtime `includes()` /
// `startsWith` fallback.
//
// This module is imported by:
//   - scripts/verify-street-table.mjs  (pre-ship gate)
//   - index.html                       (via a lightweight inline mirror; see
//                                       Commit 1 rewire step 3)
//
// Kept as a pure ESM module with no runtime dependencies so it can be
// exercised in-process by node --input-type=module.

// Order matters ONLY within the abbreviation table because we apply rules
// sequentially with word-boundary regex — none of the 20 pairs currently
// interact, but keep entries alphabetised for readability + future edits.
export const ABBREVIATIONS = [
  ['AVE',      'AVENUE'],
  ['BT',       'BUKIT'],
  ['CL',       'CLOSE'],
  ['CRES',     'CRESCENT'],
  ['CTRL',     'CENTRAL'],
  ['DR',       'DRIVE'],
  ['JLN',      'JALAN'],
  ['KG',       'KAMPONG'],
  ['LOR',      'LORONG'],
  ['MKT',      'MARKET'],
  ['NTH',      'NORTH'],
  ['PK',       'PARK'],
  ['PL',       'PLACE'],
  ['RD',       'ROAD'],
  ['ST',       'STREET'],
  ['STH',      'SOUTH'],
  ['TER',      'TERRACE'],
  ['TG',       'TANJONG'],
  ['UPP',      'UPPER'],
  ["C'WEALTH", 'COMMONWEALTH'],
];

// STREET_EXCEPTIONS — apex-level explicit rewrites applied AFTER the abbreviation
// table on the way in (canonStreet) and BEFORE it on the way out (abbrevStreet).
// Each entry documents: canonical form ↔ HDB abbreviated form. Add here — never
// add a fuzzy rule elsewhere.
//
// Empty for now — the ST-hazard is handled by the regex itself (see canonStreet).
// A separate audit is required before adding here.
export const STREET_EXCEPTIONS = [
  // {canon: 'ST. GEORGE\'S ROAD', hdb: "ST. GEORGE'S RD"},  // handled by ST-hazard, not exception
];

// canonStreet: OneMap spelled-out OR HDB abbreviated  →  canonical (spelled out).
// The ST-hazard (\bST\b vs \bST\.\b): word-boundary treats "ST." as "ST" + "."
// followed by a non-word, so a bare \bST\b would rewrite "ST. GEORGE'S" to
// "STREET. GEORGE'S". Negative lookahead `(?!\.)` blocks that.
export function canonStreet(s) {
  if (!s) return '';
  let out = s.toUpperCase();
  for (const [abbrev, full] of ABBREVIATIONS) {
    const pat = abbrev === 'ST'
      ? new RegExp(`\\bST\\b(?!\\.)`, 'g')                      // ST-hazard fix
      : new RegExp(`\\b${escRe(abbrev)}\\b`, 'g');
    out = out.replace(pat, full);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// abbrevStreet: canonical (spelled out)  →  HDB abbreviated form.
// Applies the reverse table. Never contracts a word that would create a
// collision with a different real street; entries are chosen so they don't.
// Same ST-hazard consideration in reverse: "STREET" → "ST", but "SAINT" (if it
// ever appears) is untouched — we don't have a SAINT rule.
export function abbrevStreet(s) {
  if (!s) return '';
  let out = s.toUpperCase();
  for (const [abbrev, full] of ABBREVIATIONS) {
    out = out.replace(new RegExp(`\\b${escRe(full)}\\b`, 'g'), abbrev);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
