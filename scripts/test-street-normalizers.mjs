// Unit tests for canonStreet / abbrevStreet. One fixture per abbreviation class
// from the work order. Every case round-trips: input HDB → canon → HDB, and
// input OneMap → canon (should hold on either side of the abbrevs table).
//
// Extra fixture: the ST-hazard on "ST. GEORGE'S" — canonStreet must NOT rewrite
// bare "ST." to "STREET." That was the ingest bug that put the two corrupted
// "STREET. GEORGE'S …" keys into PROPERTY_INFO.

import { canonStreet, abbrevStreet, ABBREVIATIONS, CANON_EXCEPTIONS } from './street-normalizers.mjs';

let failed = 0;

function eq(label, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✘'} ${label}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      got     : ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log('=== canonStreet expansion (HDB → canon) ===');
// One case per abbreviation class the work order names, plus a few that appear
// in real HDB data.
const canonCases = [
  ['BT BATOK WEST AVE 6',      'BUKIT BATOK WEST AVENUE 6'],       // BT + AVE
  ['JLN TENTERAM',             'JALAN TENTERAM'],                  // JLN
  ['LOR AH SOO',               'LORONG AH SOO'],                   // LOR
  ['BEDOK NTH ST 2',           'BEDOK NORTH STREET 2'],            // NTH + ST
  ['CLEMENTI STH RD',          'CLEMENTI SOUTH ROAD'],             // STH + RD (synthetic)
  ['UPP CROSS ST',             'UPPER CROSS STREET'],              // UPP
  ["C'WEALTH AVE",             'COMMONWEALTH AVENUE'],             // C'WEALTH
  ['KG BAHRU RD',              'KAMPONG BAHRU ROAD'],              // KG
  ['TG PAGAR PLAZA',           'TANJONG PAGAR PLAZA'],             // TG
  ['BT BATOK CTRL',            'BUKIT BATOK CENTRAL'],             // CTRL
  ['JURONG WEST CTRL 1',       'JURONG WEST CENTRAL 1'],
  ['TAMAN HO SWEE PK',         'TAMAN HO SWEE PARK'],              // PK
  ['MARSILING MKT',            'MARSILING MARKET'],                // MKT
  ['SIMEI TER',                'SIMEI TERRACE'],                   // TER
  ['BUANGKOK CL',              'BUANGKOK CLOSE'],                  // CL
  ['CANBERRA CRES',            'CANBERRA CRESCENT'],               // CRES
  ['CLEMENTI DR',              'CLEMENTI DRIVE'],                  // DR
  ['DELTA PL',                 'DELTA PLACE'],                     // PL
];
for (const [hdb, canon] of canonCases) eq(`${hdb}  →  ${canon}`, canonStreet(hdb), canon);

console.log('\n=== ST-hazard — critical fix ===');
eq('ST. GEORGE\'S RD  →  ST. GEORGE\'S ROAD (ST-before-period stays)',
   canonStreet("ST. GEORGE'S RD"), "ST. GEORGE'S ROAD");
eq("ST. GEORGE'S LANE  →  ST. GEORGE'S LANE (idempotent)",
   canonStreet("ST. GEORGE'S LANE"), "ST. GEORGE'S LANE");
eq('BEDOK NTH ST 2  →  BEDOK NORTH STREET 2 (bare ST DOES fire)',
   canonStreet('BEDOK NTH ST 2'), 'BEDOK NORTH STREET 2');
eq('ANG MO KIO ST 11  →  ANG MO KIO STREET 11',
   canonStreet('ANG MO KIO ST 11'), 'ANG MO KIO STREET 11');

console.log('\n=== abbrevStreet contraction (canon → HDB) ===');
for (const [hdb, canon] of canonCases) eq(`${canon}  →  ${hdb}`, abbrevStreet(canon), hdb);

console.log('\n=== abbrevStreet on ST-hazard case ===');
eq("ST. GEORGE'S ROAD  →  ST. GEORGE'S RD (STREET→ST doesn't touch ST.)",
   abbrevStreet("ST. GEORGE'S ROAD"), "ST. GEORGE'S RD");

console.log('\n=== Round-trip: abbrevStreet(canonStreet(x)) === x  for HDB inputs ===');
for (const [hdb] of canonCases) eq(`${hdb}`, abbrevStreet(canonStreet(hdb)), hdb);
eq("ST. GEORGE'S RD (round-trip)", abbrevStreet(canonStreet("ST. GEORGE'S RD")), "ST. GEORGE'S RD");

console.log('\n=== Round-trip: canonStreet(abbrevStreet(y)) === y  for canon inputs ===');
for (const [, canon] of canonCases) eq(`${canon}`, canonStreet(abbrevStreet(canon)), canon);
eq("ST. GEORGE'S ROAD (round-trip)", canonStreet(abbrevStreet("ST. GEORGE'S ROAD")), "ST. GEORGE'S ROAD");

console.log('\n=== SAINT exception (CANON_EXCEPTIONS[0]) ===');
// OneMap returns "SAINT" (spelled out); HDB and our canonical form use "ST."
eq('canonStreet("SAINT GEORGE\'S LANE") → "ST. GEORGE\'S LANE"',
   canonStreet("SAINT GEORGE'S LANE"), "ST. GEORGE'S LANE");
eq('canonStreet("SAINT GEORGE\'S ROAD") → "ST. GEORGE\'S ROAD"',
   canonStreet("SAINT GEORGE'S ROAD"), "ST. GEORGE'S ROAD");
// OneMap-form → HDB-form via the full canon→abbrev pipeline
eq('canonStreet + abbrevStreet composed on OneMap "SAINT GEORGE\'S ROAD" → HDB "ST. GEORGE\'S RD"',
   abbrevStreet(canonStreet("SAINT GEORGE'S ROAD")), "ST. GEORGE'S RD");
eq('canonStreet + abbrevStreet composed on OneMap "SAINT GEORGE\'S LANE" → HDB "ST. GEORGE\'S LANE"',
   abbrevStreet(canonStreet("SAINT GEORGE'S LANE")), "ST. GEORGE'S LANE");
// Rule-ordering: SAINT output ("ST.") must not be re-hit by the \bST\b(?!\.) rule
eq('SAINT rule output not re-hit by ST rule (idempotent under canon)',
   canonStreet(canonStreet("SAINT GEORGE'S ROAD")), "ST. GEORGE'S ROAD");
// Generic SAINT (not GEORGE'S specifically) still transforms
eq('canonStreet("SAINT MICHAEL\'S ROAD") → "ST. MICHAEL\'S ROAD" (rule is generic)',
   canonStreet("SAINT MICHAEL'S ROAD"), "ST. MICHAEL'S ROAD");

console.log('\n=== Regression: 650118 street name ===');
// OneMap returns "BUKIT BATOK WEST AVENUE 6"; HDB has "BT BATOK WEST AVE 6".
// The gate the field failure would have caught:
eq('OneMap "BUKIT BATOK WEST AVENUE 6"  →  canon idempotent',
   canonStreet('BUKIT BATOK WEST AVENUE 6'), 'BUKIT BATOK WEST AVENUE 6');
eq('canon "BUKIT BATOK WEST AVENUE 6"  →  hdb "BT BATOK WEST AVE 6"',
   abbrevStreet('BUKIT BATOK WEST AVENUE 6'), 'BT BATOK WEST AVE 6');

console.log(`\n${failed === 0 ? '✓ ALL PASS' : `✘ ${failed} FAIL(S)`}`);
process.exit(failed === 0 ? 0 : 1);
