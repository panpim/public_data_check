# Rekvizitai Checks Integration Design

## Goal

Add two Playwright-based checks sourced from rekvizitai.vz.lt: SME / Small Mid-Cap classification and tax & social security compliance (VMI + Sodra debt). Both checks apply to legal entities only. All selected checks run in parallel and produce one combined PDF uploaded to Google Drive.

## Architecture

The existing single-provider pipeline is extended to a multi-provider pipeline. A single form submission selects one or more providers; the API runs them in parallel, generates one combined PDF, uploads it once, and saves one `SearchRun` row per provider linked by a shared `runGroupId`.

## Tech Stack

Next.js 16 App Router, Prisma 7.5 SQLite, Playwright (headless Chromium), pdf-lib, next-auth v4, googleapis.

---

## Section 1 — UI (CheckForm)

- **Search type toggle** at the top of the form: `Individual` (default) | `Legal entity`.
- **Provider checkboxes** replace the current Registry dropdown:
  - ☑ AVNT Insolvency Register — always available, checked by default
  - ☐ SME / Small Mid-Cap classification — Legal entity only; disabled and unchecked when Individual is selected
  - ☐ Tax & social security compliance — Legal entity only; disabled and unchecked when Individual is selected
- When switching to Legal entity, both Rekvizitai checkboxes become enabled and checked by default.
- Borrower Name, ID Code (optional), and Google Drive Folder URL fields are unchanged.
- The submit button sends `providerKeys: string[]` (selected providers) and `searchType` to the API.
- The result area below the form renders one `ResultCard` per provider result, in the same order as `providerKeys` in the request (i.e. AVNT first, then SME, then Tax if all three are selected). This order is preserved because `Promise.all` preserves input order.

---

## Section 2 — Type System

### `CheckProviderKey`
```typescript
export type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax";
```

### `SearchType`
```typescript
export type SearchType = "individual" | "legal_entity";
```

### `ResultStatus`
```typescript
export type ResultStatus =
  | "no_match"       // AVNT: no insolvency record found (green)
  | "match_found"    // AVNT: insolvency record found (red)
  | "ambiguous"      // AVNT only: multiple records returned, manual review needed (orange)
  | "error"          // any provider: search failed or navigation error (grey)
  | "qualified"      // rekvizitai_sme: qualifies as SME or Small Mid-Cap (green)
  | "not_qualified"  // rekvizitai_sme: does not meet SME or Small Mid-Cap criteria (red)
  | "compliant"      // rekvizitai_tax: no VMI or Sodra debt (green)
  | "non_compliant"; // rekvizitai_tax: VMI or Sodra debt present (red)
```
`"ambiguous"` is only produced by the AVNT provider. Rekvizitai providers never return `"ambiguous"` — when multiple search results are found on rekvizitai.vz.lt, the provider returns `"error"` instead.

### `RunCheckInput`
```typescript
export interface RunCheckInput {
  borrowerName: string;
  idCode?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;
  searchType: SearchType;
  providerKeys: CheckProviderKey[];  // replaces providerKey
}
```

### `SmeClassification` and `TaxComplianceData` (new)
```typescript
export interface SmeClassification {
  category: "sme" | "small_mid_cap" | "neither" | "unknown";
  employeesCount?: number;  // undefined if not published on Rekvizitai
  annualRevenue?: number;   // EUR; undefined if not published on Rekvizitai
}

export interface TaxComplianceData {
  hasVmiDebt: boolean;
  hasSodraDebt: boolean;
  // Present only when the corresponding debt flag is true AND an amount is shown on the page.
  // undefined when hasVmiDebt/hasSodraDebt is false, or when the site shows debt exists but
  // does not publish an amount (in that case the flag is true and the amount field is undefined).
  vmiDebtAmount?: string;
  sodraDebtAmount?: string;
}
```

### `NormalizedCheckResult` additions
```typescript
export interface NormalizedCheckResult {
  // existing fields unchanged
  classification?: SmeClassification;  // rekvizitai_sme only
  complianceData?: TaxComplianceData;  // rekvizitai_tax only
}
```

---

## Section 3 — Rekvizitai Providers

### Shared navigation utility: `src/providers/rekvizitai/navigate.ts`

`navigate.ts` exports a single async function: `navigateToCompanyProfile(page: Page, borrowerName: string, idCode?: string): Promise<void>`.

