# Poland Extension Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the compliance-check tool to support Poland via KRZ insolvency checks, with a persistent per-user country selector (LT/PL) enforced by middleware.

**Architecture:** Country preference stored in `UserPreference` DB table + mirrored as an HttpOnly cookie for fast middleware enforcement. The existing LT flow is untouched. A new `krz_insolvency` provider handles all PL checks. Country is derived at the API layer from `searchType` (the single source of truth).

**Tech Stack:** Next.js 16 App Router, NextAuth JWT, Prisma/SQLite, Playwright, Vitest

> **⚠️ Next.js 16 breaking change:** In Next.js 16, "Middleware" was renamed to "Proxy". The file is `src/proxy.ts` (not `middleware.ts`) and the exported function is `proxy` (not `middleware`). See `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`.

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `UserPreference` model + `SearchRun.country` column |
| `src/lib/types.ts` | Modify | Extend `SearchType` (Task 2); extend `CheckProviderKey` atomically with registry (Task 8) |
| `src/app/api/user/country/route.ts` | Create | GET/PUT country preference API |
| `src/proxy.ts` | Create | Auth + country cookie enforcement (Next.js 16 Proxy) |
| `src/app/select-country/page.tsx` | Create | Country selection UI |
| `src/providers/krz-insolvency/index.ts` | Create | `KrzInsolvencyProvider` class |
| `src/providers/krz-insolvency/search.ts` | Create | Playwright automation for KRZ |
| `src/providers/registry.ts` | Modify | Register `krz_insolvency` |
| `src/app/api/checks/run/route.ts` | Modify | PL validation + country derivation |
| `src/components/CheckForm.tsx` | Modify | Accepts `country` prop, PL mode |
| `src/components/Nav.tsx` | Modify | Country badge |
| `src/app/check/page.tsx` | Modify | Read country cookie, pass to `CheckForm` |
| `src/components/HistoryTable.tsx` | Modify | Country column |
| `tests/api/user-country.test.ts` | Create | Tests for `/api/user/country` |
| `tests/api/checks-run.test.ts` | Modify | PL validation tests |
| `tests/providers/krz-insolvency.test.ts` | Create | Unit tests for KRZ result parsing |

---

## Chunk 1: Foundation — DB, Types, Country API, Middleware, Select-Country Page

### Task 1: DB schema migration

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add `UserPreference` model and `country` column to `SearchRun`**

Edit `prisma/schema.prisma` to:

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "sqlite"
}

model UserPreference {
  email     String   @id
  country   String
  updatedAt DateTime @updatedAt
}

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
  country              String?

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

```bash
npx prisma migrate dev --name add_user_preference_and_search_run_country
```

Expected: Migration file created under `prisma/migrations/`, Prisma client regenerated.

- [ ] **Step 3: Verify tests still pass**

```bash
npm test
```

Expected: All tests pass (schema change adds nullable column, no breaking change).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ src/generated/
git commit -m "feat: add UserPreference table and SearchRun.country column"
```

---

### Task 2: Extend `SearchType` for PL entity types

**Files:**
- Modify: `src/lib/types.ts`

Note: `CheckProviderKey` is **not** extended here. Adding `krz_insolvency` to `CheckProviderKey` is deferred to Task 8 where it is added atomically with the registry entry, to avoid a TypeScript build error between commits.

- [ ] **Step 1: Update `SearchType` only**

In `src/lib/types.ts`, replace:

```typescript
export type SearchType = "individual" | "legal_entity";
```

With:

```typescript
export type SearchType =
  | "individual"       // LT: natural person
  | "legal_entity"     // LT: company
  | "pl_company"       // PL/KRZ: Podmiot niebędący osobą fizyczną
  | "pl_business_ind"  // PL/KRZ: Osoba fizyczna prowadząca działalność gospodarczą
  | "pl_private_ind";  // PL/KRZ: Osoba fizyczna nieprowadząca działalności gospodarczej
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```

Expected: No errors. (Registry is untouched; `CheckProviderKey` is unchanged.)

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: extend SearchType with PL entity types"
```

---

### Task 3: `/api/user/country` route

