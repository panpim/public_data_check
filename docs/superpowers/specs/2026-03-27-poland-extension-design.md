# Poland Extension Design

**Goal:** Extend the public registry check tool to support Poland (PL) alongside the existing Lithuanian (LT) market, with a mandatory per-user country selection that persists across sessions.

**Architecture:** Country preference stored in DB (cross-device) and mirrored in a cookie (fast middleware enforcement). Same URL structure (`/check`, `/history`) — country context adapts the form and available providers. A new KRZ insolvency provider handles all PL checks.

**Tech Stack:** Next.js App Router, NextAuth, Prisma/SQLite, Playwright, pdf-lib

---

## Section 1: Country Selection Flow & Storage

### Database

Add a `UserPreference` model to `prisma/schema.prisma`:

```prisma
model UserPreference {
  email     String   @id
  country   String   // "LT" | "PL"
  updatedAt DateTime @updatedAt
}
```

Also add a nullable `country` column to `SearchRun`:

```prisma
model SearchRun {
  // ... existing fields ...
  country String? // "LT" | "PL" — null means LT (legacy rows)
}
```

Run `prisma migrate dev --name add_user_preference_and_search_run_country` to apply. No backfill needed — null rows are treated as "LT" at read time.

### API: `/api/user/country`

Both GET and PUT require an authenticated session; return 401 otherwise (same pattern as `/api/checks/run`).

- **GET** — returns `{ country: "LT" | "PL" | null }` for the current user (`null` if no preference stored yet).
- **PUT** — accepts `{ country: "LT" | "PL" }`, saves to `UserPreference` (upsert on email), sets a `country` cookie (1-year expiry, `SameSite=Lax`, `Path=/`, **HttpOnly**), returns `{ country }`.

### Middleware (`src/middleware.ts`)

Protects `/check`, `/history`, and `/select-country`:

1. If not authenticated → redirect to `/api/auth/signin?callbackUrl=...`
2. If authenticated and path is `/select-country` → allow through (the page handles pre-selection)
3. If authenticated but no `country` cookie → redirect to `/select-country`
4. Otherwise → allow through

Uses the `country` cookie for fast enforcement (no DB hit).

### `/select-country` page (client component)

Flow:
1. On mount: call GET `/api/user/country`. Show a loading state while the request is in flight.
2. If a stored country is returned, call PUT `/api/user/country` with that value to re-set the cookie (handles the case where the cookie was cleared but the DB preference still exists).
   - On PUT success → redirect to `/check`.
   - On PUT failure → fall through and show the two selection cards (do not loop; let the user re-select explicitly). Show a dismissable error message: "Could not restore your country preference — please select again."
3. If GET returns `null` (no stored preference), show the two cards: "🇱🇹 Lithuania (LT)" and "🇵🇱 Poland (PL)".
4. On card click: call PUT `/api/user/country`.
   - On success → redirect to `/check`.
   - On failure → show an inline error on the card; do not redirect.

### Nav

Add a small country badge ("LT" or "PL") in the nav bar. The badge is populated by a client-side call to GET `/api/user/country` on mount (since the cookie is HttpOnly and not readable by JS). Clicking it navigates to `/select-country`.

---

## Section 2: Type System Changes (`src/lib/types.ts`)

### `CheckProviderKey`

```typescript
type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax"
  | "krz_insolvency"   // NEW — PL insolvency register
```

### `src/providers/registry.ts`

The existing registry uses `Record<CheckProviderKey, PublicCheckProvider>` which is exhaustive — adding `krz_insolvency` to the type will cause a TypeScript build error until the registry is updated. Add `krz_insolvency: new KrzInsolvencyProvider()` to the registry object when implementing the provider.

### `SearchType`

Replace the existing two-value union with five values:

```typescript
type SearchType =
  | "individual"        // LT: natural person
  | "legal_entity"      // LT: company
  | "pl_company"        // PL/KRZ: Podmiot niebędący osobą fizyczną
  | "pl_business_ind"   // PL/KRZ: Osoba fizyczna prowadząca działalność gospodarczą
  | "pl_private_ind"    // PL/KRZ: Osoba fizyczna nieprowadząca działalności gospodarczej
```

### Provider availability by country

| Provider | LT | PL |
|---|---|---|
| `avnt_insolvency` | ✓ | — |
| `rekvizitai_sme` | ✓ | — |
| `rekvizitai_tax` | ✓ | — |
| `krz_insolvency` | — | ✓ |

---

## Section 3: KRZ Insolvency Provider