Each provider is responsible for launching its own Playwright browser and creating its own page. The provider passes its page to `navigateToCompanyProfile`, which fills in the page but does not open or close the browser. The provider must close the browser in a `finally` block.

`navigateToCompanyProfile`:
- Navigates to `https://rekvizitai.vz.lt/`.
- Searches by ID code if provided, otherwise by borrower name.
- If exactly one result is found, clicks through to the company profile page.
- If zero or multiple ambiguous results are found, throws a standard `Error` with a descriptive message (e.g. "No company found" or "Multiple results — provide ID code to narrow search"). The calling provider catches this, returns `status: "error"` with the error message in `summaryText`, and returns no screenshot (`screenshotBuffer` is undefined).

### Provider 1 — `rekvizitai_sme` (`src/providers/rekvizitai-sme/`)

Reads from the company profile page:
- Employee count
- Annual revenue (EUR)

Classification logic — evaluated in this exact order:
1. **Data missing / unparseable (either field):** If `employeesCount` or `annualRevenue` cannot be read or parsed, return immediately with `qualified`, category `"unknown"` (conservative business rule — do not penalise if data is not published). Do not attempt tier classification. The `summaryText` must explicitly state which data was unavailable. The PDF detail section renders "N/A" for missing fields.
2. **SME:** employees < 250 AND revenue ≤ €50M → `qualified`, category `"sme"`
3. **Small Mid-Cap:** employees < 500 AND revenue ≤ €100M → `qualified`, category `"small_mid_cap"`
4. **Neither:** does not fully satisfy either tier → `not_qualified`, category `"neither"`

Both conditions of a tier must be satisfied simultaneously. If only one condition of a tier is met (and data is present), fall through to the next tier.

Takes a full-page screenshot before returning.

### Provider 2 — `rekvizitai_tax` (`src/providers/rekvizitai-tax/`)

Reads the VMI and Sodra debt section of the company profile page:
- `hasVmiDebt: boolean`
- `hasSodraDebt: boolean`
- Debt amounts if shown

Result:
- No VMI and no Sodra debt → `compliant`
- Any debt present → `non_compliant`

Takes a full-page screenshot before returning.

Both providers implement `PublicCheckProvider` and are registered in `src/providers/registry.ts`.

**Scope note:** The AVNT provider (`src/providers/avnt-insolvency/`) is **not modified** by this change. It does not use `navigateToCompanyProfile`. AVNT is valid for both `searchType` values (`"individual"` and `"legal_entity"`) — `searchType` is passed through in `RunCheckInput` but the AVNT provider ignores it. The `"ambiguous"` status is produced only by the AVNT provider and is not a concern for Rekvizitai providers.

---

## Section 4 — API Route & Database

### DB schema changes

Two new nullable columns on `SearchRun`:
```prisma
runGroupId  String?   // links all providers from the same form submission
searchType  String?   // "individual" | "legal_entity"
```

Requires `npx prisma migrate dev`.

### `POST /api/checks/run` — updated request body
```json
{
  "borrowerName": "UAB Pavyzdys",
  "idCode": "123456789",
  "driveFolderUrl": "https://drive.google.com/drive/folders/...",
  "searchType": "legal_entity",
  "providerKeys": ["avnt_insolvency", "rekvizitai_sme", "rekvizitai_tax"]
}
```

### Execution flow
1. Validate auth and inputs. Any unrecognised value in `providerKeys` causes an immediate HTTP 400. An empty `providerKeys` array also causes HTTP 400. All keys must be recognised `CheckProviderKey` values.
2. If `searchType === "individual"` and any Rekvizitai provider is in `providerKeys`, return HTTP 400 immediately — do not strip and continue.
3. Generate a `runGroupId` (cuid).
4. Run all selected providers in parallel (`Promise.all`). Individual provider errors do not abort the others — each provider catches its own errors and returns `status: "error"`.
5. Generate one combined PDF from all results, including errored providers (see Section 5 for error rendering).
6. Upload the PDF to Drive once. If the upload fails, continue — save `SearchRun` rows without `uploadedFileUrl` and return `driveError` in the response.
7. Save one `SearchRun` row per provider, all sharing the same `runGroupId`. All rows store the same `uploadedFileUrl` (or null if upload failed).
8. Return an array of per-provider results in the same order as the input `providerKeys`.

