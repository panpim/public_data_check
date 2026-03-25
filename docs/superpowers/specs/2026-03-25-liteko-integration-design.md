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

The existing `SearchRun` table (fields: `id`, `createdAt`, `createdByEmail`, `borrowerName`, `borrowerIdCode`, `loanReference`, `providerKey`, `driveFolderUrl`, `resultStatus`, `resultsCount`, `matchedSummary`, `uploadedFileId`, `uploadedFileUrl`, `requestPayloadJson`, `normalizedResultJson`) gains two new columns only — no renames:

| New column | Type | Purpose |
|---|---|---|
| `runGroupId` | `String` (default `""`) | Links rows from the same form submission |
| `uploadedFileName` | `String?` | Human-readable PDF filename stored alongside `uploadedFileId` |

All existing columns and their names are preserved. Existing rows get `runGroupId = ""`.

```prisma
// Add to existing SearchRun model:
runGroupId      String   @default("")
uploadedFileName String?
```

### Drive service update

`src/services/drive.ts` currently returns `{ fileId: string, webViewLink: string }`. Update it to also return `fileName: string` (the filename passed to the upload call). New return type:

```typescript
{ fileId: string; webViewLink: string; fileName: string }
```

The API stores `fileId` → `uploadedFileId`, `webViewLink` → `uploadedFileUrl`, `fileName` → `uploadedFileName`.

---

## 2. LITEKO Provider

**File:** `src/providers/liteko-court-cases/search.ts`

### Types

`MatchedEntity` (shared with AVNT, defined in `src/lib/types.ts`):

```typescript
interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
  date?: string;
  court?: string;
}
```

LITEKO populates all five fields where available; AVNT uses `name`, `caseNumber`, `status`.

`NormalizedCheckResult` (shared interface, already defined in `src/lib/types.ts`):

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

### Browser mode

Playwright launches **non-headless** (`headless: false`) — a visible Chromium window appears on the operator's machine. The search form is pre-filled with borrower name (and `borrowerIdCode` if provided).

### CAPTCHA handling

After pre-filling the form:
1. The provider calls `page.waitForNavigation({ timeout: 180_000 })` (3-minute timeout). Navigation away from the search page signals CAPTCHA solved and form submitted.
2. On timeout, the browser closes and the provider returns `{ status: "error", summaryText: "CAPTCHA timeout — no response within 3 minutes", resultsCount: 0, matchedEntities: [], screenshotBuffer: null, ... }`.
3. On success, the provider scrapes results, takes a full-page screenshot, then closes the browser.

### Parsing

Primary signal: extract count from the results page heading or pagination (e.g., "Rasta N bylų"). If count > 0 → `match_found`. If count = 0 → `no_match`. If the count element cannot be found → `ambiguous`.

`matchedEntities`: parse visible case rows into `{ name, caseNumber, status, date, court }` from the results table.

`screenshotBuffer`: full-page PNG of the results page. `null` if navigation never occurred (error/timeout).

---

## 3. API Changes

**Endpoint:** `POST /api/checks/run`

### Full request body

```typescript
{
  providerKeys: ("avnt_insolvency" | "liteko_court_cases")[];  // CHANGED: was single providerKey
  borrowerName: string;
  idCode?: string;           // maps to borrowerIdCode in DB
  loanReference?: string;
  driveFolderUrl: string;
}
```

Validation:
- `providerKeys` must be a non-empty array
- Each key must be a known provider key
- After feature-flag filtering (see below), array must still be non-empty — otherwise return `400 { error: "No enabled providers selected" }`

### Execution flow

```
1. Generate runGroupId (uuid v4)
2. For each providerKey in providerKeys — sequential, AVNT first if both present:
   a. Run provider search → NormalizedCheckResult
   b. Write SearchRun row:
        runGroupId, providerKey, borrowerName, borrowerIdCode (=idCode),
        loanReference, driveFolderUrl, createdByEmail, resultStatus (=result.status),
        resultsCount, matchedSummary (=result.summaryText),
        requestPayloadJson, normalizedResultJson
      (uploadedFileId / uploadedFileUrl / uploadedFileName filled in step 5)
3. Collect all results[]
4. Generate combined PDF from all results → Buffer  (on failure: set pdfError, skip upload, go to step 6)
5. Upload PDF to driveFolderUrl → { fileId, webViewLink, fileName }  (on failure: set driveError, skip DB update)
6. If upload succeeded: UPDATE all SearchRun rows WHERE runGroupId=? SET uploadedFileId, uploadedFileUrl, uploadedFileName
7. Return response (always 200 unless request validation fails)
```

**Partial provider failure:** If one provider returns `status: "error"`, execution continues to the next provider. The error result is included in `results[]`. PDF generation proceeds with whatever screenshots are available (`screenshotBuffer: null` entries are skipped — no screenshot page added for that provider).

**PDF generation failure:** `pdfError` is set in the response. No upload is attempted. `SearchRun` rows are still written (with null `uploadedFileId`). Response is still 200.

