# Rekvizitai Checks Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SME/Small Mid-Cap classification and Tax/Sodra compliance checks via rekvizitai.vz.lt, running in parallel with AVNT and producing one combined PDF.

**Architecture:** Extend the single-provider pipeline to multi-provider: the API accepts `providerKeys[]`, runs all providers in parallel via `Promise.all`, generates one combined PDF, and saves one `SearchRun` row per provider linked by a shared `runGroupId`. Two new Playwright providers share a navigation utility for rekvizitai.vz.lt.

**Tech Stack:** Next.js 16 App Router, Prisma 7.5 SQLite, Playwright (headless Chromium), pdf-lib, next-auth v4, Vitest, TypeScript.

---

## File Structure

**Created:**
- `src/providers/rekvizitai/navigate.ts` — shared navigation utility (navigateToCompanyProfile)
- `src/providers/rekvizitai-sme/index.ts` — SME provider class (thin wrapper)
- `src/providers/rekvizitai-sme/search.ts` — SME scraping, classification logic, exported classifySme (testable pure fn)
- `src/providers/rekvizitai-tax/index.ts` — Tax provider class (thin wrapper)
- `src/providers/rekvizitai-tax/search.ts` — Tax scraping, debt parsing, exported parseTaxCompliance (testable pure fn)
- `tests/providers/rekvizitai-sme.test.ts` — unit tests for classifySme (pure function, no browser)
- `tests/providers/rekvizitai-tax.test.ts` — unit tests for parseTaxCompliance (pure function, no browser)

**Modified:**
- `src/lib/types.ts` — new types (CheckProviderKey, SearchType, ResultStatus, SmeClassification, TaxComplianceData, RunCheckInput, NormalizedCheckResult)
- `prisma/schema.prisma` — add runGroupId, searchType columns
- `src/providers/registry.ts` — register new providers
- `src/app/api/checks/run/route.ts` — multi-provider pipeline
- `src/services/evidence.ts` — combined multi-result PDF
- `src/components/ResultCard.tsx` — new status badges
- `src/components/CheckForm.tsx` — search type toggle, checkboxes, multi-result display
- `tests/api/checks-run.test.ts` — update + add new tests

---

## Chunk 1: Types and DB Schema

### Task 1: Update Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Replace the contents of `src/lib/types.ts`**

```typescript
import type { DefaultSession } from "next-auth";

export type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax";

export type SearchType = "individual" | "legal_entity";

export type ResultStatus =
  | "no_match"       // AVNT: no insolvency record found (green)
  | "match_found"    // AVNT: insolvency record found (red)
  | "ambiguous"      // AVNT only: multiple records, manual review needed (orange)
  | "error"          // any provider: search failed (grey)
  | "qualified"      // rekvizitai_sme: qualifies as SME or Small Mid-Cap (green)
  | "not_qualified"  // rekvizitai_sme: does not meet either tier (red)
  | "compliant"      // rekvizitai_tax: no VMI or Sodra debt (green)
  | "non_compliant"; // rekvizitai_tax: debt present (red)

export interface RunCheckInput {
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;
  searchType: SearchType;
  providerKeys: CheckProviderKey[];
}

export interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
}

export interface SmeClassification {
  category: "sme" | "small_mid_cap" | "neither" | "unknown";
  employeesCount?: number;
  annualRevenue?: number; // EUR
}

export interface TaxComplianceData {
  hasVmiDebt: boolean;
  hasSodraDebt: boolean;
  // Present only when the flag is true AND the site shows an amount
  vmiDebtAmount?: string;
  sodraDebtAmount?: string;
}

export interface NormalizedCheckResult {
  providerKey: CheckProviderKey;
  sourceUrl: string;
  searchedAt: string;
  borrowerNameInput: string;
  idCodeInput?: string;
  status: ResultStatus;
  resultsCount: number;
  matchedEntities: MatchedEntity[];
  summaryText: string;
  screenshotBuffer?: Buffer;
  classification?: SmeClassification;   // rekvizitai_sme only
  complianceData?: TaxComplianceData;   // rekvizitai_tax only
}

export interface PublicCheckProvider {
  runSearch(input: RunCheckInput): Promise<NormalizedCheckResult>;
}

declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
  }
}
```

- [ ] **Step 2: Verify TypeScript still compiles**

Run: `npx tsc --noEmit`
Expected: no errors (or only pre-existing errors unrelated to these changes)

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: expand types for multi-provider + Rekvizitai checks"
```

---

### Task 2: DB Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add two nullable columns to `SearchRun` in `prisma/schema.prisma`**

After the existing `loanReference String?` line, add:

```prisma
  runGroupId           String?
  searchType           String?
```

The full model should now look like:

```prisma
model SearchRun {
  id                   String   @id @default(cuid())
  createdAt            DateTime @default(now())
  createdByEmail       String

  borrowerName         String
  borrowerIdCode       String?
  loanReference        String?
  providerKey          String
  driveFolderUrl       String

  runGroupId           String?
  searchType           String?

  resultStatus         String
  resultsCount         Int
  matchedSummary       String?

  uploadedFileId       String?
  uploadedFileUrl      String?

  requestPayloadJson   String?
  normalizedResultJson String?
}
```

- [ ] **Step 2: Run migration**

Run: `npx prisma migrate dev --name add_run_group_and_search_type`
Expected: Migration applied successfully, new columns visible in DB

- [ ] **Step 3: Regenerate Prisma client**

Run: `npx prisma generate`
Expected: Client regenerated without errors

- [ ] **Step 4: Verify tests still pass**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add runGroupId and searchType columns to SearchRun"
```

---

## Chunk 2: Rekvizitai Navigation Utility + SME Provider

### Task 3: Rekvizitai Navigation Utility

**Files:**
- Create: `src/providers/rekvizitai/navigate.ts`

This is a shared utility — not a provider itself. It takes an already-created Playwright `Page` object, navigates to rekvizitai.vz.lt, searches for the company, and lands on the company profile page. The calling provider is responsible for creating and closing the browser.

> **Note for implementer:** The selectors below are best-guess patterns for rekvizitai.vz.lt. If they fail during manual testing, inspect the live page and update the arrays. The pattern follows the same multi-fallback approach as `src/providers/avnt-insolvency/search.ts`.

- [ ] **Step 1: Create `src/providers/rekvizitai/navigate.ts`**