**Files:**
- Create: `src/app/api/user/country/route.ts`
- Create: `tests/api/user-country.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/api/user-country.test.ts` (place it alongside the other API tests):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({
  db: {
    userPreference: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import { GET, PUT } from "@/app/api/user/country/route";
import { getServerSession } from "next-auth";
import { db } from "@/lib/db";

const mockSession = { user: { email: "tester@example.com" } };

describe("GET /api/user/country", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/user/country"));
    expect(res.status).toBe(401);
  });

  it("returns null when no preference stored", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.userPreference.findUnique).mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/user/country"));
    expect(res.status).toBe(200);
    expect((await res.json()).country).toBeNull();
  });

  it("returns stored country", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.userPreference.findUnique).mockResolvedValue({
      email: "tester@example.com",
      country: "PL",
      updatedAt: new Date(),
    } as any);
    const res = await GET(new NextRequest("http://localhost/api/user/country"));
    expect(res.status).toBe(200);
    expect((await res.json()).country).toBe("PL");
  });
});

describe("PUT /api/user/country", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await PUT(
      new NextRequest("http://localhost/api/user/country", {
        method: "PUT",
        body: JSON.stringify({ country: "LT" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid country value", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    const res = await PUT(
      new NextRequest("http://localhost/api/user/country", {
        method: "PUT",
        body: JSON.stringify({ country: "DE" }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("saves preference and sets cookie", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.userPreference.upsert).mockResolvedValue({
      email: "tester@example.com",
      country: "PL",
      updatedAt: new Date(),
    } as any);
    const res = await PUT(
      new NextRequest("http://localhost/api/user/country", {
        method: "PUT",
        body: JSON.stringify({ country: "PL" }),
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).country).toBe("PL");
    // Cookie should be set
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("country=PL");
    expect(setCookie).toContain("HttpOnly");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test tests/api/user-country.test.ts
```

Expected: FAIL — `GET` and `PUT` not found.

- [ ] **Step 3: Implement the route**

Create `src/app/api/user/country/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

const VALID_COUNTRIES = ["LT", "PL"] as const;
type Country = typeof VALID_COUNTRIES[number];

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year in seconds

export async function GET(_req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pref = await db.userPreference.findUnique({
    where: { email: session.user.email },
  });

  return NextResponse.json({ country: pref?.country ?? null });
}

export async function PUT(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const country = body.country as string;
  if (!VALID_COUNTRIES.includes(country as Country)) {
    return NextResponse.json(
      { error: `country must be one of: ${VALID_COUNTRIES.join(", ")}` },
      { status: 400 }
    );
  }

  await db.userPreference.upsert({
    where: { email: session.user.email },
    update: { country },
    create: { email: session.user.email, country },
  });

  const res = NextResponse.json({ country });
  res.cookies.set("country", country, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return res;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test tests/api/user-country.test.ts
```

Expected: All 6 tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/user/country/route.ts tests/api/user-country.test.ts
git commit -m "feat: add /api/user/country GET and PUT route"
```

---

### Task 4: Proxy (Next.js 16 auth + country guard)

**Files:**
- Create: `src/proxy.ts`

> **Next.js 16:** In this version, "Middleware" was renamed to "Proxy". The file is `src/proxy.ts` and the exported function must be named `proxy`. See `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` for the full reference.

The proxy runs in the Edge runtime — no Node.js modules, only `next/server`, `next-auth/jwt`, and cookie APIs.

- [ ] **Step 1: Create `src/proxy.ts`**

```typescript
import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const { pathname } = req.nextUrl;

  // 1. If not authenticated, redirect to sign-in for all protected routes
  if (!token) {
    const signInUrl = req.nextUrl.clone();
    signInUrl.pathname = "/api/auth/signin";
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  // 2. /select-country is allowed through for authenticated users without a country cookie.
  //    The page handles its own flow (auto-restore or manual selection).
  //    This guard MUST come before the cookie check to avoid an infinite redirect loop.
  if (pathname.startsWith("/select-country")) {
    return NextResponse.next();
  }

  // 3. For all other protected routes: if no valid country cookie, redirect to /select-country
  const country = req.cookies.get("country")?.value;
  if (!country || !["LT", "PL"].includes(country)) {
    const selectUrl = req.nextUrl.clone();
    selectUrl.pathname = "/select-country";
    return NextResponse.redirect(selectUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/check", "/check/:path*", "/history", "/history/:path*", "/select-country", "/select-country/:path*"],
};
```

- [ ] **Step 2: Verify the build succeeds**

```bash
npm run build 2>&1 | tail -20
```

Expected: Build succeeds.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: add proxy for auth and country cookie enforcement"
```

---

### Task 5: `/select-country` page

**Files:**
- Create: `src/app/select-country/page.tsx`

- [ ] **Step 1: Create the page**

Create `src/app/select-country/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Nav } from "@/components/Nav";

type Country = "LT" | "PL";

export default function SelectCountryPage() {
  const router = useRouter();
  const [autoRedirecting, setAutoRedirecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // On mount: check if a DB preference exists and auto-restore the cookie
    fetch("/api/user/country")
      .then((r) => r.json())
      .then(async (data) => {
        if (data.country) {
          // Re-set the cookie by calling PUT, then redirect
          const putRes = await fetch("/api/user/country", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ country: data.country }),
          });
          if (putRes.ok) {
            router.replace("/check");
            return;
          }
          // PUT failed — fall through to show selection UI
          setError("Could not restore your country preference — please select again.");
        }
        setAutoRedirecting(false);
      })
      .catch(() => {
        setAutoRedirecting(false);
      });
  }, [router]);

  async function handleSelect(country: Country) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/user/country", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ country }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to save preference. Please try again.");
        return;
      }
      router.replace("/check");
    } catch {
      setError("Network error — please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (autoRedirecting) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-xl px-4 py-16">
        <h1 className="text-xl font-semibold mb-2 text-center">Select your market</h1>
        <p className="text-sm text-muted-foreground mb-10 text-center">
          You can change this at any time from the navigation bar.
        </p>

        {error && (
          <p className="text-sm text-destructive text-center mb-6">{error}</p>
        )}

        <div className="grid grid-cols-2 gap-4">
          {(["LT", "PL"] as Country[]).map((c) => (
            <button
              key={c}
              onClick={() => handleSelect(c)}
              disabled={saving}
              className="rounded-lg border-2 border-border hover:border-primary p-8 flex flex-col items-center gap-3 transition-colors disabled:opacity-50"
            >
              <span className="text-4xl">{c === "LT" ? "🇱🇹" : "🇵🇱"}</span>
              <span className="font-semibold">{c === "LT" ? "Lithuania" : "Poland"}</span>
              <span className="text-xs text-muted-foreground">{c}</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass (no new tests for this page — it's pure UI with no testable logic).

- [ ] **Step 3: Commit**

```bash
git add src/app/select-country/page.tsx
git commit -m "feat: add /select-country page with auto-restore and error handling"
```

---

## Chunk 2: KRZ Provider + Registry + Run API

### Task 6: KRZ provider — all files in one atomic commit

**Files:**
- Create: `src/providers/krz-insolvency/search.ts`
- Create: `src/providers/krz-insolvency/index.ts`
- Modify: `src/lib/types.ts` (add `krz_insolvency` to `CheckProviderKey`)
- Modify: `src/providers/registry.ts`
- Create: `tests/providers/krz-insolvency.test.ts`

> **Why one commit:** `search.ts` uses `providerKey: "krz_insolvency"` in its return values, which is typed as `CheckProviderKey`. That value is not in `CheckProviderKey` until the type is extended. Adding `krz_insolvency` to `CheckProviderKey` also requires updating the exhaustive `Record<CheckProviderKey, ...>` in `registry.ts`. All four files must be committed together to keep `tsc --noEmit` clean at every commit boundary.

KRZ is an Angular SPA. After a search, its results are rendered in the DOM. The `document.body.innerText` will contain the result rows. We write a pure parse function (like `parseAvntResults`) that can be unit tested without Playwright.

- [ ] **Step 1: Write the failing tests**

Create `tests/providers/krz-insolvency.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { parseKrzResults } from "@/providers/krz-insolvency/search";

// Simulated body text when KRZ returns no results
const NO_RESULTS_PAGE = `
Wyszukiwanie podmiotów
Podmiot niebędący osobą fizyczną
Nazwa podmiotu
KRS
Szukaj
Brak wyników wyszukiwania
`;

// Simulated body text with a single match
const ONE_RESULT_PAGE = `
Wyszukiwanie podmiotów
Podmiot niebędący osobą fizyczną
ABC SP. Z O.O.
KRS: 0000123456
Status: postępowanie restrukturyzacyjne
Rodz. postęp.: Przyspieszone postępowanie układowe
Wyświetlanie 1 - 1 z 1 wyników
`;

// Simulated body text with multiple matches
const MULTI_RESULT_PAGE = `
Wyszukiwanie podmiotów
ABC SP. Z O.O.
KRS: 0000123456
ABC HOLDING SP. Z O.O.
KRS: 0000654321
Wyświetlanie 1 - 2 z 2 wyników
`;

describe("parseKrzResults", () => {
  it("returns no_match when page shows no results", () => {
    const result = parseKrzResults(NO_RESULTS_PAGE, "ABC");
    expect(result.status).toBe("no_match");
    expect(result.resultsCount).toBe(0);
    expect(result.matchedEntities).toHaveLength(0);
  });

  it("returns match_found for single result", () => {
    const result = parseKrzResults(ONE_RESULT_PAGE, "ABC");
    expect(result.status).toBe("match_found");
    expect(result.resultsCount).toBe(1);
  });

  it("returns ambiguous for multiple results", () => {
    const result = parseKrzResults(MULTI_RESULT_PAGE, "ABC");
    expect(result.status).toBe("ambiguous");
    expect(result.resultsCount).toBe(2);
  });

  it("includes summary text mentioning the borrower name", () => {
    const result = parseKrzResults(ONE_RESULT_PAGE, "ABC SP. Z O.O.");
    expect(result.summaryText).toContain("ABC SP. Z O.O.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test tests/providers/krz-insolvency.test.ts
```

Expected: FAIL — `parseKrzResults` not found.

- [ ] **Step 3: Create `src/providers/krz-insolvency/search.ts` with the parse function and Playwright automation**

```typescript
import { chromium } from "playwright";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

export const KRZ_BASE_URL = "https://krz.ms.gov.pl";
// Direct hash URL for the subject search page
const KRZ_SEARCH_URL =
  "https://krz.ms.gov.pl/#!/application/KRZPortalPUB/1.9/KrzRejPubGui.WyszukiwaniePodmiotow?params=JTdCJTdE&itemId=item-2&seq=0";

const NAV_TIMEOUT = 30_000;
const RESULT_TIMEOUT = 15_000;

// Maps our searchType values to the Polish label text on KRZ tabs/radios
const ENTITY_TYPE_LABELS: Record<string, string> = {
  pl_company: "Podmiot niebędący osobą fizyczną",
  pl_business_ind: "Osoba fizyczna prowadząca działalność gospodarczą",
  pl_private_ind: "Osoba fizyczna nieprowadząca działalności gospodarczej",
};

export async function runKrzSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "pl-PL",
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    // Navigate to the search page
    await page.goto(KRZ_SEARCH_URL, { waitUntil: "load" });
    await page.waitForTimeout(2000); // Allow Angular to bootstrap

    // Select entity type tab/radio
    const entityLabel = ENTITY_TYPE_LABELS[input.searchType];
    if (entityLabel) {
      // Try clicking a tab or radio button that contains the entity type label
      const tabSelectors = [
        `li:has-text("${entityLabel}")`,
        `label:has-text("${entityLabel}")`,
        `button:has-text("${entityLabel}")`,
        `[title="${entityLabel}"]`,
      ];
      for (const sel of tabSelectors) {
        try {
          await page.click(sel, { timeout: 5_000 });
          await page.waitForTimeout(500);
          break;
        } catch {
          // try next selector
        }
      }
    }

    // Fill name field — try multiple selector patterns
    const nameSelectors = [
      'input[placeholder*="Nazwa" i]',
      'input[placeholder*="nazwa" i]',
      'input[ng-model*="name" i]',
      'input[ng-model*="nazwa" i]',
      'input[type="text"]:first-of-type',
    ];
    let nameFilled = false;
    for (const sel of nameSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5_000 });
        await page.fill(sel, input.borrowerName.trim());
        nameFilled = true;
        break;
      } catch {
        // try next
      }
    }
    if (!nameFilled) {
      throw new Error(
        "Could not locate the name field on KRZ. The page structure may have changed."
      );
    }

    // Fill ID field if provided (KRS / NIP / PESEL — KRZ uses a single field)
    if (input.idCode) {
      const idSelectors = [
        'input[placeholder*="KRS" i]',
        'input[placeholder*="NIP" i]',
        'input[placeholder*="numer" i]',
        'input[ng-model*="krs" i]',
        'input[ng-model*="nip" i]',
      ];
      for (const sel of idSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 3_000 });
          await page.fill(sel, input.idCode.trim());
          break;
        } catch {
          // field not found — proceed without it
        }
      }
    }

    // Submit
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Szukaj")',
      'button:has-text("Wyszukaj")',
      'input[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        await page.click(sel, { timeout: 3_000 });
        submitted = true;
        break;
      } catch {
        // try next
      }
    }
    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    // Wait for results to render
    await page.waitForLoadState("load", { timeout: RESULT_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(2_500);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const { status, resultsCount, matchedEntities, summaryText } =
      parseKrzResults(bodyText, input.borrowerName);

    return {
      providerKey: "krz_insolvency",
      sourceUrl: finalUrl || KRZ_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount,
      matchedEntities,
      summaryText,
      screenshotBuffer,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      providerKey: "krz_insolvency",
      sourceUrl: KRZ_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `KRZ search failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse KRZ search results from the page body text.
 *
 * KRZ result pages contain a count string like:
 *   "Wyświetlanie 1 - N z M wyników"
 * where M is the total number of matching records.
 *
 * Zero-result pages contain "Brak wyników" (no results).
 *
 * Exported for unit testing.
 */
export function parseKrzResults(
  bodyText: string,
  borrowerName: string
): Pick<
  NormalizedCheckResult,
  "status" | "resultsCount" | "matchedEntities" | "summaryText"
> {
  const lower = bodyText.toLowerCase();

  // Primary signal: count string "Wyświetlanie X - Y z Z wyników"
  const countMatch = bodyText.match(
    /wyświetlanie\s+\d+\s*[-–]\s*\d+\s+z\s+(\d+)\s+wyników/i
  );
  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    const matchedEntities = extractEntities(bodyText, borrowerName);
    if (count === 0) {
      return {
        status: "no_match",
        resultsCount: 0,
        matchedEntities: [],
        summaryText: `No insolvency records found on KRZ for "${borrowerName}".`,
      };
    }
    if (count === 1) {
      return {
        status: "match_found",
        resultsCount: 1,
        matchedEntities,
        summaryText: `1 insolvency record found on KRZ matching "${borrowerName}".`,
      };
    }
    return {
      status: "ambiguous",
      resultsCount: count,
      matchedEntities,
      summaryText: `${count} insolvency records found on KRZ for "${borrowerName}". Manual review required.`,
    };
  }

  // Explicit no-result signal
  if (lower.includes("brak wyników") || lower.includes("nie znaleziono")) {
    return {
      status: "no_match",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `No insolvency records found on KRZ for "${borrowerName}".`,
    };
  }

  // Fallback: ambiguous — could not parse
  return {
    status: "ambiguous",
    resultsCount: 0,
    matchedEntities: [],
    summaryText:
      "KRZ search page loaded but results could not be parsed. Please review the screenshot in the PDF.",
  };
}

function extractEntities(
  bodyText: string,
  borrowerName: string
): Array<{ name: string; caseNumber?: string }> {
  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const firstWord = borrowerName.toLowerCase().split(" ")[0];
  return lines
    .filter((l) => l.toLowerCase().includes(firstWord))
    .slice(0, 10)
    .map((l) => ({ name: l }));
}
```

- [ ] **Step 4: Run unit tests to verify they pass**

```bash
npm test tests/providers/krz-insolvency.test.ts
```

Expected: All 4 tests pass.

- [ ] **Step 5: Run full suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 6: Create `src/providers/krz-insolvency/index.ts`**

```typescript
import { runKrzSearch } from "./search";
import type {
  PublicCheckProvider,
  RunCheckInput,
  NormalizedCheckResult,
} from "@/lib/types";

export class KrzInsolvencyProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runKrzSearch(input);
  }
}
```

- [ ] **Step 7: Add `krz_insolvency` to `CheckProviderKey` in `src/lib/types.ts`**

Replace:
```typescript
export type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax";
```

With:
```typescript
export type CheckProviderKey =
  | "avnt_insolvency"
  | "rekvizitai_sme"
  | "rekvizitai_tax"
  | "krz_insolvency";
```

- [ ] **Step 8: Register the provider in `src/providers/registry.ts`**

```typescript
import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";
import { RekvizitaiSmeProvider } from "./rekvizitai-sme";
import { RekvizitaiTaxProvider } from "./rekvizitai-tax";
import { KrzInsolvencyProvider } from "./krz-insolvency";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
  rekvizitai_sme: new RekvizitaiSmeProvider(),
  rekvizitai_tax: new RekvizitaiTaxProvider(),
  krz_insolvency: new KrzInsolvencyProvider(),
};

function isCheckProviderKey(key: string): key is CheckProviderKey {
  return key in providers;
}

export function getProvider(key: string): PublicCheckProvider | null {
  if (!isCheckProviderKey(key)) return null;
  return providers[key];
}
```

- [ ] **Step 9: Verify TypeScript compiles cleanly**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 10: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 11: Commit all KRZ provider files together**

```bash
git add src/providers/krz-insolvency/search.ts src/providers/krz-insolvency/index.ts \
        src/lib/types.ts src/providers/registry.ts \
        tests/providers/krz-insolvency.test.ts
git commit -m "feat: add KRZ insolvency provider, extend CheckProviderKey, register in registry"
```

---

### Task 7: Update `/api/checks/run` for PL

**Files:**
- Modify: `src/app/api/checks/run/route.ts`
- Modify: `tests/api/checks-run.test.ts`

- [ ] **Step 1: Write new failing tests for PL validation**

Add to `tests/api/checks-run.test.ts` (add these `it` blocks inside the existing `describe`):

```typescript
// Add this import at the top of the test file with the other mock imports:
// (runRekvizitaiCombined is already mocked)

it("returns 400 for invalid searchType", async () => {
  vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
  vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
  vi.mocked(getProvider).mockReturnValue({ runSearch: vi.fn() });
  const res = await POST(
    makeReq({ ...validBody, searchType: "unknown_type" })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/searchType/i);
});

it("returns 400 when PL search type used with LT provider", async () => {
  vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
  vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
  vi.mocked(getProvider).mockReturnValue({ runSearch: vi.fn() });
  const res = await POST(
    makeReq({
      ...validBody,
      searchType: "pl_company",
      providerKeys: ["avnt_insolvency"],
    })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/provider/i);
});

it("returns 400 when LT search type used with KRZ provider", async () => {
  vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
  vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
  vi.mocked(getProvider).mockReturnValue({ runSearch: vi.fn() });
  const res = await POST(
    makeReq({
      ...validBody,
      searchType: "legal_entity",
      providerKeys: ["krz_insolvency"],
    })
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/provider/i);
});
```

- [ ] **Step 2: Run tests to verify new ones fail**

```bash
npm test tests/api/checks-run.test.ts
```

Expected: 3 new tests fail, existing tests pass.

- [ ] **Step 3: Update the run route**

In `src/app/api/checks/run/route.ts`, make these changes:

**a) Replace the `REKVIZITAI_KEYS` constant and `searchType` parsing:**

```typescript
// Remove:
const REKVIZITAI_KEYS: CheckProviderKey[] = ["rekvizitai_sme", "rekvizitai_tax"];

// Add at top of file, after imports:
const VALID_SEARCH_TYPES: SearchType[] = [
  "individual",
  "legal_entity",
  "pl_company",
  "pl_business_ind",
  "pl_private_ind",
];

const LT_PROVIDERS = new Set<CheckProviderKey>([
  "avnt_insolvency",
  "rekvizitai_sme",
  "rekvizitai_tax",
]);
const PL_PROVIDERS = new Set<CheckProviderKey>(["krz_insolvency"]);

function deriveCountry(st: SearchType): "LT" | "PL" {
  return st === "pl_company" || st === "pl_business_ind" || st === "pl_private_ind"
    ? "PL"
    : "LT";
}
```

**b) Replace the `searchType` parsing line:**

```typescript
// Remove:
const searchType: SearchType = body.searchType === "legal_entity" ? "legal_entity" : "individual";

// Replace with:
const rawSearchType = body.searchType as string;
if (!VALID_SEARCH_TYPES.includes(rawSearchType as SearchType)) {
  return NextResponse.json(
    { error: `Invalid searchType. Must be one of: ${VALID_SEARCH_TYPES.join(", ")}` },
    { status: 400 }
  );
}
const searchType = rawSearchType as SearchType;
const country = deriveCountry(searchType);
const allowedProviders = country === "PL" ? PL_PROVIDERS : LT_PROVIDERS;
```

**c) Replace the two validation passes with a single per-country whitelist check:**

```typescript
// Remove Pass 1 (key recognition check stays) and Pass 2 (rekvizitai individual check).
// Replace Pass 2 with:

// Pass 2: Provider must belong to the derived country
for (const key of providerKeys as string[]) {
  if (!allowedProviders.has(key as CheckProviderKey)) {
    return NextResponse.json(
      {
        error: `Provider "${key}" is not available for ${country} searches`,
      },
      { status: 400 }
    );
  }
}
```

**d) Save `country` on each `SearchRun.create` call:**

In the `db.searchRun.create` call, add `country` to the `data` object:

```typescript
data: {
  // ... existing fields ...
  country,
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/checks/run/route.ts tests/api/checks-run.test.ts
git commit -m "feat: update run API for PL searchType, country derivation and provider whitelist"
```

---

## Chunk 3: UI — CheckForm, Nav, Check Page, History

### Task 8: Update `CheckForm` for PL mode

**Files:**
- Modify: `src/components/CheckForm.tsx`

- [ ] **Step 1: Update `CheckForm` to accept a `country` prop and render PL mode**

Replace the entire content of `src/components/CheckForm.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResultCard } from "./ResultCard";
import type { ResultStatus, SmeClassification, TaxComplianceData } from "@/lib/types";

type Country = "LT" | "PL";
type SearchType =
  | "individual"
  | "legal_entity"
  | "pl_company"
  | "pl_business_ind"
  | "pl_private_ind";

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
  krz_insolvency: "KRZ Insolvency Register",
};

const PL_SEARCH_TYPES: { value: SearchType; label: string }[] = [
  { value: "pl_company", label: "Podmiot (spółka / organizacja)" },
  { value: "pl_business_ind", label: "Osoba fizyczna – działalność gospodarcza" },
  { value: "pl_private_ind", label: "Osoba fizyczna – bez działalności" },
];

interface CheckFormProps {
  country: Country;
}

export function CheckForm({ country }: CheckFormProps) {
  const isLT = country === "LT";

  const [borrowerName, setBorrowerName] = useState("");
  const [idCode, setIdCode] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");

  // LT: individual / legal_entity toggle
  const [ltSearchType, setLtSearchType] = useState<"individual" | "legal_entity">("individual");
  // PL: one of three entity types
  const [plSearchType, setPlSearchType] = useState<SearchType>("pl_company");

  // LT provider checkboxes
  const [avntChecked, setAvntChecked] = useState(true);
  const [smeChecked, setSmeChecked] = useState(false);
  const [taxChecked, setTaxChecked] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  function handleLtSearchTypeChange(type: "individual" | "legal_entity") {
    setLtSearchType(type);
    if (type === "individual") {
      setSmeChecked(false);
      setTaxChecked(false);
    } else {
      setSmeChecked(true);
      setTaxChecked(true);
    }
  }

  function getSearchType(): SearchType {
    return isLT ? ltSearchType : plSearchType;
  }

  function getSelectedProviderKeys(): string[] {
    if (!isLT) return ["krz_insolvency"];
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
          searchType: getSearchType(),
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

  const rekvizitaiDisabled = isLT && ltSearchType === "individual";

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">

        {/* Search type — LT: toggle buttons, PL: radio group */}
        <div className="space-y-2">
          <Label>Search Type</Label>
          {isLT ? (
            <div className="flex gap-2">
              <Button
                type="button"
                variant={ltSearchType === "individual" ? "default" : "outline"}
                size="sm"
                onClick={() => handleLtSearchTypeChange("individual")}
              >
                Individual
              </Button>
              <Button
                type="button"
                variant={ltSearchType === "legal_entity" ? "default" : "outline"}
                size="sm"
                onClick={() => handleLtSearchTypeChange("legal_entity")}
              >
                Legal entity
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              {PL_SEARCH_TYPES.map(({ value, label }) => (
                <label key={value} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="plSearchType"
                    value={value}
                    checked={plSearchType === value}
                    onChange={() => setPlSearchType(value)}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Borrower Name */}
        <div className="space-y-2">
          <Label htmlFor="borrowerName">Borrower Name *</Label>
          <Input
            id="borrowerName"
            value={borrowerName}
            onChange={(e) => setBorrowerName(e.target.value)}
            placeholder={isLT ? "e.g. UAB Pavyzdys" : "e.g. ABC Sp. z o.o."}
            required
          />
        </div>

        {/* ID Code */}
        <div className="space-y-2">
          <Label htmlFor="idCode">
            {isLT ? "ID Code (optional)" : "KRS / NIP / PESEL (optional)"}
          </Label>
          <Input
            id="idCode"
            value={idCode}
            onChange={(e) => setIdCode(e.target.value)}
            placeholder={isLT ? "Company or person code" : "KRS, NIP or PESEL number"}
          />
        </div>

        {/* Checks to run */}
        <div className="space-y-2">
          <Label>Checks to Run</Label>
          {isLT ? (
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
          ) : (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked
                  disabled
                  className="rounded"
                />
                KRZ Insolvency Register
              </label>
            </div>
          )}
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

      {/* Results */}
      {response && (
        <div className="space-y-4">
          {response.results.map((result) => (
            <ResultCard
              key={result.providerKey}
              providerLabel={PROVIDER_LABELS[result.providerKey] ?? result.providerKey}
              status={result.status}
              resultsCount={result.resultsCount}
              summaryText={result.summaryText}
            />
          ))}
          {response.driveUrl && (
            <a
              href={response.driveUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-500 hover:underline block"
            >
              View combined PDF in Drive →
            </a>
          )}
          {response.driveError && (
            <p className="text-sm text-destructive">
              Drive upload failed: {response.driveError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass (CheckForm is a client component; no unit tests touch it directly).

- [ ] **Step 3: Commit**

```bash
git add src/components/CheckForm.tsx
git commit -m "feat: update CheckForm to support LT/PL country modes"
```

---

### Task 9: Update `/check/page.tsx` to pass country

**Files:**
- Modify: `src/app/check/page.tsx`

- [ ] **Step 1: Read the country cookie server-side and pass to `CheckForm`**

Replace `src/app/check/page.tsx`:

```tsx
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { CheckForm } from "@/components/CheckForm";

export default async function CheckPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin?callbackUrl=/check");

  const cookieStore = await cookies();
  const country = (cookieStore.get("country")?.value ?? "LT") as "LT" | "PL";

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-xl font-semibold mb-6">Run a Compliance Check</h1>
        <CheckForm country={country} />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/check/page.tsx
git commit -m "feat: pass country cookie to CheckForm from check page"
```

---

### Task 10: Nav country badge

**Files:**
- Modify: `src/components/Nav.tsx`

- [ ] **Step 1: Add country badge to Nav**

Replace `src/components/Nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function Nav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [country, setCountry] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/user/country")
      .then((r) => r.json())
      .then((d) => setCountry(d.country ?? null))
      .catch(() => {});
  }, []);

  return (
    <nav className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <span className="font-semibold text-sm">Public Registry Check</span>
          <Link
            href="/check"
            className={`text-sm transition-colors hover:text-foreground ${
              pathname === "/check"
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            Run Check
          </Link>
          <Link
            href="/history"
            className={`text-sm transition-colors hover:text-foreground ${
              pathname === "/history"
                ? "text-foreground font-medium"
                : "text-muted-foreground"
            }`}
          >
            History
          </Link>
        </div>
        <div className="flex items-center gap-3">
          {country && (
            <Link
              href="/select-country"
              className="text-xs font-medium px-2 py-1 rounded border border-border hover:bg-muted transition-colors"
              title="Change market"
            >
              {country === "LT" ? "🇱🇹" : "🇵🇱"} {country}
            </Link>
          )}
          <span className="text-xs text-muted-foreground">
            {session?.user?.email}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/api/auth/signin?callbackUrl=/check" })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/Nav.tsx
git commit -m "feat: add country badge to Nav"
```

---

### Task 11: History — add Country column

**Files:**
- Modify: `src/components/HistoryTable.tsx`
- Modify: `src/app/api/history/route.ts`

- [ ] **Step 1: Add `country` to the history API response**

In `src/app/api/history/route.ts`, add `country: true` to the `select` object:

```typescript
select: {
  id: true,
  createdAt: true,
  createdByEmail: true,
  borrowerName: true,
  borrowerIdCode: true,
  loanReference: true,
  providerKey: true,
  resultStatus: true,
  resultsCount: true,
  matchedSummary: true,
  uploadedFileUrl: true,
  country: true,        // ADD THIS
},
```

- [ ] **Step 2: Add `country` to the `HistoryRow` interface and table**

In `src/components/HistoryTable.tsx`:

**a)** Add `country: string | null` to the `HistoryRow` interface.

**b)** Add a `Country` column header after `Date`:

```tsx
<TableHead>Country</TableHead>
```

**c)** Add the cell in each row after the date cell:

```tsx
<TableCell className="text-xs font-medium text-muted-foreground">
  {run.country ?? "LT"}
</TableCell>
```

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/HistoryTable.tsx src/app/api/history/route.ts
git commit -m "feat: add Country column to history table"
```

---

## Final verification

- [ ] **Run the full test suite one last time**

```bash
npm test
```

Expected: All tests pass.

- [ ] **TypeScript compile check**

```bash
npx tsc --noEmit
```

Expected: No errors.
