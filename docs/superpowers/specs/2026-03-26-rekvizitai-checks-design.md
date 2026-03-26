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
- The result area below the form renders one `ResultCard` per provider result, in the order they are returned.

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
  | "ambiguous"      // multiple results, manual review needed (orange)
  | "error"          // search failed (grey)
  | "qualified"      // SME: qualifies as SME or Small Mid-Cap (green)
  | "not_qualified"  // SME: does not meet SME or Small Mid-Cap criteria (red)
  | "compliant"      // Tax: no VMI or Sodra debt (green)
  | "non_compliant"; // Tax: VMI or Sodra debt present (red)
```

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
  employeesCount?: number;
  annualRevenue?: number;  // EUR
}

export interface TaxComplianceData {
  hasVmiDebt: boolean;
  hasSodraDebt: boolean;
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

- Launches a Playwright browser page.
- Navigates to `https://rekvizitai.vz.lt/`.
- Searches by ID code if provided, otherwise by borrower name.
- If exactly one result is found, clicks through to the company profile page and returns the page object.
- If zero or multiple ambiguous results are found, throws an error with a descriptive message (which the provider catches and maps to `status: "error"`).

### Provider 1 — `rekvizitai_sme` (`src/providers/rekvizitai-sme/`)

Reads from the company profile page:
- Employee count
- Annual revenue (EUR)

Classification logic:
- **SME:** employees < 250 AND revenue ≤ €50M → `qualified`, category `"sme"`
- **Small Mid-Cap:** employees < 500 AND revenue ≤ €100M (but does not meet SME thresholds) → `qualified`, category `"small_mid_cap"`
- **Neither:** exceeds both thresholds → `not_qualified`, category `"neither"`
- **Data missing / unparseable:** → `qualified`, category `"unknown"` (conservative — do not penalise if data is not published)

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
1. Validate auth and inputs; require at least one valid `providerKey`.
2. Reject Rekvizitai providers if `searchType === "individual"` (server-side guard).
3. Generate a `runGroupId` (cuid).
4. Run all selected providers in parallel (`Promise.all`).
5. Generate one combined PDF from all results.
6. Upload the PDF to Drive once.
7. Save one `SearchRun` row per provider, all sharing the same `runGroupId` and `uploadedFileUrl`.
8. Return an array of per-provider results.

### Response body
```json
{
  "runGroupId": "clx...",
  "results": [
    { "providerKey": "avnt_insolvency", "status": "no_match", "summaryText": "..." },
    { "providerKey": "rekvizitai_sme",  "status": "qualified",  "summaryText": "..." },
    { "providerKey": "rekvizitai_tax",  "status": "compliant",  "summaryText": "..." }
  ],
  "driveUrl": "https://drive.google.com/...",
  "driveError": null
}
```

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

### Page structure

**Page 1 — Cover / Run Summary**
- Header: "Public Registry Check — Evidence Report"
- Run info: borrower name, ID code, search type, initiated by, run group ID, timestamp
- Table with one row per provider: provider name, status badge, summary text

**Pages 2+ — One detail section per provider** (order: AVNT → SME → Tax)
- Provider name + status badge
- AVNT: matched entities table (unchanged from current layout)
- SME: employees count, revenue, classification category
- Tax: VMI debt status + amount, Sodra debt status + amount

**Final pages — Screenshots**
One full-page screenshot page per provider that returned a screenshot, labelled with the provider name.

### Color mapping for new statuses
| Status | Color |
|---|---|
| `qualified` | GREEN |
| `not_qualified` | RED |
| `compliant` | GREEN |
| `non_compliant` | RED |