### `RunCheckInput` field usage in `generateEvidencePdf`
Fields used: `borrowerName`, `idCode`, `searchType`, `initiatedByEmail`. Fields not used in PDF rendering: `driveFolderUrl`, `providerKeys`.

### Backward compatibility
`providerKey` (singular) is renamed to `providerKeys` (array) in `RunCheckInput`. This is an internal interface — all consumers (`route.ts`, `evidence.ts`, providers) are updated in the same change. There are no external API clients. Existing `SearchRun` DB rows retain `null` for `runGroupId` and `searchType` (both nullable for this reason).

### Response body
Each element in `results` includes the full `NormalizedCheckResult` for that provider (including `classification` for `rekvizitai_sme` and `complianceData` for `rekvizitai_tax`), so the frontend `ResultCard` can display structured data rather than only `summaryText`.

```json
{
  "runGroupId": "clx...",
  "results": [
    {
      "providerKey": "avnt_insolvency",
      "status": "no_match",
      "summaryText": "...",
      "resultsCount": 0,
      "matchedEntities": []
    },
    {
      "providerKey": "rekvizitai_sme",
      "status": "qualified",
      "summaryText": "...",
      "classification": { "category": "sme", "employeesCount": 45, "annualRevenue": 3200000 }
    },
    {
      "providerKey": "rekvizitai_tax",
      "status": "compliant",
      "summaryText": "...",
      "complianceData": { "hasVmiDebt": false, "hasSodraDebt": false }
    }
  ],
  "driveUrl": "https://drive.google.com/...",
  "driveError": null
}
```

The `uploadedFileUrl` field on `SearchRun` (existing field, no rename needed) stores the Drive URL per row. If Drive upload fails, all rows in the group are saved with `uploadedFileUrl: null` and `driveError` is set in the response. Retry and partial-failure recovery are out of scope — each run is atomic from the user's perspective. If a DB write fails mid-loop, the route returns HTTP 500 and the partial rows (if any) remain in the DB without a runGroupId constraint enforcing consistency; this is acceptable given SQLite's low-concurrency environment.

---

## Section 5 — Combined PDF Layout

### Function signature
```typescript
generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],
  filename: string
): Promise<Buffer>
```

The `filename` is constructed by the API route caller using the pattern:
`{sanitized-borrower-name}-{YYYY-MM-DD}-{first-8-chars-of-runGroupId}.pdf`
where sanitized borrower name replaces spaces with hyphens and removes characters not safe for filenames. Example: `uab-pavyzdys-2026-03-26-clx1a2b3.pdf`.
The existing filename construction logic in `route.ts` is extended to use `runGroupId` instead of a per-provider run ID.

### Page structure

**Page 1 — Cover / Run Summary**
- Header: "Public Registry Check — Evidence Report"
- Run info: borrower name, ID code, search type, initiated by, run group ID, timestamp
- Table with one row per provider: provider name, status badge, summary text

**Pages 2+ — One detail section per provider** (order follows `providerKeys` input order, matching the UI card order)
- Provider name + status badge
- AVNT: matched entities table (unchanged from current layout)
- SME: employees count, revenue, classification category
- Tax: VMI debt status + amount, Sodra debt status + amount

**Final pages — Screenshots**
All screenshot pages are grouped at the end of the PDF, after all detail sections. One screenshot page per provider that returned a non-null `screenshotBuffer`, labelled with the provider name. Providers that errored before reaching a page (and thus have no screenshot) are skipped — no blank page is inserted.

**Error rendering in provider detail sections**
If a provider returns `status: "error"`, its detail section shows: provider name, grey "ERROR" badge, and the `summaryText` error message. No entity table, classification data, or debt data is rendered for that provider.

**`"unknown"` category badge**
When `rekvizitai_sme` returns `status: "qualified"` with `category: "unknown"`, the cover summary table shows a GREEN "QUALIFIED" badge (intentional — conservative business rule). The `summaryText` explains that classification data was unavailable. No additional visual qualifier is added to the badge itself.

### Color mapping for new statuses
| Status | Color |
|---|---|
| `qualified` | GREEN |
| `not_qualified` | RED |
| `compliant` | GREEN |
| `non_compliant` | RED |