```typescript
import type { Page } from "playwright";

const REKVIZITAI_BASE_URL = "https://rekvizitai.vz.lt/";
const NAV_TIMEOUT = 30_000;

/**
 * Navigate an existing Playwright page to the company profile on rekvizitai.vz.lt.
 *
 * Searches by idCode if provided (more precise), otherwise by borrowerName.
 * Throws if no company is found or if multiple results are found when searching by name.
 *
 * The caller is responsible for creating the Page and closing the browser.
 */
export async function navigateToCompanyProfile(
  page: Page,
  borrowerName: string,
  idCode?: string
): Promise<void> {
  page.setDefaultTimeout(NAV_TIMEOUT);

  await page.goto(REKVIZITAI_BASE_URL, { waitUntil: "networkidle" });

  const searchQuery = idCode?.trim() || borrowerName.trim();

  // Try multiple selector patterns for the search input
  const searchInputSelectors = [
    'input[name="q"]',
    'input[type="search"]',
    'input[placeholder*="Ieškoti" i]',
    'input[placeholder*="pavadinimas" i]',
    'input[placeholder*="kodas" i]',
    'input[id*="search" i]',
    'input[class*="search" i]',
  ];

  let inputFilled = false;
  for (const sel of searchInputSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3_000 });
      await page.fill(sel, searchQuery);
      inputFilled = true;
      break;
    } catch {
      // try next selector
    }
  }

  if (!inputFilled) {
    throw new Error(
      "Could not locate search field on rekvizitai.vz.lt. " +
        "The page structure may have changed — update searchInputSelectors in navigate.ts."
    );
  }

  // Submit the search
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => {});

  // Collect links to company profiles
  const companyLinkSelectors = [
    'a[href*="/imone/"]',
    'a[href*="/en/company/"]',
    '.company-list a',
    '.search-results a[href*="/"]',
    'table.companies tbody tr a',
    'ul.results li a',
  ];

  let profileLinks: string[] = [];
  for (const sel of companyLinkSelectors) {
    try {
      const elements = await page.locator(sel).all();
      if (elements.length > 0) {
        const hrefs = await Promise.all(elements.map((el) => el.getAttribute("href")));
        profileLinks = hrefs.filter(Boolean) as string[];
        break;
      }
    } catch {
      // try next selector
    }
  }

  if (profileLinks.length === 0) {
    throw new Error(
      `No company found on rekvizitai.vz.lt matching "${searchQuery}"`
    );
  }

  if (profileLinks.length > 1 && !idCode) {
    throw new Error(
      `Multiple companies found on rekvizitai.vz.lt for "${borrowerName}". ` +
        "Provide ID code to narrow the search."
    );
  }

  // Navigate to the first (or only) result
  const href = profileLinks[0];
  const url = href.startsWith("http")
    ? href
    : `https://rekvizitai.vz.lt${href}`;

  await page.goto(url, { waitUntil: "networkidle" });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add src/providers/rekvizitai/navigate.ts
git commit -m "feat: add rekvizitai.vz.lt navigation utility"
```

---

### Task 4: SME Classification Provider

**Files:**
- Create: `src/providers/rekvizitai-sme/search.ts`
- Create: `src/providers/rekvizitai-sme/index.ts`
- Create: `tests/providers/rekvizitai-sme.test.ts`

> **Note for implementer:** `classifySme` and its sub-functions (`parseEmployees`, `parseRevenue`) are pure functions — they take a string of body text and return structured data. They have no Playwright dependency and can be fully unit-tested. The regex patterns are best-guesses for the Lithuanian text on rekvizitai.vz.lt; adjust them if needed after manually inspecting the live page.

- [ ] **Step 1: Write the failing tests in `tests/providers/rekvizitai-sme.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { classifySme } from "@/providers/rekvizitai-sme/search";

