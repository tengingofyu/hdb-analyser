# Analytics setup (Google Sheets + Apps Script)

The HDB Analyser fires fire-and-forget POSTs for three event types — `search`, `tab`, `error`. This guide gets you a private endpoint that appends each event to a Google Sheet you control. No third-party trackers, no cookies, no IPs logged.

The endpoint costs nothing (Apps Script free tier) and stays inside your Google account.

## 1. Create the sheet

1. Go to https://sheets.new (or Google Drive → New → Google Sheet).
2. Name it something like `hdb-analyser-analytics`.
3. Leave it empty — the script auto-creates the `search`, `tab`, and `error` tabs on the first event.

## 2. Open the script editor

In the sheet, click **Extensions → Apps Script**. A new tab opens with a code editor. Delete the placeholder `function myFunction()` and paste in the entire block from the next section.

## 3. Paste this Apps Script

```javascript
// ──────────────────────────────────────────────────────────────
// HDB Analyser — analytics endpoint
// Receives JSON POSTs, validates event shape, appends to a sheet
// per event type. Always returns 200 so a misbehaving client
// can't see error info; malformed events are silently dropped.
// ──────────────────────────────────────────────────────────────

const SCHEMAS = {
  search: ['ts', 'postal_2', 'flat_type', 'floor_entered', 'months_back',
           'result_tier', 'result_count', 'estimation_method',
           'is_returning', 'session_id'],
  tab:    ['ts', 'session_id', 'tab', 'dwell_seconds'],
  error:  ['ts', 'postal_2', 'flat_type', 'error_type'],
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const type = body.event_type;
    const schema = SCHEMAS[type];
    if (!schema) return ok();              // unknown event_type → drop
    if (!validate(body, schema)) return ok(); // bad shape → drop

    const lock = LockService.getScriptLock();
    lock.tryLock(5000);
    try {
      const sheet = getOrCreateSheet(type, schema);
      sheet.appendRow(schema.map(k => sanitize(body[k])));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    // swallow — never expose internals to caller
  }
  return ok();
}

function doGet() {
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function validate(body, schema) {
  for (const k of schema) {
    if (!(k in body)) return false;
    const v = body[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') return false;            // no nested objects
    const s = String(v);
    if (s.length > 200) return false;                   // length cap
  }
  if ('postal_2' in body && body.postal_2 != null) {
    const p = String(body.postal_2);
    if (!/^\d{2}$/.test(p)) return false;               // exactly 2 digits
  }
  if ('session_id' in body && body.session_id != null) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(body.session_id))) return false;
  }
  return true;
}

function sanitize(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;             // formula-injection guard
}

function getOrCreateSheet(name, schema) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(schema);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ok() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Save with **Ctrl/Cmd + S**. Name the project anything (e.g. `hdb-analytics`).

## 4. Deploy as a web app

1. Click **Deploy → New deployment**.
2. Click the gear icon next to **Select type** → **Web app**.
3. Configure:
   - **Description:** `analytics v1` (any label is fine)
   - **Execute as:** `Me (your-email@gmail.com)`
   - **Who has access:** `Anyone` ← required so the browser POST works without auth
4. Click **Deploy**.
5. The first deploy will ask for permissions — grant them. Google will warn that the app is unverified; click **Advanced → Go to <project> (unsafe)**. This is normal for personal scripts.
6. Copy the **Web app URL**. It looks like:
   ```
   https://script.google.com/macros/s/AKfycby...........XXX/exec
   ```

Keep this URL — you'll paste it in step 6.

## 5. Verify the endpoint

Open the URL in a browser. You should see plain text `ok`. If you see an error, the deployment is misconfigured (most likely access is set to "Only myself" — re-deploy with "Anyone").

## 6. Wire it into the app

Open `index.html`, find the line:

```js
const ANALYTICS_URL='';
```

Paste your URL between the quotes:

```js
const ANALYTICS_URL='https://script.google.com/macros/s/AKfycby......XXX/exec';
```

Commit + push. The site will start logging events.

If `ANALYTICS_URL` is left empty, all logging is silently no-ops — no errors, no slow-downs.

## What gets logged

### `search` (one row per completed analysis)
| Field | Example |
|---|---|
| ts | `2026-05-03T11:42:18.901Z` |
| postal_2 | `12` (first 2 digits only) |
| flat_type | `4 ROOM` |
| floor_entered | `true` |
| months_back | `12` |
| result_tier | `1` (1=same block, 6=town fallback, null=no comps) |
| result_count | `7` |
| estimation_method | `regression` / `band` / `fallback` / `estimate` / `null` |
| is_returning | `true` (localStorage flag) |
| session_id | random per page-load |

### `tab` (one row per tab leave / page hide)
| Field | Example |
|---|---|
| ts | `2026-05-03T11:43:02.150Z` |
| session_id | same per page-load |
| tab | `price` / `amenities` / `value` |
| dwell_seconds | `44` |

### `error` (one row per known failure)
| Field | Example |
|---|---|
| ts | `2026-05-03T11:42:00.000Z` |
| postal_2 | `12` (or null) |
| flat_type | `4 ROOM` (or null) |
| error_type | `postal_not_found` / `connection_error` / `session_cap_hit` |

## What is **not** logged

- Full postal codes (only first 2 digits)
- Asking prices entered by the user
- IP addresses (Apps Script `doPost` doesn't expose them)
- User-agent strings
- Cookies or persistent identifiers (session_id is random per page-load and lives only in memory)

## Updating the script later

If you change `SCHEMAS` or any logic in the Apps Script, you must **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. Otherwise the live URL keeps serving the old code. Don't create a new deployment — that gives you a fresh URL and you'd have to update `index.html` again.

## Troubleshooting

- **Spreadsheet doesn't get rows:** check Apps Script execution log (View → Executions). Common causes: schema mismatch (check the field names match `SCHEMAS` exactly), or the `ANALYTICS_URL` in `index.html` still points to a stale deployment.
- **Browser console shows CORS errors:** ignore them. `sendBeacon` and `fetch keepalive` POSTs don't read responses, so CORS doesn't apply. Rows still appear in the sheet.
- **Sheet fills with junk rows:** the validation should drop malformed events. If you're seeing junk anyway, check that you redeployed the latest version of the script.
