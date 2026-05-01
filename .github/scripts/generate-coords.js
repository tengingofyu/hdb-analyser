import fetch from 'node-fetch';
import fs from 'fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 1. No auth needed — /api/common/elastic/search is public ──────────────
async function getOneMapToken() {
  return null; // public endpoint, no token required
}

// ── 2. Fetch dataset from data.gov.sg ─────────────────────────────────────
async function fetchDataset(resourceId, limit = 2000) {
  const url = `https://data.gov.sg/api/action/datastore_search?resource_id=${resourceId}&limit=${limit}`;
  const headers = process.env.DATAGOV_API_KEY ? {'x-api-key': process.env.DATAGOV_API_KEY} : {};
  const r = await fetch(url, {headers});
  const d = await r.json();
  if (!d.result?.records) throw new Error(`Dataset fetch failed for ${resourceId}`);
  console.log(`✓ Fetched ${d.result.records.length} records from ${resourceId}`);
  return d.result.records;
}

// ── 3. Geocode a postal code via OneMap ────────────────────────────────────
async function geocode(postal, token) {
  const url = `https://www.onemap.gov.sg/api/common/elastic/search?searchVal=${postal}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const r = await fetch(url);
  const d = await r.json();
  if (d.results?.length) {
    return [parseFloat(d.results[0].LATITUDE), parseFloat(d.results[0].LONGITUDE)];
  }
  return null;
}

// ── 4. Geocode a batch of {name, postal} entries ───────────────────────────
async function geocodeAll(entries, token, label) {
  // Deduplicate by postal code
  const postalMap = {};
  for (const e of entries) {
    const p = (e.postal || '').toString().padStart(6, '0');
    if (p && p !== '000000') {
      if (!postalMap[p]) postalMap[p] = [];
      postalMap[p].push(e.name);
    }
  }
  const uniquePostals = Object.keys(postalMap);
  console.log(`Geocoding ${uniquePostals.length} unique postal codes for ${label}...`);

  const coordMap = {};
  let done = 0;
  for (const postal of uniquePostals) {
    const coords = await geocode(postal, token);
    if (coords) coordMap[postal] = coords;
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${uniquePostals.length}...`);
    await sleep(150);
  }

  // Build final list
  const result = [];
  for (const [postal, names] of Object.entries(postalMap)) {
    if (coordMap[postal]) {
      for (const name of names) {
        result.push({
          n: name,
          lat: Math.round(coordMap[postal][0] * 100000) / 100000,
          lng: Math.round(coordMap[postal][1] * 100000) / 100000
        });
      }
    }
  }
  console.log(`✓ ${result.length} ${label} geocoded`);
  return result;
}

// ── 5. Build JS constant string ────────────────────────────────────────────
function buildConst(name, entries) {
  const items = entries.map(e => {
    const safeName = e.n.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `  {n:'${safeName}',lat:${e.lat},lng:${e.lng}}`;
  });
  return `const ${name}=[\n${items.join(',\n')}\n];`;
}

// ── 6. Inject into index.html ──────────────────────────────────────────────
function inject(html, constName, newConst) {
  // Match from `const CONSTNAME=[` to the closing `];`
  const regex = new RegExp(`const ${constName}=\\[\\n[\\s\\S]*?\\n\\];`, 'm');
  if (regex.test(html)) {
    return html.replace(regex, newConst);
  }
  throw new Error(`Could not find ${constName} in index.html`);
}

// ── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  const token = await getOneMapToken();

  // Schools
  const schoolRecords = await fetchDataset('d_688b934f82c1059ed0a6993d2a829089');
  const schoolEntries = schoolRecords
    .filter(r => r.mainlevel_code === 'PRIMARY')
    .map(r => ({name: r.school_name, postal: r.postal_code}));
  const schools = await geocodeAll(schoolEntries, token, 'primary schools');

  // Childcare centres
  const ccRecords = await fetchDataset('d_696c994c50745b079b3684f0e90ffc53', 2000);
  const ccEntries = ccRecords
    .map(r => ({name: r.centre_name || r.organisation_name || '', postal: r.postal_code}))
    .filter(r => r.name && r.postal);
  const centres = await geocodeAll(ccEntries, token, 'childcare centres');

  // Update index.html
  let html = fs.readFileSync('index.html', 'utf8');
  html = inject(html, 'PRIMARY_SCHOOLS', buildConst('PRIMARY_SCHOOLS', schools));

  // For childcare - either inject existing or append before PRIMARY_SCHOOLS
  const ccConst = buildConst('CHILDCARE_CENTRES', centres);
  if (/const CHILDCARE_CENTRES=\[/.test(html)) {
    html = inject(html, 'CHILDCARE_CENTRES', ccConst);
  } else {
    html = html.replace('const PRIMARY_SCHOOLS=[', ccConst + '\n' + 'const PRIMARY_SCHOOLS=[');
  }

  fs.writeFileSync('index.html', html);
  console.log('✓ index.html updated');
  console.log(`  Schools: ${schools.length}`);
  console.log(`  Childcare: ${centres.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
