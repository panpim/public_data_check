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

Also add a `country` column to `SearchRun` (nullable, for existing rows):

```prisma
model SearchRun {
  // ... existing fields ...
  country String? // "LT" | "PL" — null means LT (legacy rows)
}
```

### API

`/api/user/country` — GET returns `{ country }` for the current user; PUT accepts `{ country: "LT" | "PL" }`, saves to DB, sets a `country` cookie (1-year expiry, `SameSite=Lax`, `Path=/`), returns `{ country }`.

### Middleware (`src/middleware.ts`)

Protects `/check` and `/history`:
1. If not authenticated → redirect to `/api/auth/signin?callbackUrl=...`
2. If authenticated but no `country` cookie → redirect to `/select-country`
3. Otherwise → allow through

Uses the `country` cookie (not a DB hit) for fast enforcement.

### `/select-country` page

- Accessible when logged in
- Two large cards: "🇱🇹 Lithuania (LT)" and "🇵🇱 Poland (PL)"
- On click: calls PUT `/api/user/country`, then redirects to `/check`
- On initial load: calls GET `/api/user/country` to pre-select the current preference if one exists

### Nav

Add a small country badge (e.g., "LT" or "PL") in the nav bar that links to `/select-country`, allowing the user to switch country at any time.

---

## Section 2: Type System Changes

### `src/lib/types.ts`

Extend `CheckProviderKey`:
```typescript
type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax"
  | "krz_insolvency"   // NEW
```

Extend `SearchType`:
```typescript
type SearchType =
  | "individual"       // LT: natural person
  | "legal_entity"     // LT: company
  | "pl_company"       // PL/KRZ: Podmiot niebędący osobą fizyczną
  | "pl_business_ind"  // PL/KRZ: Osoba fizyczna prowadząca działalność gospodarczą
  | "pl_private_ind"   // PL/KRZ: Osoba fizyczna nieprowadząca działalności gospodarczej
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

### Location

`src/providers/krz-insolvency/`
- `index.ts` — exports `KrzInsolvencyProvider implements PublicCheckProvider`
- `search.ts` — Playwright automation

### KRZ automation (`search.ts`)

Base URL: `https://krz.ms.gov.pl`

Flow:
1. Launch Chromium headless, navigate to KRZ search page
2. Select the entity type tab/radio matching `input.searchType`:
   - `pl_company` → "Podmiot niebędący osobą fizyczną"
   - `pl_business_ind` → "Osoba fizyczna prowadząca działalność gospodarczą"
   - `pl_private_ind` → "Osoba fizyczna nieprowadząca działalności gospodarczej"
3. Fill borrower name field; fill KRS/NIP/PESEL field if `input.idCode` provided
4. Submit form and wait for results
5. Parse result count and matched entity names from the results table
6. Take full-page screenshot
7. Return `NormalizedCheckResult` with:
   - `status`: `"no_match"` | `"match_found"` | `"ambiguous"` | `"error"`
   - `providerKey`: `"krz_insolvency"`
   - `matchedEntities`: array of `{ name, caseNumber?, status? }`

### Locale

Playwright context uses `locale: "pl-PL"`.

### Error handling

Same pattern as AVNT: catch-all returns `status: "error"` with the error message as `summaryText`.

---

## Section 4: API Changes

### `/api/checks/run`

Add validation pass for country/provider consistency:
- PL search types (`pl_company`, `pl_business_ind`, `pl_private_ind`) may only be used with `krz_insolvency`
- LT search types (`individual`, `legal_entity`) may not be used with `krz_insolvency`

Add `country` field derivation: infer country from `searchType` (`pl_*` → "PL", otherwise → "LT") and save to `SearchRun.country`.

Remove existing pass that blocks rekvizitai for individual searches — replace with a general per-country provider whitelist check.

---

## Section 5: UI Changes

### `CheckForm`

Receives `country: "LT" | "PL"` as a prop (passed from the server page which reads the cookie).

**LT mode:** Existing form unchanged.

**PL mode:**
- Search type toggle replaced with a 3-option radio group:
  - "Podmiot (spółka / organizacja)" → `pl_company`
  - "Osoba fizyczna – działalność gospodarcza" → `pl_business_ind`
  - "Osoba fizyczna – bez działalności" → `pl_private_ind`
- Provider section shows only `krz_insolvency` (pre-checked, not removable)
- Field labels, placeholders unchanged (borrower name, ID code, Drive folder)

### `HistoryTable`

Add a `Country` column displaying "LT" or "PL" (null rows shown as "LT"). No filtering by country — all runs visible in one table.

### `/check/page.tsx`

Read the `country` cookie server-side and pass as prop to `<CheckForm country={country} />`.

---

## Section 6: Middleware

New file `src/middleware.ts`:

```typescript
export { default } from "next-auth/middleware"

export const config = {
  matcher: ["/check", "/check/:path*", "/history", "/history/:path*"],
}
```

Extended to also redirect to `/select-country` when `country` cookie is absent (after auth check).

---

## Out of Scope

- ZUS / tax checks for PL (disabled — to be added when Polish team confirms the source)
- SME classification for PL
- Per-country filtering in history
- Multiple countries per user account
