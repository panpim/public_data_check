# LITEKO Court Case Search — Integration Design

## Overview

Extend the Public Registry Check tool to support a second provider: **LITEKO** (`liteko.teismai.lt`), the Lithuanian court cases public search. Users can now run AVNT insolvency checks, LITEKO court case checks, or both in a single form submission. Both checks share one combined evidence PDF uploaded to Google Drive.

---

## 1. Architecture & Data Model

### Provider key expansion

Add `liteko_court_cases` to the `CheckProviderKey` enum alongside the existing `avnt_insolvency`.

### Run grouping

Each form submission generates a `runGroupId` (UUID). Every `SearchRun` row created during that submission stores this ID. For a two-provider run, two rows share the same `runGroupId`.

**Schema change — `SearchRun` table:**

```prisma
model SearchRun {
  id           String   @id @default(cuid())
  runGroupId   String              // NEW — groups rows from same submission
  providerKey  String
  borrowerName String
  idCode       String?
  loanReference String?
  resultStatus String
  resultsCount Int      @default(0)
  summaryText  String   @default("")
  driveFileId  String?
  driveFileName String?
  initiatedBy  String
  searchedAt   DateTime @default(now())
}
```

`runGroupId` has no unique constraint — multiple rows share the same value within a group.

---

## 2. LITEKO Provider

**File:** `src/providers/liteko-court-cases/search.ts`

### Browser mode

Playwright launches in **non-headless mode** (`headless: false`) — a visible Chromium window appears on the operator's screen. The form is pre-filled with the borrower name (and ID code if provided).

### CAPTCHA handling

The LITEKO search page requires a CAPTCHA. After pre-filling the form:
1. The provider waits for navigation away from the search page (signals CAPTCHA solved + form submitted)
2. Timeout: **3 minutes**. If the user doesn't solve CAPTCHA within 3 minutes, the provider returns `{ status: "error", summaryText: "CAPTCHA timeout" }`
3. After navigation, the provider scrapes results and takes a full-page screenshot

### Result structure

Same `NormalizedCheckResult` shape as AVNT:

```typescript
interface NormalizedCheckResult {
  providerKey: "liteko_court_cases";
  status: "no_match" | "match_found" | "ambiguous" | "error";
  resultsCount: number;
  summaryText: string;
  matchedEntities: MatchedEntity[];
  screenshotBuffer: Buffer | null;
  sourceUrl: string;
  searchedAt: string; // ISO
}
```

### Parsing

Primary signal: extract record count from the results page pagination or count text. If count > 0 → `match_found`. If count = 0 → `no_match`. If count cannot be determined → `ambiguous`.

`matchedEntities`: parse visible case rows — case number, parties, court, date.

---

## 3. API Changes

**Endpoint:** `POST /api/checks/run`

### Request body change

```typescript
// Before
{ providerKey: "avnt_insolvency" | "liteko_court_cases", ... }

// After
{ providerKeys: ("avnt_insolvency" | "liteko_court_cases")[], ... }
```

Validation: `providerKeys` must be a non-empty array containing only valid provider keys.

### Execution flow

```
1. Generate runGroupId
2. For each providerKey in providerKeys (sequential, AVNT first):
   a. Run provider search
   b. Save SearchRun row (with runGroupId)
3. Generate combined PDF (summary page + one screenshot page per provider)
4. Upload combined PDF to Google Drive
5. Update all SearchRun rows in the group with driveFileId / driveFileName
6. Return combined result to client
```

### Response shape

```typescript
{
  runGroupId: string;
  results: {
    providerKey: string;
    status: string;
    resultsCount: number;
    summaryText: string;
  }[];
  driveFileId: string | null;
  driveFileName: string | null;
  driveError?: string;
  pdfError?: string;
}
```

### Feature flag

`ENABLE_LITEKO=true/false` (default `false`). When `false`:
- `liteko_court_cases` is stripped from `providerKeys` before execution
- If `providerKeys` becomes empty after stripping, return 400

---

## 4. Combined Evidence PDF

**File:** `src/services/evidence.ts` — refactored to accept multiple results.

### Page structure

| Scenario | Pages |
|----------|-------|
| AVNT only | Page 1: summary · Page 2: AVNT screenshot |
| LITEKO only | Page 1: summary · Page 2: LITEKO screenshot |
| Both | Page 1: summary · Page 2: AVNT screenshot · Page 3: LITEKO screenshot |

### Page 1 — Summary

- Header bar (brand blue): "Public Registry Check — Evidence Report"
- **Run Information** section: initiated by, timestamp, checks run, request ID
- **Search Input** section: borrower name, ID code (or "not provided")
- **Results Summary** section: one result block per provider
  - Green block (NO RECORD FOUND) or red block (N RECORDS FOUND) with provider name badge
  - Brief summary text + reference to screenshot page number
- Footer: generated timestamp + "CONFIDENTIAL — INTERNAL USE ONLY"

### Pages 2+ — Screenshot pages

One page per provider that has a screenshot:
- Header bar (brand blue): `{ProviderLabel} — Search Results`
- Source URL
- Full-page screenshot scaled to fit A4

### Signature

```typescript
export async function generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],   // array, ordered AVNT first
  filename: string
): Promise<Buffer>
```

---

## 5. Frontend Changes

### CheckForm

- Replace the registry `<select>` dropdown with **two checkboxes**:
  - ☑ AVNT Insolvency Register — `Automated · ~20s`
  - ☑ LITEKO Court Cases — `Requires CAPTCHA · ~2 min`
- Both checked by default
- Validation: at least one checkbox must be checked
- When `ENABLE_LITEKO=false` (returned from a server-side config endpoint or env), the LITEKO checkbox is hidden
- Form submits `providerKeys: string[]`

### CAPTCHA wait state

When LITEKO is in the run and AVNT has finished, the UI shows:
**"Waiting for CAPTCHA… A browser window has opened — solve the CAPTCHA to continue."**
with a spinner. This is driven by a streaming or long-poll response, or simply by the single awaited `fetch` (no intermediate state needed since the API is sequential and the client just waits).

### Result display

- One `ResultCard` per provider, in order (AVNT first)
- Each card: provider name, status badge, results count, summary text, "View PDF in Drive →" link
- Below the cards: a **Combined Evidence PDF** tile with filename and Drive link

### History table

- Group rows by `runGroupId`
- Display as one row per group: borrower name, date, per-provider status chips side by side, one PDF link

---

## 6. Feature Flag & Versioning

### Git tag `v1.0`

Tag the current HEAD commit (AVNT-only, verified working) before any LITEKO code lands:

```bash
git tag v1.0
git push origin v1.0
```

Rollback: `git checkout v1.0`

### `ENABLE_LITEKO` env var

- `false` (default): LITEKO checkbox hidden on form; `liteko_court_cases` rejected by API
- `true`: LITEKO fully enabled; visible browser window will appear when LITEKO is run

Add to `.env.example`:

```
ENABLE_LITEKO=false
```

---

## Out of Scope

- Automatic CAPTCHA solving
- Parallel provider execution
- PDF per-provider (single combined PDF only)
- Email/Slack notifications
- Multi-user access control beyond existing OAuth
