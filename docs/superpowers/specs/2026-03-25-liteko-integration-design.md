# LITEKO Court Case Search — Integration Design

## Overview

Extend the Public Registry Check tool to support a second provider: **LITEKO** (`liteko.teismai.lt`), the Lithuanian court cases public search. Users can now run AVNT insolvency checks, LITEKO court case checks, or both in a single form submission. Both checks share one combined evidence PDF uploaded to Google Drive.

---

## 1. Architecture & Data Model

### Provider key expansion

Add `liteko_court_cases` to the `CheckProviderKey` type alongside the existing `avnt_insolvency`.

### Run grouping

Each form submission generates a `runGroupId` (UUID v4). Every `SearchRun` row written during that submission stores this ID. For a two-provider run, two rows are written — each holding exactly one `providerKey` — and both share the same `runGroupId`. `runGroupId` has no unique constraint.

### Schema migration

The existing `SearchRun` table gains two new columns only — no existing column names are changed:

| New column | Type | Notes |
|---|---|---|
| `runGroupId` | `String @default("")` | Links rows from the same form submission. Legacy rows get `""`. |
| `uploadedFileName` | `String?` | Human-readable PDF filename, stored alongside `uploadedFileId`. |

```prisma
// Add to existing SearchRun model (no other changes):
runGroupId       String   @default("")
uploadedFileName String?
```

### Drive service update

`src/services/drive.ts` currently returns `{ fileId: string, webViewLink: string }`. Update to also return `fileName: string` (the filename argument passed to the upload call, echoed back so the API layer can store it without a second variable):

```typescript
// New return type:
{ fileId: string; webViewLink: string; fileName: string }
```

The API stores: `fileId` → `uploadedFileId`, `webViewLink` → `uploadedFileUrl`, `fileName` → `uploadedFileName`.

---

## 2. Types

Defined in `src/lib/types.ts`. No new files needed.

### `RunCheckInput`

```typescript
interface RunCheckInput {
  providerKeys: string[];
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;  // = session user email
}
```

### `MatchedEntity`

Shared between AVNT and LITEKO. AVNT uses `name`, `caseNumber`, `status`. LITEKO uses all five fields.

```typescript
interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
  date?: string;
  court?: string;
}
```

### `NormalizedCheckResult`

Unchanged from existing definition. Reproduced here for clarity:

```typescript
interface NormalizedCheckResult {
  providerKey: string;
  status: "no_match" | "match_found" | "ambiguous" | "error";
  resultsCount: number;
  summaryText: string;
  matchedEntities: MatchedEntity[];
  screenshotBuffer: Buffer | null;
  sourceUrl: string;
  searchedAt: string; // ISO 8601
}
```

---

## 3. LITEKO Provider

**File:** `src/providers/liteko-court-cases/search.ts`

### Browser mode

Playwright launches **non-headless** (`headless: false`). The search form is pre-filled with borrower name (and `idCode` if provided).

### CAPTCHA handling

After pre-filling the form, the provider must register the navigation wait *before* triggering any action that could cause navigation (to avoid a race condition). Use `Promise.all`:

```typescript
const [response] = await Promise.all([
  page.waitForURL((url) => !url.href.includes("/search"), { timeout: 180_000 }),
  page.click("button[type=submit]"),  // or equivalent submit trigger
]);
```

- On timeout (3 minutes): close browser, return `{ status: "error", summaryText: "CAPTCHA timeout — not solved within 3 minutes", resultsCount: 0, matchedEntities: [], screenshotBuffer: null, ... }`
- On success: scrape results, take full-page screenshot, close browser

### Parsing

Primary signal: extract count from the results page heading (e.g., "Rasta N bylų"). If count > 0 → `match_found`. If count = 0 → `no_match`. If the count element cannot be found → `ambiguous`.

`matchedEntities`: parse visible case rows into `{ name, caseNumber, status, date, court }`.

`screenshotBuffer`: full-page PNG. `null` if no navigation occurred (error/timeout).

---

## 4. API Changes

**Endpoint:** `POST /api/checks/run`

### Auth

Unchanged from existing implementation — 401 if no valid session (handled by existing auth middleware at the start of the route handler).