### Files

`src/providers/krz-insolvency/`
- `index.ts` — exports `KrzInsolvencyProvider implements PublicCheckProvider`
- `search.ts` — Playwright automation, exports `runKrzSearch`

### Automation flow (`search.ts`)

Base URL: `https://krz.ms.gov.pl`

1. Launch headless Chromium with `locale: "pl-PL"`.
2. Navigate to the KRZ subject search page.
3. Select the entity type matching `input.searchType`:
   - `pl_company` → "Podmiot niebędący osobą fizyczną"
   - `pl_business_ind` → "Osoba fizyczna prowadząca działalność gospodarczą"
   - `pl_private_ind` → "Osoba fizyczna nieprowadząca działalności gospodarczej"
4. Fill the name field with `input.borrowerName`.
5. If `input.idCode` is provided, fill the ID field. KRZ uses a single ID field that accepts KRS, NIP, or PESEL depending on entity type — pass `idCode` as-is; no further splitting.
6. Submit and wait for results.
7. Parse results: count and matched entity names/case numbers from the results table.
8. Take a full-page screenshot.
9. Return `NormalizedCheckResult`.

### Return values

The KRZ provider returns only these `ResultStatus` values (all pre-existing in the type, no new values needed):
- `"no_match"` — zero results found
- `"match_found"` — exactly one result
- `"ambiguous"` — multiple results
- `"error"` — Playwright exception or parse failure

`matchedEntities` is an array of `{ name, caseNumber?, status? }`.

### Error handling

Catch-all: return `status: "error"`, `summaryText: "KRZ search failed: <message>"`, no screenshot.

---

## Section 4: API Changes (`/api/checks/run`)

### `searchType` parsing

Replace the existing two-way coercion:
```typescript
// REMOVE:
const searchType: SearchType = body.searchType === "legal_entity" ? "legal_entity" : "individual";

// REPLACE WITH — validated whitelist of all five values:
const VALID_SEARCH_TYPES: SearchType[] = [
  "individual", "legal_entity", "pl_company", "pl_business_ind", "pl_private_ind"
];
const searchType = VALID_SEARCH_TYPES.includes(body.searchType as SearchType)
  ? (body.searchType as SearchType)
  : null;
if (!searchType) return 400 "Invalid searchType"
```

### Country derivation (single source of truth)

Country is **derived from `searchType`** at the API layer — it is not read from the cookie server-side and not passed as a separate field by the client:
- `pl_company | pl_business_ind | pl_private_ind` → `"PL"`
- `individual | legal_entity` → `"LT"`

This is the single source of truth. The cookie is only used by middleware and the UI — it never reaches the run API. This prevents any inconsistency between the cookie value and the actual check being run.

### Validation passes

Replace the existing rekvizitai-for-individual-only check with a general per-country whitelist:

```
LT_PROVIDERS = { avnt_insolvency, rekvizitai_sme, rekvizitai_tax }
PL_PROVIDERS = { krz_insolvency }

If any providerKey is not in the allowed set for the derived country → 400
```

### `SearchRun.country`

Save the derived country string to `SearchRun.country` on every run.

### `driveFolderUrl`

Remains mandatory for PL runs. PDF generation and Drive upload apply identically to both countries.

---

## Section 5: UI Changes

### `/check/page.tsx`

Read the `country` cookie server-side using `next/headers` cookies(). Pass as a prop:

```tsx
<CheckForm country={country ?? "LT"} />
```

### `CheckForm`

Receives `country: "LT" | "PL"` as a prop.

**LT mode:** Existing form entirely unchanged.

**PL mode:**
- The "Search type" toggle (individual / legal entity) is replaced with a 3-option radio group:
  - "Podmiot (spółka / organizacja)" → `pl_company`
  - "Osoba fizyczna – działalność gospodarcza" → `pl_business_ind`
  - "Osoba fizyczna – bez działalności" → `pl_private_ind`
- The provider checkboxes section shows only `krz_insolvency`, pre-checked and non-removable (only one PL provider exists).
- The `idCode` field label changes to "KRS / NIP / PESEL" for PL.
- All other fields (borrower name, Drive folder URL, run button, results display) are identical.

### `HistoryTable`

Add a `Country` column after the `Date` column, displaying "LT" or "PL" (null rows display "LT"). No filtering by country — all runs remain visible in one table.

---

## Out of Scope

- ZUS / tax checks for PL (disabled — to be added when Polish team confirms the source)
- SME classification for PL
- Per-country filtering in history
- Multiple countries per user account