describe("classifySme", () => {
  it("returns unknown when employees data is missing", () => {
    const result = classifySme("Apyvarta: 5 000 000 EUR\nKita informacija");
    expect(result.category).toBe("unknown");
    expect(result.employeesCount).toBeUndefined();
  });

  it("returns unknown when revenue data is missing", () => {
    const result = classifySme("Darbuotojų skaičius: 50\nKita informacija");
    expect(result.category).toBe("unknown");
    expect(result.annualRevenue).toBeUndefined();
  });

  it("returns sme for employees < 250 and revenue <= 50M", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 50\nApyvarta: 5 000 000 EUR"
    );
    expect(result.category).toBe("sme");
    expect(result.employeesCount).toBe(50);
    expect(result.annualRevenue).toBe(5_000_000);
  });

  it("returns small_mid_cap when employees >= 250 but < 500 and revenue <= 100M", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 300\nApyvarta: 60 000 000 EUR"
    );
    expect(result.category).toBe("small_mid_cap");
    expect(result.employeesCount).toBe(300);
  });

  it("returns small_mid_cap when employees < 250 but revenue > 50M and <= 100M", () => {
    // employees 200 < 250 ✓ but revenue 80M > 50M ✗ → not SME
    // employees 200 < 500 ✓ and revenue 80M ≤ 100M ✓ → small_mid_cap
    const result = classifySme(
      "Darbuotojų skaičius: 200\nApyvarta: 80 000 000 EUR"
    );
    expect(result.category).toBe("small_mid_cap");
  });

  it("returns neither when both tiers are exceeded", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 600\nApyvarta: 150 000 000 EUR"
    );
    expect(result.category).toBe("neither");
  });

  it("parses revenue expressed in millions shorthand (mln.)", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 50\nApyvarta: 5 mln. EUR"
    );
    expect(result.category).toBe("sme");
    expect(result.annualRevenue).toBe(5_000_000);
  });

  it("parses revenue expressed in thousands shorthand (tūkst.)", () => {
    const result = classifySme(
      "Darbuotojų skaičius: 10\nApyvarta: 500 tūkst. EUR"
    );
    expect(result.category).toBe("sme");
    expect(result.annualRevenue).toBe(500_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test tests/providers/rekvizitai-sme.test.ts`
Expected: FAIL — "Cannot find module '@/providers/rekvizitai-sme/search'"

- [ ] **Step 3: Create `src/providers/rekvizitai-sme/search.ts`**

```typescript
import { chromium } from "playwright";
import { navigateToCompanyProfile } from "@/providers/rekvizitai/navigate";
import type {
  NormalizedCheckResult,
  RunCheckInput,
  SmeClassification,
} from "@/lib/types";

const REKVIZITAI_URL = "https://rekvizitai.vz.lt/";

export async function runSmeSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "lt-LT",
    });

    const page = await context.newPage();

    await navigateToCompanyProfile(page, input.borrowerName, input.idCode);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const classification = classifySme(bodyText);

    const status =
      classification.category === "neither" ? "not_qualified" : "qualified";

    return {
      providerKey: "rekvizitai_sme",
      sourceUrl: finalUrl || REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount: 0,
      matchedEntities: [],
      summaryText: buildSmeSummary(classification, input.borrowerName),
      screenshotBuffer,
      classification,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      providerKey: "rekvizitai_sme",
      sourceUrl: REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `SME classification failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Classify a company as SME, Small Mid-Cap, neither, or unknown based on
 * employee count and annual revenue parsed from the page body text.
 *
 * Exported for unit testing.
 */
export function classifySme(bodyText: string): SmeClassification {
  const employeesCount = parseEmployees(bodyText);
  const annualRevenue = parseRevenue(bodyText);

  // Rule 1: Missing data → unknown (conservative: do not penalise)
  if (employeesCount === undefined || annualRevenue === undefined) {
    return { category: "unknown", employeesCount, annualRevenue };
  }

  // Rule 2: SME — both conditions must be met
  if (employeesCount < 250 && annualRevenue <= 50_000_000) {
    return { category: "sme", employeesCount, annualRevenue };
  }

  // Rule 3: Small Mid-Cap — both conditions must be met
  if (employeesCount < 500 && annualRevenue <= 100_000_000) {
    return { category: "small_mid_cap", employeesCount, annualRevenue };
  }

  // Rule 4: Neither tier satisfied
  return { category: "neither", employeesCount, annualRevenue };
}

function parseEmployees(text: string): number | undefined {
  const patterns = [
    /darbuotoj[uų]\s+skai[cč]ius[:\s]+(\d[\d\s]*)/i,
    /darbuotoj[uų]\s+sk\.[:\s]+(\d[\d\s]*)/i,
    /employees?[:\s]+(\d[\d\s]*)/i,
    /staff[:\s]+(\d[\d\s]*)/i,
    /personnel[:\s]+(\d[\d\s]*)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const num = parseInt(match[1].replace(/\s/g, ""), 10);
      if (!isNaN(num)) return num;
    }
  }
  return undefined;
}

function parseRevenue(text: string): number | undefined {
  // Patterns for "X mln. EUR", "X tūkst. EUR", or "X EUR" (with spaces as thousands sep)
  const patterns: Array<{ re: RegExp; multiplier: number }> = [
    {
      re: /apyvarta[:\s]+([\d\s,.]+)\s*mln\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000_000,
    },
    {
      re: /paja?mos[:\s]+([\d\s,.]+)\s*mln\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000_000,
    },
    {
      re: /apyvarta[:\s]+([\d\s,.]+)\s*tūkst\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000,
    },
    {
      re: /paja?mos[:\s]+([\d\s,.]+)\s*tūkst\.?\s*(?:EUR|Eur|eur)/i,
      multiplier: 1_000,
    },
    {
      re: /apyvarta[:\s]+([\d\s]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
    {
      re: /paja?mos[:\s]+([\d\s]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
    {
      re: /revenue[:\s]+([\d\s,.]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
    {
      re: /turnover[:\s]+([\d\s,.]+)\s*(?:EUR|Eur|eur)/i,
      multiplier: 1,
    },
  ];

  for (const { re, multiplier } of patterns) {
    const match = text.match(re);
    if (match) {
      // Remove spaces (thousands separator) and replace comma with dot
      const cleaned = match[1].replace(/\s/g, "").replace(",", ".");
      const num = parseFloat(cleaned);
      if (!isNaN(num)) return Math.round(num * multiplier);
    }
  }
  return undefined;
}

function buildSmeSummary(
  classification: SmeClassification,
  borrowerName: string
): string {
  const name = borrowerName;
  switch (classification.category) {
    case "sme":
      return (
        `"${name}" qualifies as an SME ` +
        `(employees: ${classification.employeesCount}, ` +
        `revenue: €${formatRevenue(classification.annualRevenue)}).`
      );
    case "small_mid_cap":
      return (
        `"${name}" qualifies as a Small Mid-Cap ` +
        `(employees: ${classification.employeesCount}, ` +
        `revenue: €${formatRevenue(classification.annualRevenue)}).`
      );
    case "neither":
      return (
        `"${name}" does not qualify as SME or Small Mid-Cap ` +
        `(employees: ${classification.employeesCount}, ` +
        `revenue: €${formatRevenue(classification.annualRevenue)}).`
      );
    case "unknown":
      return (
        `SME classification could not be determined for "${name}" — ` +
        `${classification.employeesCount === undefined ? "employee count" : "revenue"} ` +
        `data not available on rekvizitai.vz.lt.`
      );
  }
}

function formatRevenue(revenue: number | undefined): string {
  if (revenue === undefined) return "N/A";
  if (revenue >= 1_000_000) return `${(revenue / 1_000_000).toFixed(1)}M`;
  if (revenue >= 1_000) return `${(revenue / 1_000).toFixed(0)}K`;
  return String(revenue);
}
```

- [ ] **Step 4: Create `src/providers/rekvizitai-sme/index.ts`**

```typescript
import { runSmeSearch } from "./search";
import type { PublicCheckProvider, RunCheckInput, NormalizedCheckResult } from "@/lib/types";

export class RekvizitaiSmeProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runSmeSearch(input);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test tests/providers/rekvizitai-sme.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/providers/rekvizitai-sme/ src/providers/rekvizitai/ tests/providers/rekvizitai-sme.test.ts
git commit -m "feat: add rekvizitai SME classification provider"
```

---

## Chunk 3: Tax Compliance Provider

### Task 5: Tax Compliance Provider

**Files:**
- Create: `src/providers/rekvizitai-tax/search.ts`
- Create: `src/providers/rekvizitai-tax/index.ts`
- Create: `tests/providers/rekvizitai-tax.test.ts`

> **Note for implementer:** `parseTaxCompliance` is a pure function — testable without Playwright. The regex patterns are based on known Lithuanian text from rekvizitai.vz.lt debt sections; verify against the live site if patterns don't match.

- [ ] **Step 1: Write failing tests in `tests/providers/rekvizitai-tax.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import { parseTaxCompliance } from "@/providers/rekvizitai-tax/search";

describe("parseTaxCompliance", () => {
  it("returns no debt when page says no tax debts", () => {
    const result = parseTaxCompliance("Mokestinių skolų nėra\nSodros skolų nėra");
    expect(result.hasVmiDebt).toBe(false);
    expect(result.hasSodraDebt).toBe(false);
    expect(result.vmiDebtAmount).toBeUndefined();
    expect(result.sodraDebtAmount).toBeUndefined();
  });

  it("returns no debt when page says no debts (alternative text)", () => {
    const result = parseTaxCompliance("Skolų nėra\nĮsiskolinimų nėra");
    expect(result.hasVmiDebt).toBe(false);
    expect(result.hasSodraDebt).toBe(false);
  });

  it("detects VMI debt with amount", () => {
    const result = parseTaxCompliance(
      "VMI skola: 1 200 EUR\nSodros skolų nėra"
    );
    expect(result.hasVmiDebt).toBe(true);
    expect(result.vmiDebtAmount).toBe("1 200 EUR");
    expect(result.hasSodraDebt).toBe(false);
  });

  it("detects Sodra debt with amount", () => {
    const result = parseTaxCompliance(
      "Mokestinių skolų nėra\nSodros skola: 3 500 EUR"
    );
    expect(result.hasSodraDebt).toBe(true);
    expect(result.sodraDebtAmount).toBe("3 500 EUR");
    expect(result.hasVmiDebt).toBe(false);
  });

  it("detects both VMI and Sodra debt", () => {
    const result = parseTaxCompliance(
      "VMI skola: 5 000 EUR\nSodros skola: 2 100 EUR"
    );
    expect(result.hasVmiDebt).toBe(true);
    expect(result.hasSodraDebt).toBe(true);
    expect(result.vmiDebtAmount).toBe("5 000 EUR");
    expect(result.sodraDebtAmount).toBe("2 100 EUR");
  });

  it("detects VMI debt without amount when debt exists but no figure shown", () => {
    const result = parseTaxCompliance("Mokestinė skola VMI\nSodros skolų nėra");
    expect(result.hasVmiDebt).toBe(true);
    expect(result.vmiDebtAmount).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test tests/providers/rekvizitai-tax.test.ts`
Expected: FAIL — "Cannot find module '@/providers/rekvizitai-tax/search'"

- [ ] **Step 3: Create `src/providers/rekvizitai-tax/search.ts`**

```typescript
import { chromium } from "playwright";
import { navigateToCompanyProfile } from "@/providers/rekvizitai/navigate";
import type {
  NormalizedCheckResult,
  RunCheckInput,
  TaxComplianceData,
} from "@/lib/types";

const REKVIZITAI_URL = "https://rekvizitai.vz.lt/";

export async function runTaxSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "lt-LT",
    });

    const page = await context.newPage();

    await navigateToCompanyProfile(page, input.borrowerName, input.idCode);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const complianceData = parseTaxCompliance(bodyText);

    const status =
      complianceData.hasVmiDebt || complianceData.hasSodraDebt
        ? "non_compliant"
        : "compliant";

    return {
      providerKey: "rekvizitai_tax",
      sourceUrl: finalUrl || REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount: 0,
      matchedEntities: [],
      summaryText: buildTaxSummary(complianceData, input.borrowerName),
      screenshotBuffer,
      complianceData,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      providerKey: "rekvizitai_tax",
      sourceUrl: REKVIZITAI_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `Tax compliance check failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse VMI and Sodra debt status from rekvizitai.vz.lt company profile body text.
 *
 * Exported for unit testing.
 */
export function parseTaxCompliance(bodyText: string): TaxComplianceData {
  const hasVmiDebt = detectVmiDebt(bodyText);
  const hasSodraDebt = detectSodraDebt(bodyText);

  return {
    hasVmiDebt,
    hasSodraDebt,
    vmiDebtAmount: hasVmiDebt ? extractVmiAmount(bodyText) : undefined,
    sodraDebtAmount: hasSodraDebt ? extractSodraAmount(bodyText) : undefined,
  };
}

// ── VMI detection ────────────────────────────────────────────────────────────

function detectVmiDebt(text: string): boolean {
  // Positive signals: explicit VMI debt mentioned
  const debtPatterns = [
    /vmi\s+skola/i,
    /mokestin[eė]\s+skola\s+vmi/i,
    /mokestin[eė]\s+skola:/i,
    /vmi.*(?:skola|[eė]skolinimas)/i,
  ];
  const noDebtPatterns = [
    /mokestin[ių]\s+skol[ų]\s+n[eė]ra/i,
    /vmi.*n[eė]ra/i,
    /n[eė]turi\s+mokestin[ių]\s+skol[ų]/i,
  ];

  const lower = text;
  if (noDebtPatterns.some((p) => p.test(lower))) return false;
  return debtPatterns.some((p) => p.test(lower));
}

function extractVmiAmount(text: string): string | undefined {
  const match = text.match(
    /(?:vmi\s+skola|mokestin[eė]\s+skola)[:\s]+([\d\s]+(?:EUR|Eur|eur))/i
  );
  return match ? match[1].trim() : undefined;
}

// ── Sodra detection ──────────────────────────────────────────────────────────

function detectSodraDebt(text: string): boolean {
  const debtPatterns = [
    /sodr[ao]s?\s+skola/i,
    /socialinio\s+draudimo.*skola/i,
    /vsd.*skola/i,
    /sodr[ao].*(?:skola|[eė]skolinimas)/i,
  ];
  const noDebtPatterns = [
    /sodr[ao]s?\s+skol[ų]\s+n[eė]ra/i,
    /sodr[ao].*n[eė]ra/i,
    /n[eė]turi\s+sodr[ao]/i,
  ];

  if (noDebtPatterns.some((p) => p.test(text))) return false;
  return debtPatterns.some((p) => p.test(text));
}

function extractSodraAmount(text: string): string | undefined {
  const match = text.match(
    /(?:sodr[ao]s?\s+skola|socialinio\s+draudimo.*skola)[:\s]+([\d\s]+(?:EUR|Eur|eur))/i
  );
  return match ? match[1].trim() : undefined;
}

// ── Summary builder ──────────────────────────────────────────────────────────

function buildTaxSummary(data: TaxComplianceData, borrowerName: string): string {
  if (!data.hasVmiDebt && !data.hasSodraDebt) {
    return `"${borrowerName}" has no VMI or Sodra tax debts on rekvizitai.vz.lt.`;
  }

  const debts: string[] = [];
  if (data.hasVmiDebt) {
    debts.push(`VMI debt${data.vmiDebtAmount ? `: ${data.vmiDebtAmount}` : ""}`);
  }
  if (data.hasSodraDebt) {
    debts.push(
      `Sodra debt${data.sodraDebtAmount ? `: ${data.sodraDebtAmount}` : ""}`
    );
  }

  return `"${borrowerName}" has outstanding tax obligations: ${debts.join(", ")}.`;
}
```

- [ ] **Step 4: Create `src/providers/rekvizitai-tax/index.ts`**

```typescript
import { runTaxSearch } from "./search";
import type { PublicCheckProvider, RunCheckInput, NormalizedCheckResult } from "@/lib/types";

export class RekvizitaiTaxProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runTaxSearch(input);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test tests/providers/rekvizitai-tax.test.ts`
Expected: all 6 tests PASS

- [ ] **Step 6: Run full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src/providers/rekvizitai-tax/ tests/providers/rekvizitai-tax.test.ts
git commit -m "feat: add rekvizitai Tax/Sodra compliance provider"
```

---

## Chunk 4: Registry and API Route

### Task 6: Update Registry

**Files:**
- Modify: `src/providers/registry.ts`

- [ ] **Step 1: Replace the contents of `src/providers/registry.ts`**

```typescript
import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";
import { RekvizitaiSmeProvider } from "./rekvizitai-sme";
import { RekvizitaiTaxProvider } from "./rekvizitai-tax";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
  rekvizitai_sme: new RekvizitaiSmeProvider(),
  rekvizitai_tax: new RekvizitaiTaxProvider(),
};

function isCheckProviderKey(key: string): key is CheckProviderKey {
  return key in providers;
}

export function getProvider(key: string): PublicCheckProvider | null {
  if (!isCheckProviderKey(key)) return null;
  return providers[key];
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add src/providers/registry.ts
git commit -m "feat: register rekvizitai providers in registry"
```

---

### Task 7: Rewrite API Route

**Files:**
- Modify: `src/app/api/checks/run/route.ts`
- Modify: `tests/api/checks-run.test.ts`

- [ ] **Step 1: Write the failing tests first — replace `tests/api/checks-run.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/providers/registry", () => ({ getProvider: vi.fn() }));
vi.mock("@/services/evidence", () => ({
  generateEvidencePdf: vi.fn().mockResolvedValue(Buffer.from("pdf")),
}));
vi.mock("@/services/drive", () => ({
  extractFolderIdFromUrl: vi.fn(),
  uploadFileToDrive: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: { searchRun: { create: vi.fn().mockResolvedValue({ id: "run-1" }) } },
}));

import { POST } from "@/app/api/checks/run/route";
import { getServerSession } from "next-auth";
import { getProvider } from "@/providers/registry";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";

const mockSession = {
  user: { email: "tester@example.com" },
  accessToken: "tok",
};

function makeReq(body: object) {
  return new NextRequest("http://localhost/api/checks/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  borrowerName: "UAB Test",
  driveFolderUrl: "https://drive.google.com/drive/folders/abc123",
  searchType: "individual",
  providerKeys: ["avnt_insolvency"],
};

const mockSearchResult = {
  providerKey: "avnt_insolvency" as const,
  sourceUrl: "https://www.avnt.lt",
  searchedAt: new Date().toISOString(),
  borrowerNameInput: "UAB Test",
  status: "no_match" as const,
  resultsCount: 0,
  matchedEntities: [],
  summaryText: "No records found",
};

describe("POST /api/checks/run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(401);
  });

  it("returns 400 when borrowerName is blank", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    const res = await POST(makeReq({ ...validBody, borrowerName: "   " }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/borrowerName/);
  });

  it("returns 400 when Drive URL is invalid", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue(null);
    const res = await POST(makeReq({ ...validBody, driveFolderUrl: "not-a-url" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Drive/);
  });

  it("returns 400 when providerKeys is empty", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    const res = await POST(makeReq({ ...validBody, providerKeys: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown provider key", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue(null);
    const res = await POST(makeReq({ ...validBody, providerKeys: ["unknown_provider"] }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when Rekvizitai provider is requested for individual search", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue({ runSearch: vi.fn() });
    const res = await POST(
      makeReq({
        ...validBody,
        searchType: "individual",
        providerKeys: ["avnt_insolvency", "rekvizitai_sme"],
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/legal entity/i);
  });

  it("runs single provider and returns 200 with results array", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue({
      runSearch: vi.fn().mockResolvedValue(mockSearchResult),
    });
    vi.mocked(uploadFileToDrive).mockResolvedValue({
      fileId: "file-1",
      webViewLink: "https://drive.google.com/file/d/file-1/view",
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(1);
    expect(json.results[0].status).toBe("no_match");
    expect(json.runGroupId).toBeDefined();
    expect(json.driveUrl).toBe("https://drive.google.com/file/d/file-1/view");
  });

  it("runs multiple providers and returns 200 with results array", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue({
      runSearch: vi.fn().mockResolvedValue(mockSearchResult),
    });
    vi.mocked(uploadFileToDrive).mockResolvedValue({
      fileId: "file-1",
      webViewLink: "https://drive.google.com/file/d/file-1/view",
    });

    const res = await POST(
      makeReq({
        ...validBody,
        searchType: "legal_entity",
        providerKeys: ["avnt_insolvency", "rekvizitai_sme", "rekvizitai_tax"],
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(3);
    expect(json.runGroupId).toBeDefined();
  });

  it("returns 200 with driveError when Drive upload fails", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue({
      runSearch: vi.fn().mockResolvedValue(mockSearchResult),
    });
    vi.mocked(uploadFileToDrive).mockRejectedValue(new Error("Drive API error"));

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.driveError).toMatch(/Drive API error/);
    expect(json.driveUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test tests/api/checks-run.test.ts`
Expected: several FAIL (route still uses old single-provider API)

- [ ] **Step 3: Rewrite `src/app/api/checks/run/route.ts`**

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { v4 as uuidv4 } from "uuid";
import { authOptions } from "@/lib/auth";
import { getProvider } from "@/providers/registry";
import { generateEvidencePdf } from "@/services/evidence";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";
import type {
  RunCheckInput,
  NormalizedCheckResult,
  CheckProviderKey,
  SearchType,
} from "@/lib/types";

const REKVIZITAI_KEYS: CheckProviderKey[] = ["rekvizitai_sme", "rekvizitai_tax"];

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    borrowerName,
    idCode,
    loanReference,
    driveFolderUrl,
    searchType = "individual" as SearchType,
    providerKeys,
  } = body;

  // Validate required fields
  if (!borrowerName?.trim()) {
    return NextResponse.json(
      { error: "borrowerName is required" },
      { status: 400 }
    );
  }

  const folderId = extractFolderIdFromUrl(driveFolderUrl ?? "");
  if (!folderId) {
    return NextResponse.json(
      { error: "Invalid Google Drive folder URL" },
      { status: 400 }
    );
  }

  // Validate providerKeys
  if (!Array.isArray(providerKeys) || providerKeys.length === 0) {
    return NextResponse.json(
      { error: "providerKeys must be a non-empty array" },
      { status: 400 }
    );
  }

  // Validate each key: must be recognized, and Rekvizitai not allowed for individuals
  for (const key of providerKeys as string[]) {
    if (!getProvider(key)) {
      return NextResponse.json(
        { error: `Unknown provider: ${key}` },
        { status: 400 }
      );
    }
    if (
      searchType === "individual" &&
      REKVIZITAI_KEYS.includes(key as CheckProviderKey)
    ) {
      return NextResponse.json(
        {
          error: `Provider "${key}" is only available for legal entity searches`,
        },
        { status: 400 }
      );
    }
  }

  const runGroupId = uuidv4();

  const input: RunCheckInput = {
    borrowerName: borrowerName.trim(),
    idCode: idCode?.trim() || undefined,
    loanReference: loanReference?.trim() || undefined,
    driveFolderUrl,
    initiatedByEmail: session.user.email,
    searchType: searchType as SearchType,
    providerKeys: providerKeys as CheckProviderKey[],
  };

  try {
    // Run all providers in parallel; each catches its own errors
    const results: NormalizedCheckResult[] = await Promise.all(
      (providerKeys as string[]).map(async (key) => {
        const provider = getProvider(key)!;
        try {
          return await provider.runSearch(input);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            providerKey: key as CheckProviderKey,
            sourceUrl: "",
            searchedAt: new Date().toISOString(),
            borrowerNameInput: input.borrowerName,
            status: "error",
            resultsCount: 0,
            matchedEntities: [],
            summaryText: `Search failed: ${message}`,
          } satisfies NormalizedCheckResult;
        }
      })
    );

    // Build filename: sanitized-name-YYYY-MM-DD-first8ofGroupId.pdf
    const safeName = input.borrowerName
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-]/g, "-")
      .toLowerCase();
    const dateStr = new Date().toISOString().slice(0, 10);
    const shortId = runGroupId.replace(/-/g, "").slice(0, 8);
    const filename = `${safeName}-${dateStr}-${shortId}.pdf`;

    let pdfBuffer: Buffer | undefined;
    let pdfError: string | undefined;
    try {
      pdfBuffer = await generateEvidencePdf(input, results, filename, runGroupId);
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
    }

    let uploadedFileId: string | undefined;
    let uploadedFileUrl: string | undefined;
    let driveError: string | undefined;

    if (pdfBuffer) {
      try {
        const uploaded = await uploadFileToDrive(
          session.accessToken,
          folderId,
          filename,
          pdfBuffer
        );
        uploadedFileId = uploaded.fileId;
        uploadedFileUrl = uploaded.webViewLink;
      } catch (err) {
        driveError = err instanceof Error ? err.message : String(err);
      }
    }

    // Save one SearchRun row per provider
    await Promise.all(
      results.map((result) =>
        db.searchRun.create({
          data: {
            createdByEmail: session.user.email!,
            borrowerName: input.borrowerName,
            borrowerIdCode: input.idCode,
            loanReference: input.loanReference,
            providerKey: result.providerKey,
            driveFolderUrl,
            runGroupId,
            searchType: input.searchType,
            resultStatus: result.status,
            resultsCount: result.resultsCount,
            matchedSummary: result.summaryText,
            uploadedFileId,
            uploadedFileUrl,
            requestPayloadJson: JSON.stringify(input),
            normalizedResultJson: JSON.stringify({
              ...result,
              screenshotBuffer: undefined,
            }),
          },
        })
      )
    );

    return NextResponse.json({
      runGroupId,
      results: results.map((r) => ({
        providerKey: r.providerKey,
        status: r.status,
        resultsCount: r.resultsCount,
        summaryText: r.summaryText,
        matchedEntities: r.matchedEntities,
        classification: r.classification,
        complianceData: r.complianceData,
      })),
      driveUrl: uploadedFileUrl,
      ...(driveError
        ? { driveError }
        : pdfError
        ? { driveError: `PDF generation failed: ${pdfError}` }
        : {}),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test tests/api/checks-run.test.ts`
Expected: all 9 tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/app/api/checks/run/route.ts tests/api/checks-run.test.ts src/providers/registry.ts
git commit -m "feat: rewrite API route for multi-provider parallel execution"
```

---

## Chunk 5: Combined PDF Generator

### Task 8: Update Evidence PDF

**Files:**
- Modify: `src/services/evidence.ts`

The signature changes from `(input, result, filename)` to `(input, results[], filename, runGroupId)`. The cover page shows a summary table; each provider gets a detail section; screenshots are grouped at the end.

- [ ] **Step 1: Replace the contents of `src/services/evidence.ts`**

```typescript
/**
 * Evidence PDF generator — multi-provider combined output
 */
import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";
import type {
  NormalizedCheckResult,
  RunCheckInput,
  ResultStatus,
} from "@/lib/types";

const BRAND_BLUE = rgb(0.07, 0.27, 0.55);
const GREY = rgb(0.4, 0.4, 0.4);
const BLACK = rgb(0, 0, 0);
const RED = rgb(0.75, 0.1, 0.1);
const GREEN = rgb(0.07, 0.52, 0.18);
const ORANGE = rgb(0.85, 0.45, 0.0);
const WHITE = rgb(1, 1, 1);

export async function generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],
  filename: string,
  runGroupId: string
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── Page 1: Cover / Run Summary ────────────────────────────────────────────
  const cover = doc.addPage(PageSizes.A4);
  const { width, height } = cover.getSize();
  const margin = 50;
  let y = height - margin;

  // Header bar
  cover.drawRectangle({ x: 0, y: height - 70, width, height: 70, color: BRAND_BLUE });
  cover.drawText("Public Registry Check — Evidence Report", {
    x: margin, y: height - 45, font: bold, size: 16, color: WHITE,
  });

  y = height - 110;

  // Run Information
  drawSection(cover, bold, "Run Information", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Borrower name:", sanitizeForPdf(input.borrowerName), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "ID code:", sanitizeForPdf(input.idCode ?? "(not provided)"), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Search type:", input.searchType === "legal_entity" ? "Legal entity" : "Individual", margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Initiated by:", sanitizeForPdf(input.initiatedByEmail), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Run group ID:", runGroupId, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Evidence filename:", sanitizeForPdf(filename), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Generated:", formatDate(new Date().toISOString()), margin, y);
  y -= 30;

  // Summary table: one row per provider
  drawSection(cover, bold, "Check Summary", margin, y, width - margin * 2);
  y -= 24;

  // Table header
  const col1 = margin;
  const col2 = margin + 190;
  const col3 = margin + 320;
  cover.drawText("PROVIDER", { x: col1, y, font: bold, size: 8, color: GREY });
  cover.drawText("STATUS", { x: col2, y, font: bold, size: 8, color: GREY });
  cover.drawText("SUMMARY", { x: col3, y, font: bold, size: 8, color: GREY });
  y -= 4;
  cover.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, color: GREY, thickness: 0.5 });
  y -= 14;

  for (const result of results) {
    const statusColor = getStatusColor(result.status);
    const statusLabel = getStatusLabel(result.status);
    const providerLabel = getProviderLabel(result.providerKey);

    // Provider name
    cover.drawText(sanitizeForPdf(providerLabel), { x: col1, y, font: regular, size: 8, color: BLACK });

    // Status badge (colored rectangle)
    const badgeWidth = 110;
    cover.drawRectangle({ x: col2, y: y - 10, width: badgeWidth, height: 16, color: statusColor });
    cover.drawText(statusLabel, { x: col2 + 4, y: y - 4, font: bold, size: 7, color: WHITE });

    // Summary (truncated to fit)
    const summaryLines = wrapText(sanitizeForPdf(result.summaryText), 38);
    cover.drawText(summaryLines[0] ?? "", { x: col3, y, font: regular, size: 7, color: BLACK });
    if (summaryLines[1]) {
      cover.drawText(summaryLines[1], { x: col3, y: y - 10, font: regular, size: 7, color: BLACK });
    }

    y -= 30;
    if (y < margin + 30) break;
  }

  // Footer
  cover.drawLine({
    start: { x: margin, y: margin + 20 },
    end: { x: width - margin, y: margin + 20 },
    color: GREY, thickness: 0.5,
  });
  cover.drawText(
    `Run Group: ${runGroupId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
    { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
  );

  // ── Pages 2+: One detail section per provider (in input order) ─────────────
  for (const result of results) {
    const detailPage = doc.addPage(PageSizes.A4);
    const { width: pw, height: ph } = detailPage.getSize();
    let dy = ph - margin;

    // Page header bar
    detailPage.drawRectangle({ x: 0, y: ph - 50, width: pw, height: 50, color: BRAND_BLUE });
    detailPage.drawText(getProviderLabel(result.providerKey), {
      x: margin, y: ph - 32, font: bold, size: 13, color: WHITE,
    });

    dy = ph - 80;

    // Status badge
    const statusColor = getStatusColor(result.status);
    const statusLabel = getStatusLabel(result.status);
    detailPage.drawRectangle({ x: margin, y: dy - 24, width: pw - margin * 2, height: 30, color: statusColor });
    detailPage.drawText(statusLabel, {
      x: margin + 10, y: dy - 10, font: bold, size: 12, color: WHITE,
    });
    dy -= 44;

    // Summary text
    const summaryLines = wrapText(sanitizeForPdf(result.summaryText), 90);
    for (const line of summaryLines) {
      detailPage.drawText(line, { x: margin, y: dy, font: regular, size: 9, color: BLACK });
      dy -= 14;
    }
    dy -= 10;

    if (result.status === "error") {
      // Error: nothing more to render
    } else if (result.providerKey === "avnt_insolvency" && result.matchedEntities.length > 0) {
      drawSection(detailPage, bold, "Matched Entities", margin, dy, pw - margin * 2);
      dy -= 20;
      for (const entity of result.matchedEntities.slice(0, 20)) {
        const line = [
          sanitizeForPdf(entity.name),
          entity.caseNumber ? `Case: ${entity.caseNumber}` : "",
          entity.status ?? "",
        ].filter(Boolean).join("  |  ");
        const wrapped = wrapText(line, 90);
        for (const wl of wrapped) {
          detailPage.drawText(`• ${wl}`, { x: margin + 8, y: dy, font: regular, size: 8, color: BLACK });
          dy -= 12;
        }
        if (dy < margin + 30) break;
      }
    } else if (result.providerKey === "rekvizitai_sme" && result.classification) {
      drawSection(detailPage, bold, "SME Classification", margin, dy, pw - margin * 2);
      dy -= 20;
      const c = result.classification;
      drawRow(detailPage, regular, bold, "Category:", getCategoryLabel(c.category), margin, dy);
      dy -= 18;
      drawRow(detailPage, regular, bold, "Employees:", c.employeesCount !== undefined ? String(c.employeesCount) : "N/A", margin, dy);
      dy -= 18;
      drawRow(detailPage, regular, bold, "Annual Revenue:", c.annualRevenue !== undefined ? `EUR ${c.annualRevenue.toLocaleString()}` : "N/A", margin, dy);
    } else if (result.providerKey === "rekvizitai_tax" && result.complianceData) {
      drawSection(detailPage, bold, "Tax & Social Security Compliance", margin, dy, pw - margin * 2);
      dy -= 20;
      const td = result.complianceData;
      drawRow(detailPage, regular, bold, "VMI Debt:", td.hasVmiDebt ? `YES${td.vmiDebtAmount ? ` — ${td.vmiDebtAmount}` : ""}` : "None", margin, dy);
      dy -= 18;
      drawRow(detailPage, regular, bold, "Sodra Debt:", td.hasSodraDebt ? `YES${td.sodraDebtAmount ? ` — ${td.sodraDebtAmount}` : ""}` : "None", margin, dy);
    }

    // Footer
    detailPage.drawLine({
      start: { x: margin, y: margin + 20 },
      end: { x: pw - margin, y: margin + 20 },
      color: GREY, thickness: 0.5,
    });
    detailPage.drawText(
      `Run Group: ${runGroupId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
      { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
    );
  }

  // ── Final pages: Screenshots (one per provider, grouped at end) ────────────
  for (const result of results) {
    if (!result.screenshotBuffer) continue;
    try {
      const screenshotPage = doc.addPage(PageSizes.A4);
      const { width: sw, height: sh } = screenshotPage.getSize();

      screenshotPage.drawText(`Screenshot — ${getProviderLabel(result.providerKey)}`, {
        x: margin, y: sh - margin - 16, font: bold, size: 12, color: BRAND_BLUE,
      });
      screenshotPage.drawText(`Source: ${result.sourceUrl}`, {
        x: margin, y: sh - margin - 32, font: regular, size: 8, color: GREY,
      });

      const pngImage = await doc.embedPng(result.screenshotBuffer);
      const imgDims = pngImage.scaleToFit(sw - margin * 2, sh - margin * 2 - 60);
      screenshotPage.drawImage(pngImage, {
        x: margin,
        y: sh - margin - 60 - imgDims.height,
        width: imgDims.width,
        height: imgDims.height,
      });
    } catch {
      // If embedding fails, skip this screenshot — other pages remain valid
    }
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function drawSection(
  page: ReturnType<PDFDocument["addPage"]>,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  title: string,
  x: number,
  y: number,
  sectionWidth: number
) {
  page.drawText(title.toUpperCase(), { x, y, font: bold, size: 9, color: BRAND_BLUE });
  page.drawLine({
    start: { x, y: y - 4 },
    end: { x: x + sectionWidth, y: y - 4 },
    color: BRAND_BLUE,
    thickness: 0.75,
  });
}

function drawRow(
  page: ReturnType<PDFDocument["addPage"]>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  label: string,
  value: string,
  x: number,
  y: number,
  valueFontSize = 9
) {
  page.drawText(label, { x, y, font: bold, size: 9, color: GREY });
  page.drawText(value, { x: x + 130, y, font: regular, size: valueFontSize, color: BLACK });
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + " " + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC";
  } catch {
    return iso;
  }
}

function getProviderLabel(key: string): string {
  const labels: Record<string, string> = {
    avnt_insolvency: "AVNT Insolvency Register",
    rekvizitai_sme: "SME / Small Mid-Cap Classification",
    rekvizitai_tax: "Tax & Social Security Compliance",
  };
  return labels[key] ?? key;
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    sme: "SME (Small and Medium-sized Enterprise)",
    small_mid_cap: "Small Mid-Cap",
    neither: "Neither SME nor Small Mid-Cap",
    unknown: "Unknown (data not available)",
  };
  return labels[category] ?? category;
}

function getStatusColor(status: ResultStatus) {
  switch (status) {
    case "no_match":
    case "qualified":
    case "compliant":
      return GREEN;
    case "match_found":
    case "not_qualified":
    case "non_compliant":
      return RED;
    case "ambiguous":
      return ORANGE;
    default:
      return GREY;
  }
}

function getStatusLabel(status: ResultStatus): string {
  const labels: Record<ResultStatus, string> = {
    no_match: "NO RECORD FOUND",
    match_found: "RECORD FOUND",
    ambiguous: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    error: "TECHNICAL ERROR",
    qualified: "QUALIFIED",
    not_qualified: "NOT QUALIFIED",
    compliant: "COMPLIANT",
    non_compliant: "NON-COMPLIANT",
  };
  return labels[status] ?? status.toUpperCase();
}

function sanitizeForPdf(text: string): string {
  return text
    .replace(/[Ąą]/g, (c) => (c === c.toUpperCase() ? "A" : "a"))
    .replace(/[Čč]/g, (c) => (c === c.toUpperCase() ? "C" : "c"))
    .replace(/[Ęę]/g, (c) => (c === c.toUpperCase() ? "E" : "e"))
    .replace(/[Ėė]/g, (c) => (c === c.toUpperCase() ? "E" : "e"))
    .replace(/[Įį]/g, (c) => (c === c.toUpperCase() ? "I" : "i"))
    .replace(/[Šš]/g, (c) => (c === c.toUpperCase() ? "S" : "s"))
    .replace(/[Ųų]/g, (c) => (c === c.toUpperCase() ? "U" : "u"))
    .replace(/[Ūū]/g, (c) => (c === c.toUpperCase() ? "U" : "u"))
    .replace(/[Žž]/g, (c) => (c === c.toUpperCase() ? "Z" : "z"))
    .replace(/[^\x00-\xFF]/g, "?");
}
```

- [ ] **Step 2: Run full test suite to verify nothing is broken**

Run: `npm test`
Expected: all tests pass (the evidence module is mocked in API tests)

- [ ] **Step 3: Commit**

```bash
git add src/services/evidence.ts
git commit -m "feat: update PDF generator for multi-provider combined output"
```

---

## Chunk 6: UI Updates

### Task 9: Update ResultCard

**Files:**
- Modify: `src/components/ResultCard.tsx`

Add STATUS_CONFIG entries for the four new statuses and update the Props type to accept a `providerKey` label.

- [ ] **Step 1: Replace the contents of `src/components/ResultCard.tsx`**

```typescript
import { Badge } from "@/components/ui/badge";
import type { ResultStatus } from "@/lib/types";

interface Props {
  providerLabel: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
  driveUrl?: string;
  driveError?: string;
}

const STATUS_CONFIG: Record<
  ResultStatus,
  {
    label: string;
    variant: "default" | "destructive" | "outline" | "secondary";
    className?: string;
  }
> = {
  no_match: {
    label: "NO RECORD FOUND",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  match_found: { label: "RECORD FOUND", variant: "destructive" },
  ambiguous: {
    label: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    variant: "outline",
    className: "border-amber-500 bg-amber-500 text-white",
  },
  error: { label: "TECHNICAL ERROR", variant: "outline" },
  qualified: {
    label: "QUALIFIED",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  not_qualified: {
    label: "NOT QUALIFIED",
    variant: "destructive",
  },
  compliant: {
    label: "COMPLIANT",
    variant: "outline",
    className: "border-green-600 bg-green-600 text-white",
  },
  non_compliant: {
    label: "NON-COMPLIANT",
    variant: "destructive",
  },
};

export function ResultCard({
  providerLabel,
  status,
  resultsCount,
  summaryText,
  driveUrl,
  driveError,
}: Props) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.error;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {providerLabel}
      </p>
      <div className="flex items-center gap-3">
        <Badge
          variant={config.variant}
          className={`text-xs font-bold tracking-wide px-3 py-1${config.className ? ` ${config.className}` : ""}`}
        >
          {config.label}
        </Badge>
        {resultsCount > 0 && (
          <span className="text-sm text-muted-foreground">
            {resultsCount} {resultsCount === 1 ? "result" : "results"}
          </span>
        )}
      </div>
      <p className="text-sm">{summaryText}</p>
      {driveUrl && (
        <a
          href={driveUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-500 hover:underline"
        >
          View PDF in Drive →
        </a>
      )}
      {driveError && (
        <div className="space-y-1">
          <p className="text-sm text-destructive">
            Drive upload failed: {driveError}
          </p>
          {(driveError.includes("401") ||
            driveError.toLowerCase().includes("invalid_grant") ||
            driveError.toLowerCase().includes("invalid credentials") ||
            driveError.toLowerCase().includes("unauthenticated")) && (
            <p className="text-sm text-muted-foreground">
              Your Google session may have expired. Please sign out and sign
              back in to refresh your credentials.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 3: Commit**

```bash
git add src/components/ResultCard.tsx
git commit -m "feat: update ResultCard for new provider statuses"
```

---

### Task 10: Rewrite CheckForm

**Files:**
- Modify: `src/components/CheckForm.tsx`

Replace the Registry dropdown with a search type toggle and provider checkboxes. State changes from a single result to an array of per-provider results.

- [ ] **Step 1: Replace the contents of `src/components/CheckForm.tsx`**

```typescript
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResultCard } from "./ResultCard";
import type { ResultStatus, SmeClassification, TaxComplianceData } from "@/lib/types";

type SearchType = "individual" | "legal_entity";

interface ProviderResult {
  providerKey: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
  matchedEntities: Array<{ name: string; caseNumber?: string; status?: string }>;
  classification?: SmeClassification;
  complianceData?: TaxComplianceData;
}

interface ApiResponse {
  runGroupId: string;
  results: ProviderResult[];
  driveUrl?: string;
  driveError?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  avnt_insolvency: "AVNT Insolvency Register",
  rekvizitai_sme: "SME / Small Mid-Cap Classification",
  rekvizitai_tax: "Tax & Social Security Compliance",
};

export function CheckForm() {
  const [borrowerName, setBorrowerName] = useState("");
  const [idCode, setIdCode] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [searchType, setSearchType] = useState<SearchType>("individual");

  // Provider selection — AVNT always on; Rekvizitai only for legal entities
  const [avntChecked, setAvntChecked] = useState(true);
  const [smeChecked, setSmeChecked] = useState(false);
  const [taxChecked, setTaxChecked] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  function handleSearchTypeChange(type: SearchType) {
    setSearchType(type);
    if (type === "individual") {
      // Disable and uncheck Rekvizitai providers
      setSmeChecked(false);
      setTaxChecked(false);
    } else {
      // Enable and check Rekvizitai providers by default
      setSmeChecked(true);
      setTaxChecked(true);
    }
  }

  function getSelectedProviderKeys(): string[] {
    const keys: string[] = [];
    if (avntChecked) keys.push("avnt_insolvency");
    if (smeChecked) keys.push("rekvizitai_sme");
    if (taxChecked) keys.push("rekvizitai_tax");
    return keys;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const providerKeys = getSelectedProviderKeys();
    if (providerKeys.length === 0) {
      setError("Select at least one check to run.");
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);

    try {
      const res = await fetch("/api/checks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          borrowerName,
          idCode: idCode || undefined,
          driveFolderUrl,
          searchType,
          providerKeys,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "An unexpected error occurred");
        return;
      }

      setResponse(data);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const rekvizitaiDisabled = searchType === "individual";

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Search type toggle */}
        <div className="space-y-2">
          <Label>Search Type</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={searchType === "individual" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSearchTypeChange("individual")}
            >
              Individual
            </Button>
            <Button
              type="button"
              variant={searchType === "legal_entity" ? "default" : "outline"}
              size="sm"
              onClick={() => handleSearchTypeChange("legal_entity")}
            >
              Legal entity
            </Button>
          </div>
        </div>

        {/* Borrower Name */}
        <div className="space-y-2">
          <Label htmlFor="borrowerName">Borrower Name *</Label>
          <Input
            id="borrowerName"
            value={borrowerName}
            onChange={(e) => setBorrowerName(e.target.value)}
            placeholder="e.g. UAB Pavyzdys"
            required
          />
        </div>

        {/* ID Code */}
        <div className="space-y-2">
          <Label htmlFor="idCode">ID Code (optional)</Label>
          <Input
            id="idCode"
            value={idCode}
            onChange={(e) => setIdCode(e.target.value)}
            placeholder="Company or person code"
          />
        </div>

        {/* Provider checkboxes */}
        <div className="space-y-2">
          <Label>Checks to Run</Label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={avntChecked}
                onChange={(e) => setAvntChecked(e.target.checked)}
                className="rounded"
              />
              AVNT Insolvency Register
            </label>
            <label className={`flex items-center gap-2 text-sm ${rekvizitaiDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                checked={smeChecked}
                disabled={rekvizitaiDisabled}
                onChange={(e) => setSmeChecked(e.target.checked)}
                className="rounded"
              />
              SME / Small Mid-Cap Classification
              {rekvizitaiDisabled && (
                <span className="text-xs text-muted-foreground">(legal entity only)</span>
              )}
            </label>
            <label className={`flex items-center gap-2 text-sm ${rekvizitaiDisabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
              <input
                type="checkbox"
                checked={taxChecked}
                disabled={rekvizitaiDisabled}
                onChange={(e) => setTaxChecked(e.target.checked)}
                className="rounded"
              />
              Tax &amp; Social Security Compliance
              {rekvizitaiDisabled && (
                <span className="text-xs text-muted-foreground">(legal entity only)</span>
              )}
            </label>
          </div>
        </div>

        {/* Google Drive Folder URL */}
        <div className="space-y-2">
          <Label htmlFor="driveFolderUrl">Google Drive Folder URL *</Label>
          <Input
            id="driveFolderUrl"
            value={driveFolderUrl}
            onChange={(e) => setDriveFolderUrl(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/..."
            required
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Running checks…" : "Run Checks"}
        </Button>
      </form>

      {/* Results: one card per provider */}
      {response && (
        <div className="space-y-4">
          {response.results.map((result) => (
            <ResultCard
              key={result.providerKey}
              providerLabel={PROVIDER_LABELS[result.providerKey] ?? result.providerKey}
              status={result.status}
              resultsCount={result.resultsCount}
              summaryText={result.summaryText}
              driveUrl={response.driveUrl}
              driveError={response.driveError}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no new errors

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 4: Start dev server and manually verify the form renders correctly**

Run: `npm run dev`
Open: `http://localhost:3000/check`

Check:
- Toggle shows "Individual" selected by default
- AVNT checkbox is checked; Rekvizitai checkboxes are unchecked and disabled
- Switching to "Legal entity" enables and checks both Rekvizitai checkboxes
- Switching back to "Individual" disables and unchecks Rekvizitai checkboxes

- [ ] **Step 5: Commit**

```bash
git add src/components/CheckForm.tsx src/components/ResultCard.tsx
git commit -m "feat: update CheckForm with search type toggle and provider checkboxes"
```