**Drive upload failure:** `driveError` is set in the response. `SearchRun` rows are still written (with null `uploadedFileId`). Response is still 200.

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
  driveFileId: string | null;       // uploadedFileId
  driveWebViewLink: string | null;  // uploadedFileUrl (for Drive "Open" link)
  driveFileName: string | null;     // uploadedFileName (display name)
  driveError?: string;
  pdfError?: string;
}
```

### Feature flag — server side

`ENABLE_LITEKO` env var (`"true"` / `"false"`, default `"false"`). When `false`, `liteko_court_cases` is stripped from `providerKeys` before execution begins.

### Feature flag — frontend config endpoint

`GET /api/config` — unauthenticated, returns feature flags for the UI:

```typescript
// Response:
{ enableLiteko: boolean }
```

The CheckForm client component fetches this on mount to determine whether to render the LITEKO checkbox.

### HTTP timeout

LITEKO has a 3-minute CAPTCHA timeout at the provider level. A two-provider run may take up to ~3.5 minutes. The Next.js route handler has no built-in timeout. If deployed behind a reverse proxy (e.g., nginx), `proxy_read_timeout` must be set to at least `300s`. Document this requirement in `.env.example` comments.

---

## 4. Combined Evidence PDF

**File:** `src/services/evidence.ts` — signature updated to accept multiple results.

### New signature

```typescript
export async function generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],  // ordered AVNT first
  filename: string
): Promise<Buffer>
```

### Page structure

| Scenario | Pages |
|----------|-------|
| AVNT only | Page 1: summary · Page 2: AVNT screenshot (if available) |
| LITEKO only | Page 1: summary · Page 2: LITEKO screenshot (if available) |
| Both | Page 1: summary · Page 2: AVNT screenshot (if available) · Page 3: LITEKO screenshot (if available) |

Screenshot pages are only added when `result.screenshotBuffer !== null`.

### Page 1 — Summary

- Header bar (brand blue): "Public Registry Check — Evidence Report"
- **Run Information**: initiated by (`createdByEmail`), timestamp, checks run (comma-separated provider labels), request ID (`runGroupId`)
- **Search Input**: borrower name, ID code (or "not provided"), loan reference (or "not provided")
- **Results Summary**: one result block per provider
  - `no_match`: green border/background, "NO RECORD FOUND" badge
  - `match_found`: red border/background, "N RECORDS FOUND" badge
  - `error`: grey border, "TECHNICAL ERROR" badge
  - Each block includes the summary text and, where applicable, "See screenshot on page N"
- Footer: generated timestamp + "CONFIDENTIAL — INTERNAL USE ONLY"

All user-supplied text passed through existing `sanitizeForPdf()` (Lithuanian transliteration).

### Pages 2+ — Screenshot pages

One page per provider where `screenshotBuffer !== null`:
- Header bar (brand blue): `{ProviderLabel} — Search Results`
- Source URL line
- Full-page screenshot scaled to fit A4 content area

---

## 5. Frontend Changes

### CheckForm

Replace the registry `<select>` with two checkboxes:

```
☑ AVNT Insolvency Register        Automated · ~20s
☑ LITEKO Court Cases              Requires CAPTCHA · ~2 min
```

- Both checked by default
- Client-side validation: at least one checkbox must be checked before submit
- On mount, fetch `GET /api/config`. If `enableLiteko: false`, hide the LITEKO checkbox entirely (do not render it)
- Form submits `providerKeys: string[]` (replacing the previous `providerKey` string field)

### CAPTCHA wait state

The form submit sends a single `fetch` to `POST /api/checks/run` and awaits the response (which may take up to ~3.5 minutes). While awaiting:

- A loading state is shown: **"Running checks… If LITEKO was selected, a browser window has opened on this machine — solve the CAPTCHA to continue."**
- No streaming or polling is used — the client simply waits for the single HTTP response

This is only shown when LITEKO is in the selected providers.

### Result display

On success, replace the form with:
1. One `ResultCard` per provider (in order: AVNT first)
   - Provider name, status badge, results count, summary text
   - "View PDF in Drive →" link (using `driveWebViewLink`)
2. A **Combined Evidence PDF** tile below the cards: filename (`driveFileName`) + Drive link
3. On `driveError`: show error message instead of Drive links

### History table

The history API (`GET /api/checks/history`) query logic:

```sql
SELECT DISTINCT runGroupId FROM SearchRun ORDER BY createdAt DESC
-- For each runGroupId, fetch all rows in that group
```

Display one table row per `runGroupId`:
- Borrower name (same across all rows in group — use first row's value)
- Date (first row's `createdAt`)
- Per-provider status chips, one per row in group (ordered AVNT first)
- PDF link from `uploadedFileUrl` (same across rows in group — use first non-null value)

---

## 6. Feature Flag

### `ENABLE_LITEKO` env var

- `"false"` (default): LITEKO checkbox hidden on the form; API strips `liteko_court_cases` from any request
- `"true"`: LITEKO fully enabled; a visible browser window appears on the server machine when LITEKO runs

Add to `.env.example`:

```
# Set to true to enable LITEKO court case search
# Note: requires a visible display — not suitable for headless server deployment
# Reverse proxy read timeout must be >= 300s when LITEKO is enabled
ENABLE_LITEKO=false
```

### Versioning

Before any LITEKO code is written, tag the current working AVNT-only commit as `v1.0`. This provides a clean rollback point.

---

## Out of Scope

- Automatic CAPTCHA solving
- Parallel provider execution
- Per-provider PDFs (single combined PDF only)
- Email/Slack notifications
- Multi-user access control beyond existing Google OAuth