### Full request body

```typescript
{
  providerKeys: ("avnt_insolvency" | "liteko_court_cases")[];  // replaces single providerKey
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
}
```

Validation:
- `providerKeys` must be a non-empty array of known keys
- After feature-flag stripping, must still be non-empty — otherwise return `400 { error: "No enabled providers selected" }`

### Execution flow

```
1. Auth check (existing middleware — 401 if no session)
2. Validate request body
3. Strip disabled providers (ENABLE_LITEKO=false removes liteko_court_cases)
4. Generate runGroupId (uuid v4)
5. Generate PDF filename: {sanitized_borrower_name}_{date_YYYYMMDD}_evidence.pdf
   where sanitized_borrower_name = borrowerName.replace(/[^a-zA-Z0-9]/g, "_")
6. For each providerKey in providerKeys (sequential, AVNT first if both present):
   a. Run provider search → NormalizedCheckResult
   b. Write SearchRun row:
        { runGroupId, providerKey, borrowerName, borrowerIdCode (=idCode),
          loanReference, driveFolderUrl, createdByEmail (=session email),
          resultStatus (=result.status), resultsCount, matchedSummary (=result.summaryText),
          requestPayloadJson, normalizedResultJson }
      (uploadedFileId / uploadedFileUrl / uploadedFileName left null at this point)
7. Generate combined PDF from all results[] → Buffer
   On failure: set pdfError, skip steps 8–9, go to step 10
8. Upload PDF to Google Drive folder
   On failure: set driveError, skip step 9
9. UPDATE all SearchRun rows WHERE runGroupId = ? SET
        uploadedFileId = fileId, uploadedFileUrl = webViewLink, uploadedFileName = fileName
10. Return 200 response
```

**Partial provider failure:** If one provider returns `status: "error"`, continue to the next provider. Include the error result in `results[]`. PDF generation proceeds with available screenshots — providers with `screenshotBuffer: null` get no screenshot page.

**PDF generation failure:** `pdfError` set in response. No upload attempted. All `SearchRun` rows still written (null `uploadedFileId`). Response 200.

**Drive upload failure:** `driveError` set in response. `SearchRun` rows still written (null `uploadedFileId`). Response 200.

### Response shape

```typescript
{
  runGroupId: string;
  results: {
    providerKey: string;
    status: "no_match" | "match_found" | "ambiguous" | "error";
    resultsCount: number;
    summaryText: string;
  }[];
  driveFileId: string | null;
  driveWebViewLink: string | null;
  driveFileName: string | null;
  driveError?: string;
  pdfError?: string;
}
```

### Feature flag — API side

`ENABLE_LITEKO` env var (`"true"` / `"false"`, default `"false"`). Strip `liteko_court_cases` from `providerKeys` before step 6 when `false`.

### Feature flag — frontend config endpoint

`GET /api/config` — **no auth required** (public feature flag, no sensitive data):

```typescript
// Response:
{ enableLiteko: boolean }
```

### HTTP timeout

A two-provider run may take up to ~3.5 minutes (3-min CAPTCHA wait + ~20s AVNT + overhead). Next.js route handlers have no built-in timeout. When deployed behind a reverse proxy (e.g., nginx), set `proxy_read_timeout 300;`. Document in `.env.example`.

---

## 5. Combined Evidence PDF

**File:** `src/services/evidence.ts`

### Breaking signature change

The existing signature `generateEvidencePdf(input, result, filename)` (single result) is replaced by:

```typescript
export async function generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],  // array, ordered AVNT first
  filename: string
): Promise<Buffer>
```

**All existing call sites in `src/app/api/checks/run/route.ts` must be updated** to pass `results` as an array.

### Page structure

| Scenario | Pages |
|----------|-------|
| AVNT only | Page 1: summary · Page 2: AVNT screenshot (if buffer present) |
| LITEKO only | Page 1: summary · Page 2: LITEKO screenshot (if buffer present) |
| Both | Page 1: summary · Page 2: AVNT screenshot · Page 3: LITEKO screenshot |

Screenshot pages only added when `result.screenshotBuffer !== null`.

### Page 1 — Summary

- Header bar (brand blue): "Public Registry Check — Evidence Report"
- **Run Information**: initiated by, timestamp, checks run (comma-separated provider labels), request ID (`runGroupId` — note: displayed on PDF as "Request ID" for audit trail, maps to `runGroupId` in DB)
- **Search Input**: borrower name, ID code (or "not provided"), loan reference (or "not provided")
- **Results Summary**: one result block per provider, with colour treatment:

| Status | Border/background | Badge text |
|---|---|---|
| `no_match` | Green | NO RECORD FOUND |
| `match_found` | Red | N RECORDS FOUND |
| `ambiguous` | Amber | AMBIGUOUS — MANUAL REVIEW REQUIRED |
| `error` | Grey | TECHNICAL ERROR |

Each block includes summary text and, where applicable, "See screenshot on page N".

- Footer: generated timestamp + "CONFIDENTIAL — INTERNAL USE ONLY"

All user-supplied text passed through existing `sanitizeForPdf()` (Lithuanian character transliteration).

### Pages 2+ — Screenshot pages

One page per provider where `screenshotBuffer !== null`:
- Brand-blue header bar: `{ProviderLabel} — Search Results`
- Source URL line
- Full-page screenshot scaled to fit A4 content area

---

## 6. Frontend Changes

### CheckForm

Replace the registry `<select>` with two checkboxes:

```
☑ AVNT Insolvency Register        Automated · ~20s
☑ LITEKO Court Cases              Requires CAPTCHA · ~2 min
```

- Both checked by default
- Client-side validation: at least one checkbox must be checked
- On mount, fetch `GET /api/config`. If `enableLiteko: false`, do not render the LITEKO checkbox
- Form submits `providerKeys: string[]` (replaces previous single `providerKey`)

### Loading / CAPTCHA wait state

The form submit issues a single `fetch POST /api/checks/run` and awaits the full response. While awaiting:

- If `providerKeys` sent in the request includes `"liteko_court_cases"`:
  Show: **"Running checks… A browser window has opened on this machine — solve the CAPTCHA to continue."** with a spinner
- Otherwise:
  Show: **"Running check…"** with a spinner

### Result display

On success, replace the form with:
1. One `ResultCard` per provider (AVNT first)
   - Provider name, status badge, results count, summary text
   - "View PDF in Drive →" link using `driveWebViewLink`
2. A **Combined Evidence PDF** tile: `driveFileName` + Drive link
3. If `driveError`: show error message in place of Drive links

### History table

Query to build the grouped history view:

```sql
SELECT runGroupId, MIN(createdAt) AS groupCreatedAt
FROM SearchRun
GROUP BY runGroupId
ORDER BY groupCreatedAt DESC
```

For each `runGroupId`, fetch all rows in that group to get per-provider status chips.

**Legacy rows** (`runGroupId = ""`): treat each legacy row as its own single-provider group — query `WHERE runGroupId = "" ORDER BY createdAt DESC` and display individually, not collapsed together.

Display per group row:
- Borrower name (first row in group)
- Date (`groupCreatedAt`)
- Per-provider status chips (one per row in group, ordered AVNT first)
- PDF link from first non-null `uploadedFileUrl` in group

---

## 7. Feature Flag

### `ENABLE_LITEKO` env var

- `"false"` (default): LITEKO checkbox not rendered; API strips `liteko_court_cases` from any request
- `"true"`: LITEKO fully enabled; a visible browser window appears on the server machine when LITEKO runs

Add to `.env.example`:

```
# Set to true to enable LITEKO court case search.
# Requires a visible display (headless: false) — do not enable on headless servers.
# When enabled, set reverse proxy read timeout >= 300s.
ENABLE_LITEKO=false
```

### Versioning

Tag the current working AVNT-only commit as `v1.0` before writing any LITEKO code. This provides a clean rollback point: `git checkout v1.0`.

---

## Out of Scope

- Automatic CAPTCHA solving
- Parallel provider execution
- Per-provider PDFs (single combined PDF only)
- Email/Slack notifications
- Multi-user access control beyond existing Google OAuth
