# Public Registry Check Tool — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Next.js internal tool for loan operations teams to run public-registry compliance checks and upload PDF evidence to Google Drive.

**Architecture:** App Router + single `POST /api/checks/run` route orchestrating Playwright search → pdf-lib evidence generation → Google Drive upload → Prisma audit log. SQLite database. NextAuth Google OAuth with JWT sessions.

**Tech Stack:** Next.js 15, TypeScript, Tailwind CSS, shadcn/ui, Prisma (SQLite), NextAuth v4, Playwright, pdf-lib, googleapis, Vitest

---

## File Map

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | SQLite schema — single `SearchRun` model |
| `src/lib/types.ts` | Shared TypeScript types (`RunCheckInput`, `NormalizedCheckResult`, `PublicCheckProvider`, session augmentation) |
| `src/lib/db.ts` | Prisma client singleton |
| `src/lib/auth.ts` | NextAuth config — Google provider, JWT strategy, Drive scope, token passthrough |
| `src/providers/avnt-insolvency/search.ts` | Playwright automation for AVNT insolvency register (provided) |
| `src/providers/avnt-insolvency/index.ts` | `AvntInsolvencyProvider` wrapping `runAvntSearch` |
| `src/providers/registry.ts` | `CheckProviderKey` → provider instance map, `getProvider(key)` |
| `src/services/evidence.ts` | PDF evidence report generator — pdf-lib (provided) |
| `src/services/drive.ts` | `extractFolderIdFromUrl` + `uploadFileToDrive` |
| `src/app/api/auth/[...nextauth]/route.ts` | NextAuth route handler (GET + POST) |
| `src/app/api/checks/run/route.ts` | `POST /api/checks/run` — 8-step pipeline orchestration |
| `src/app/api/history/route.ts` | `GET /api/history?page=N&limit=20` |
| `src/components/Nav.tsx` | Top navigation bar with links and sign-out |
| `src/components/ResultCard.tsx` | Result status badge + summary + Drive link |
| `src/components/CheckForm.tsx` | Controlled form — calls POST, shows loading state + ResultCard |
| `src/components/HistoryTable.tsx` | Paginated audit log table fetching GET /api/history |
| `src/app/layout.tsx` | Root layout with SessionProvider |
| `src/app/page.tsx` | Redirect to `/check` |
| `src/app/check/page.tsx` | Check page — auth-gated, renders CheckForm |
| `src/app/history/page.tsx` | History page — auth-gated, renders HistoryTable |
| `tests/services/drive.test.ts` | Unit tests for `extractFolderIdFromUrl` |
| `tests/api/checks-run.test.ts` | Integration tests for POST /api/checks/run |
| `tests/api/history.test.ts` | Integration tests for GET /api/history |

---

## Chunk 1: Bootstrap

### Task 1: Initialise Next.js project

**Files:**
- Create: `package.json`, `next.config.ts`, `tsconfig.json`, `tailwind.config.ts`, standard Next.js scaffold

- [ ] **Step 1: Scaffold the project**

Run from `/Users/panpimboonchuay/panpim`:
```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-git --yes
```

Expected: Next.js files created (package.json, src/app/layout.tsx, etc.)

- [ ] **Step 2: Verify dev server starts**

```bash
npm run dev
```

Open http://localhost:3000. Expected: default Next.js page loads. Stop the server (Ctrl+C).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js project"
```

---

### Task 2: Install project dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime dependencies**

```bash
npm install next-auth @prisma/client playwright pdf-lib googleapis uuid
npm install --save-dev prisma @types/uuid vitest @vitejs/plugin-react vite-tsconfig-paths
```

- [ ] **Step 2: Install Playwright browser**

```bash
npx playwright install chromium
```

Expected: Chromium downloads successfully.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: install dependencies"
```

---

### Task 3: Configure Vitest

**Files:**
- Create: `vitest.config.ts`
- Create: `tests/services/drive.test.ts` (placeholder)

- [ ] **Step 1: Create placeholder test**

Create `tests/services/drive.test.ts`:
```typescript
import { describe, it, expect } from "vitest";

describe("placeholder", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Create vitest.config.ts**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    environment: "node",
    globals: true,
  },
});
```

- [ ] **Step 3: Add test scripts to package.json**

In `package.json` `scripts`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Run tests**

```bash
npm test
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json tests/
git commit -m "feat: configure Vitest test runner"
```

---

### Task 4: Set up environment variables

**Files:**
- Create: `.env.example`
- Create: `.env.local` (gitignored)

- [ ] **Step 1: Create .env.example**

Create `.env.example`:
```
DATABASE_URL="file:./data/checks.db"
NEXTAUTH_SECRET="replace-with-output-of-openssl-rand-base64-32"
NEXTAUTH_URL="http://localhost:3000"
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="your-client-secret"
```

- [ ] **Step 2: Create .env.local with real values**

```bash
cp .env.example .env.local
```

Edit `.env.local`:
- `NEXTAUTH_SECRET`: run `openssl rand -base64 32` and paste the output
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: from Google Cloud Console
- Leave `DATABASE_URL` and `NEXTAUTH_URL` as-is for local dev

- [ ] **Step 3: Ensure .env.local is gitignored**

Verify `.gitignore` contains `*.local` or `.env.local`. The create-next-app scaffold adds this automatically — confirm it is present.

- [ ] **Step 4: Create data directory and gitignore the db file**

```bash
mkdir -p data
echo "*.db" >> .gitignore
```

- [ ] **Step 5: Commit**

```bash
git add .env.example .gitignore
git commit -m "feat: add environment variable config"
```

---

### Task 5: Configure Prisma

**Files:**
- Create: `prisma/schema.prisma`
- Create: `prisma/migrations/` (generated)

- [ ] **Step 1: Initialise Prisma**

```bash
npx prisma init --datasource-provider sqlite
```

Expected: `prisma/schema.prisma` created. Delete the generated `.env` file — we use `.env.local`:
```bash
rm .env
```

- [ ] **Step 2: Write the schema**

Replace the contents of `prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
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

  resultStatus         String
  resultsCount         Int
  matchedSummary       String?

  uploadedFileId       String?
  uploadedFileUrl      String?

  requestPayloadJson   String?
  normalizedResultJson String?
}
```

- [ ] **Step 3: Run migration**

```bash
npx prisma migrate dev --name init
```

Expected: `prisma/migrations/` created, `data/checks.db` created.

- [ ] **Step 4: Generate Prisma client**

```bash
npx prisma generate
```

Expected: `node_modules/.prisma/client` generated.

- [ ] **Step 5: Commit**

```bash
git add prisma/ package.json
git commit -m "feat: add Prisma schema and SQLite migration"
```

---

### Task 6: Initialise shadcn/ui

**Files:**
- Create: `src/components/ui/` (generated)
- Modify: `tailwind.config.ts`, `src/app/globals.css`

- [ ] **Step 1: Initialise shadcn**

```bash
npx shadcn@latest init --defaults
```

When prompted: accept default style (New York), base colour (Neutral), CSS variables (yes).

- [ ] **Step 2: Add required components**

```bash
npx shadcn@latest add button input label select table badge
```

Expected: components added to `src/components/ui/`.

- [ ] **Step 3: Verify components exist**

```bash
ls src/components/ui/
```

Expected: `button.tsx`, `input.tsx`, `label.tsx`, `select.tsx`, `table.tsx`, `badge.tsx` present.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/ tailwind.config.ts src/app/globals.css components.json
git commit -m "feat: initialise shadcn/ui with base components"
```

---

## Chunk 2: Core Layer

### Task 7: Shared types

**Files:**
- Create: `src/lib/types.ts`

- [ ] **Step 1: Write types**

Create `src/lib/types.ts`:
```typescript
import type { DefaultSession } from "next-auth";

export type CheckProviderKey = "avnt_insolvency";

export type ResultStatus = "no_match" | "match_found" | "ambiguous" | "error";

export interface RunCheckInput {
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;
  providerKey: CheckProviderKey;
}

export interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
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
}

export interface PublicCheckProvider {
  runSearch(input: RunCheckInput): Promise<NormalizedCheckResult>;
}

// Extend next-auth Session to carry the user's Google access token
declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: add shared TypeScript types"
```

---

### Task 8: Prisma client singleton

**Files:**
- Create: `src/lib/db.ts`

- [ ] **Step 1: Write db.ts**

Create `src/lib/db.ts`:
```typescript
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const db = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat: add Prisma client singleton"
```

---

### Task 9: NextAuth configuration

**Files:**
- Create: `src/lib/auth.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`

- [ ] **Step 1: Write auth.ts**

Create `src/lib/auth.ts`:
```typescript
import GoogleProvider from "next-auth/providers/google";
import type { NextAuthOptions } from "next-auth";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope:
            "openid email profile https://www.googleapis.com/auth/drive.file",
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
      }
      return token;
    },
    async session({ session, token }) {
      (session as any).accessToken = token.accessToken as string;
      return session;
    },
  },
};
```

- [ ] **Step 2: Write NextAuth route handler**

Create `src/app/api/auth/[...nextauth]/route.ts`:
```typescript
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/auth.ts src/app/api/auth/
git commit -m "feat: configure NextAuth with Google OAuth and Drive scope"
```

---

### Task 10: Provider registry and AVNT provider

**Files:**
- Create: `src/providers/avnt-insolvency/search.ts`
- Create: `src/providers/avnt-insolvency/index.ts`
- Create: `src/providers/registry.ts`

- [ ] **Step 1: Place the AVNT search implementation**

Create `src/providers/avnt-insolvency/search.ts` with the full Playwright automation. The import path for types must use `@/lib/types` (not `@/types`). Full content:

```typescript
/**
 * AVNT Insolvency Register — Playwright automation layer
 */
import { chromium } from "playwright";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

export const AVNT_BASE_URL = "https://www.avnt.lt/veikla/nemokumo-procesai/";

const NAV_TIMEOUT = 30_000;
const RESULT_TIMEOUT = 15_000;

export async function runAvntSearch(
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
    page.setDefaultTimeout(NAV_TIMEOUT);

    await page.goto(AVNT_BASE_URL, { waitUntil: "networkidle" });

    const nameFieldSelectors = [
      'input[name="vardas"]',
      'input[name="name"]',
      'input[placeholder*="pavadinimas" i]',
      'input[placeholder*="vardas" i]',
      'input[placeholder*="name" i]',
      'input[type="text"]:first-of-type',
    ];

    let nameFieldFilled = false;
    for (const selector of nameFieldSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3_000 });
        await page.fill(selector, input.borrowerName);
        nameFieldFilled = true;
        break;
      } catch {
        // try next selector
      }
    }

    if (!nameFieldFilled) {
      throw new Error(
        "Could not locate the borrower name field on the AVNT page. " +
          "The page structure may have changed — update nameFieldSelectors in search.ts."
      );
    }

    if (input.idCode) {
      const idFieldSelectors = [
        'input[name="kodas"]',
        'input[name="code"]',
        'input[placeholder*="kodas" i]',
        'input[placeholder*="code" i]',
      ];
      for (const selector of idFieldSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 2_000 });
          await page.fill(selector, input.idCode);
          break;
        } catch {
          // field not present — that is fine, ID is optional
        }
      }
    }

    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Ieškoti")',
      'button:has-text("Search")',
    ];

    let submitted = false;
    for (const selector of submitSelectors) {
      try {
        await page.click(selector, { timeout: 3_000 });
        submitted = true;
        break;
      } catch {
        // try next
      }
    }

    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    await page
      .waitForLoadState("networkidle", { timeout: RESULT_TIMEOUT })
      .catch(() => {});
    await page.waitForTimeout(1_500);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);

    const { status, resultsCount, matchedEntities, summaryText } =
      parseAvntResults(bodyText, input.borrowerName);

    return {
      providerKey: "avnt_insolvency",
      sourceUrl: finalUrl || AVNT_BASE_URL,
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
      providerKey: "avnt_insolvency",
      sourceUrl: AVNT_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `Search failed: ${message}`,
    };
  } finally {
    if (browser) await browser.close();
  }
}

function parseAvntResults(
  bodyText: string,
  borrowerName: string
): Pick<
  NormalizedCheckResult,
  "status" | "resultsCount" | "matchedEntities" | "summaryText"
> {
  const lower = bodyText.toLowerCase();

  const noResultSignals = [
    "nerasta",
    "rezultatų nerasta",
    "nothing found",
    "no results",
    "0 įrašų",
    "0 records",
    "nėra duomenų",
  ];
  if (noResultSignals.some((s) => lower.includes(s))) {
    return {
      status: "no_match",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `No insolvency records found on AVNT for the name "${borrowerName}".`,
    };
  }

  const recordSignals = [
    "bankrotas",
    "restruktūrizavimas",
    "nemokumas",
    "insolvency",
    "bankruptcy",
  ];
  let recordCount = 0;
  for (const signal of recordSignals) {
    const regex = new RegExp(signal, "gi");
    const matches = bodyText.match(regex);
    if (matches) recordCount = Math.max(recordCount, matches.length);
  }

  if (recordCount === 0) {
    return {
      status: "ambiguous",
      resultsCount: 0,
      matchedEntities: [],
      summaryText:
        "Search page loaded but result could not be clearly parsed. " +
        "Please review the attached screenshot.",
    };
  }

  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const matchedEntities = lines
    .filter((l) =>
      l.toLowerCase().includes(borrowerName.toLowerCase().split(" ")[0])
    )
    .slice(0, 10)
    .map((l) => ({ name: l }));

  const status = recordCount > 1 ? "ambiguous" : "match_found";
  const summaryText =
    status === "match_found"
      ? `1 insolvency record found on AVNT matching "${borrowerName}".`
      : `${recordCount} possible insolvency records found on AVNT for "${borrowerName}". Manual review required.`;

  return { status, resultsCount: recordCount, matchedEntities, summaryText };
}
```

- [ ] **Step 2: Write the provider wrapper**

Create `src/providers/avnt-insolvency/index.ts`:
```typescript
import { runAvntSearch } from "./search";
import type {
  PublicCheckProvider,
  RunCheckInput,
  NormalizedCheckResult,
} from "@/lib/types";

export class AvntInsolvencyProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runAvntSearch(input);
  }
}
```

- [ ] **Step 3: Write the provider registry**

Create `src/providers/registry.ts`:
```typescript
import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
};

export function getProvider(key: string): PublicCheckProvider | null {
  return providers[key as CheckProviderKey] ?? null;
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/providers/
git commit -m "feat: add AVNT provider and registry"
```

---

### Task 11: Evidence service

**Files:**
- Create: `src/services/evidence.ts`

- [ ] **Step 1: Place evidence service**

Create `src/services/evidence.ts` with the full pdf-lib implementation. The import path for types must use `@/lib/types`. Full content:

```typescript
/**
 * Evidence PDF generator
 */
import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";
import { v4 as uuidv4 } from "uuid";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

const BRAND_BLUE = rgb(0.07, 0.27, 0.55);
const GREY = rgb(0.4, 0.4, 0.4);
const BLACK = rgb(0, 0, 0);
const RED = rgb(0.75, 0.1, 0.1);
const GREEN = rgb(0.07, 0.52, 0.18);
const ORANGE = rgb(0.85, 0.45, 0.0);

export async function generateEvidencePdf(
  input: RunCheckInput,
  result: NormalizedCheckResult,
  filename: string
): Promise<Buffer> {
  const requestId = uuidv4();
  const doc = await PDFDocument.create();

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const cover = doc.addPage(PageSizes.A4);
  const { width, height } = cover.getSize();
  const margin = 50;
  let y = height - margin;

  cover.drawRectangle({
    x: 0,
    y: height - 70,
    width,
    height: 70,
    color: BRAND_BLUE,
  });
  cover.drawText("Public Registry Check — Evidence Report", {
    x: margin,
    y: height - 45,
    font: bold,
    size: 16,
    color: rgb(1, 1, 1),
  });

  y = height - 110;

  drawSection(cover, bold, "Run Information", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Search type:", getProviderLabel(result.providerKey), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Source name:", "AVNT Insolvency Register", margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Search timestamp:", formatDate(result.searchedAt), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Initiated by:", input.initiatedByEmail, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Request ID:", requestId, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Evidence filename:", filename, margin, y);
  y -= 30;

  drawSection(cover, bold, "Search Input", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Borrower name:", input.borrowerName, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "ID code:", input.idCode ?? "(not provided)", margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Loan reference:", input.loanReference ?? "(not provided)", margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Source URL:", result.sourceUrl, margin, y, 9);
  y -= 30;

  drawSection(cover, bold, "Search Result", margin, y, width - margin * 2);
  y -= 20;

  const statusColor =
    result.status === "no_match"
      ? GREEN
      : result.status === "match_found"
      ? RED
      : result.status === "ambiguous"
      ? ORANGE
      : GREY;

  const statusLabel: Record<string, string> = {
    no_match: "NO RECORD FOUND",
    match_found: "RECORD FOUND",
    ambiguous: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    error: "TECHNICAL ERROR",
  };

  cover.drawRectangle({
    x: margin,
    y: y - 28,
    width: width - margin * 2,
    height: 34,
    color: statusColor,
    borderRadius: 4,
  });
  cover.drawText(statusLabel[result.status] ?? result.status.toUpperCase(), {
    x: margin + 12,
    y: y - 14,
    font: bold,
    size: 14,
    color: rgb(1, 1, 1),
  });
  y -= 48;

  drawRow(cover, regular, bold, "Results count:", String(result.resultsCount), margin, y);
  y -= 18;

  const summaryLines = wrapText(result.summaryText, 90);
  cover.drawText("Summary:", { x: margin, y, font: bold, size: 9, color: GREY });
  y -= 14;
  for (const line of summaryLines) {
    cover.drawText(line, { x: margin + 10, y, font: regular, size: 9, color: BLACK });
    y -= 13;
  }
  y -= 10;

  if (result.matchedEntities.length > 0) {
    drawSection(cover, bold, "Matched Entities", margin, y, width - margin * 2);
    y -= 20;
    for (const entity of result.matchedEntities.slice(0, 20)) {
      const entityLine = [entity.name, entity.caseNumber ? `Case: ${entity.caseNumber}` : "", entity.status ?? ""]
        .filter(Boolean)
        .join("  |  ");
      const wrapped = wrapText(entityLine, 90);
      for (const line of wrapped) {
        cover.drawText(`• ${line}`, { x: margin + 8, y, font: regular, size: 8, color: BLACK });
        y -= 12;
      }
      if (y < margin + 50) break;
    }
  }

  cover.drawLine({
    start: { x: margin, y: margin + 20 },
    end: { x: width - margin, y: margin + 20 },
    color: GREY,
    thickness: 0.5,
  });
  cover.drawText(
    `Generated: ${formatDate(new Date().toISOString())}   |   Request ID: ${requestId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
    { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
  );

  if (result.screenshotBuffer) {
    try {
      const screenshotPage = doc.addPage(PageSizes.A4);
      const { width: sw, height: sh } = screenshotPage.getSize();

      screenshotPage.drawText("Search Results Screenshot", {
        x: margin,
        y: sh - margin - 16,
        font: bold,
        size: 12,
        color: BRAND_BLUE,
      });
      screenshotPage.drawText(`Source: ${result.sourceUrl}`, {
        x: margin,
        y: sh - margin - 32,
        font: regular,
        size: 8,
        color: GREY,
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
      // If embedding fails skip — cover page still valid
    }
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

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
    avnt_insolvency: "Insolvency check — AVNT",
  };
  return labels[key] ?? key;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/evidence.ts
git commit -m "feat: add evidence PDF generator service"
```

---

### Task 12: Drive service

**Files:**
- Create: `src/services/drive.ts`
- Modify: `tests/services/drive.test.ts`

- [ ] **Step 1: Write failing tests**

Replace `tests/services/drive.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { extractFolderIdFromUrl } from "@/services/drive";

describe("extractFolderIdFromUrl", () => {
  it("extracts folder ID from standard URL", () => {
    expect(
      extractFolderIdFromUrl("https://drive.google.com/drive/folders/1abc2DEF3xyz")
    ).toBe("1abc2DEF3xyz");
  });

  it("extracts folder ID from /u/0/ URL", () => {
    expect(
      extractFolderIdFromUrl(
        "https://drive.google.com/drive/u/0/folders/1abc2DEF3xyz"
      )
    ).toBe("1abc2DEF3xyz");
  });

  it("returns null for a file URL", () => {
    expect(
      extractFolderIdFromUrl("https://drive.google.com/file/d/somefileid/view")
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractFolderIdFromUrl("")).toBeNull();
  });

  it("returns null for a non-Drive URL", () => {
    expect(extractFolderIdFromUrl("https://example.com")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module '@/services/drive'`

- [ ] **Step 3: Write drive.ts**

Create `src/services/drive.ts`:
```typescript
import { google } from "googleapis";
import { Readable } from "stream";

/**
 * Extract the folder ID from a Google Drive folder URL.
 * Accepted formats:
 *   https://drive.google.com/drive/folders/<id>
 *   https://drive.google.com/drive/u/0/folders/<id>
 */
export function extractFolderIdFromUrl(url: string): string | null {
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Upload a PDF buffer to a specific Google Drive folder.
 * Uses the end-user's OAuth access token (drive.file scope).
 */
export async function uploadFileToDrive(
  accessToken: string,
  folderId: string,
  filename: string,
  pdfBuffer: Buffer
): Promise<{ fileId: string; webViewLink: string }> {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType: "application/pdf",
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(pdfBuffer),
    },
    fields: "id,webViewLink",
  });

  if (!response.data.id || !response.data.webViewLink) {
    throw new Error("Drive upload succeeded but returned no file ID or URL");
  }

  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test
```

Expected: 5 tests pass.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/drive.ts tests/services/drive.test.ts
git commit -m "feat: add Drive upload service with URL extraction"
```

---

## Chunk 3: API Routes and Frontend

### Task 13: POST /api/checks/run

**Files:**
- Create: `src/app/api/checks/run/route.ts`
- Create: `tests/api/checks-run.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/api/checks-run.test.ts`:
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

  it("returns 400 for unknown provider key", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue(null);
    const res = await POST(makeReq({ ...validBody, providerKey: "unknown" }));
    expect(res.status).toBe(400);
  });

  it("runs full pipeline and returns 200 with result", async () => {
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
    expect(json.status).toBe("no_match");
    expect(json.runId).toBe("run-1");
    expect(json.driveUrl).toBe("https://drive.google.com/file/d/file-1/view");
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

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test tests/api/checks-run.test.ts
```

Expected: FAIL — `Cannot find module '@/app/api/checks/run/route'`

- [ ] **Step 3: Write the route handler**

Create `src/app/api/checks/run/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getProvider } from "@/providers/registry";
import { generateEvidencePdf } from "@/services/evidence";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";
import type { RunCheckInput } from "@/lib/types";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email || !(session as any).accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const {
    borrowerName,
    idCode,
    loanReference,
    driveFolderUrl,
    providerKey = "avnt_insolvency",
  } = body;

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

  const provider = getProvider(providerKey);
  if (!provider) {
    return NextResponse.json(
      { error: `Unknown provider: ${providerKey}` },
      { status: 400 }
    );
  }

  const input: RunCheckInput = {
    borrowerName: borrowerName.trim(),
    idCode: idCode?.trim() || undefined,
    loanReference: loanReference?.trim() || undefined,
    driveFolderUrl,
    initiatedByEmail: session.user.email,
    providerKey,
  };

  const result = await provider.runSearch(input);

  const filename = `${providerKey}_${input.borrowerName.replace(/\s+/g, "_")}_${Date.now()}.pdf`;
  const pdfBuffer = await generateEvidencePdf(input, result, filename);

  let uploadedFileId: string | undefined;
  let uploadedFileUrl: string | undefined;
  let driveError: string | undefined;

  try {
    const uploaded = await uploadFileToDrive(
      (session as any).accessToken,
      folderId,
      filename,
      pdfBuffer
    );
    uploadedFileId = uploaded.fileId;
    uploadedFileUrl = uploaded.webViewLink;
  } catch (err) {
    driveError = err instanceof Error ? err.message : String(err);
  }

  const run = await db.searchRun.create({
    data: {
      createdByEmail: session.user.email!,
      borrowerName: input.borrowerName,
      borrowerIdCode: input.idCode,
      loanReference: input.loanReference,
      providerKey,
      driveFolderUrl,
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
  });

  return NextResponse.json({
    runId: run.id,
    status: result.status,
    resultsCount: result.resultsCount,
    summaryText: result.summaryText,
    driveUrl: uploadedFileUrl,
    ...(driveError ? { driveError } : {}),
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm test tests/api/checks-run.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/checks/ tests/api/checks-run.test.ts
git commit -m "feat: add POST /api/checks/run pipeline"
```

---

### Task 14: GET /api/history

**Files:**
- Create: `src/app/api/history/route.ts`
- Create: `tests/api/history.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/api/history.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({
  db: {
    searchRun: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { GET } from "@/app/api/history/route";
import { getServerSession } from "next-auth";
import { db } from "@/lib/db";

const mockSession = { user: { email: "tester@example.com" } };

const mockRun = {
  id: "run-1",
  createdAt: new Date("2026-03-24"),
  createdByEmail: "tester@example.com",
  borrowerName: "Test Co",
  borrowerIdCode: null,
  loanReference: null,
  providerKey: "avnt_insolvency",
  resultStatus: "no_match",
  resultsCount: 0,
  matchedSummary: "No records found",
  uploadedFileUrl: "https://drive.google.com/file/d/file-1/view",
};

describe("GET /api/history", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/history"));
    expect(res.status).toBe(401);
  });

  it("returns paginated rows with total", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.searchRun.findMany).mockResolvedValue([mockRun] as any);
    vi.mocked(db.searchRun.count).mockResolvedValue(1);

    const res = await GET(
      new NextRequest("http://localhost/api/history?page=1&limit=20")
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runs).toHaveLength(1);
    expect(json.total).toBe(1);
    expect(json.page).toBe(1);
  });

  it("defaults to page 1 when no query params given", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.searchRun.findMany).mockResolvedValue([] as any);
    vi.mocked(db.searchRun.count).mockResolvedValue(0);

    const res = await GET(new NextRequest("http://localhost/api/history"));
    expect(res.status).toBe(200);
    expect((await res.json()).page).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test tests/api/history.test.ts
```

Expected: FAIL — `Cannot find module '@/app/api/history/route'`

- [ ] **Step 3: Write the route handler**

Create `src/app/api/history/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10))
  );
  const skip = (page - 1) * limit;

  const [runs, total] = await Promise.all([
    db.searchRun.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
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
      },
    }),
    db.searchRun.count(),
  ]);

  return NextResponse.json({ runs, total, page, limit });
}
```

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/history/ tests/api/history.test.ts
git commit -m "feat: add GET /api/history with pagination"
```

---

### Task 15: Nav component

**Files:**
- Create: `src/components/Nav.tsx`

- [ ] **Step 1: Write Nav.tsx**

Create `src/components/Nav.tsx`:
```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function Nav() {
  const pathname = usePathname();
  const { data: session } = useSession();

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
          <span className="text-xs text-muted-foreground">
            {session?.user?.email}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => signOut({ callbackUrl: "/" })}
          >
            Sign out
          </Button>
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Nav.tsx
git commit -m "feat: add Nav component"
```

---

### Task 16: ResultCard component

**Files:**
- Create: `src/components/ResultCard.tsx`

- [ ] **Step 1: Write ResultCard.tsx**

Create `src/components/ResultCard.tsx`:
```tsx
import { Badge } from "@/components/ui/badge";
import type { ResultStatus } from "@/lib/types";

interface Props {
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
  }
> = {
  no_match: { label: "NO RECORD FOUND", variant: "default" },
  match_found: { label: "RECORD FOUND", variant: "destructive" },
  ambiguous: {
    label: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
    variant: "secondary",
  },
  error: { label: "TECHNICAL ERROR", variant: "outline" },
};

export function ResultCard({
  status,
  resultsCount,
  summaryText,
  driveUrl,
  driveError,
}: Props) {
  const { label, variant } = STATUS_CONFIG[status] ?? STATUS_CONFIG.error;

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Badge
          variant={variant}
          className="text-xs font-bold tracking-wide px-3 py-1"
        >
          {label}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {resultsCount} result(s)
        </span>
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
        <p className="text-sm text-destructive">
          Drive upload failed: {driveError}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ResultCard.tsx
git commit -m "feat: add ResultCard component"
```

---

### Task 17: CheckForm component

**Files:**
- Create: `src/components/CheckForm.tsx`

- [ ] **Step 1: Write CheckForm.tsx**

Create `src/components/CheckForm.tsx`:
```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ResultCard } from "./ResultCard";
import type { ResultStatus } from "@/lib/types";

interface CheckResult {
  runId: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
  driveUrl?: string;
  driveError?: string;
}

export function CheckForm() {
  const [borrowerName, setBorrowerName] = useState("");
  const [idCode, setIdCode] = useState("");
  const [loanReference, setLoanReference] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [providerKey, setProviderKey] = useState("avnt_insolvency");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/checks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          borrowerName,
          idCode: idCode || undefined,
          loanReference: loanReference || undefined,
          driveFolderUrl,
          providerKey,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "An unexpected error occurred");
        return;
      }

      setResult(data);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
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

        <div className="space-y-2">
          <Label htmlFor="idCode">ID Code (optional)</Label>
          <Input
            id="idCode"
            value={idCode}
            onChange={(e) => setIdCode(e.target.value)}
            placeholder="Company or person code"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="loanReference">Loan Reference (optional)</Label>
          <Input
            id="loanReference"
            value={loanReference}
            onChange={(e) => setLoanReference(e.target.value)}
            placeholder="e.g. LOAN-2025-001"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="registry">Registry</Label>
          <Select value={providerKey} onValueChange={setProviderKey}>
            <SelectTrigger id="registry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="avnt_insolvency">
                AVNT Insolvency Register
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

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
          {loading ? "Running check…" : "Run Check"}
        </Button>
      </form>

      {result && (
        <ResultCard
          status={result.status}
          resultsCount={result.resultsCount}
          summaryText={result.summaryText}
          driveUrl={result.driveUrl}
          driveError={result.driveError}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/CheckForm.tsx
git commit -m "feat: add CheckForm component"
```

---

### Task 18: HistoryTable component

**Files:**
- Create: `src/components/HistoryTable.tsx`

- [ ] **Step 1: Write HistoryTable.tsx**

Create `src/components/HistoryTable.tsx`:
```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface HistoryRow {
  id: string;
  createdAt: string;
  createdByEmail: string;
  borrowerName: string;
  providerKey: string;
  resultStatus: string;
  resultsCount: number;
  uploadedFileUrl: string | null;
}

const STATUS_BADGE: Record<
  string,
  {
    label: string;
    variant: "default" | "destructive" | "outline" | "secondary";
  }
> = {
  no_match: { label: "No match", variant: "default" },
  match_found: { label: "Match", variant: "destructive" },
  ambiguous: { label: "Ambiguous", variant: "secondary" },
  error: { label: "Error", variant: "outline" },
};

export function HistoryTable() {
  const [runs, setRuns] = useState<HistoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const limit = 20;

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/history?page=${p}&limit=${limit}`);
      const data = await res.json();
      setRuns(data.runs ?? []);
      setTotal(data.total ?? 0);
      setPage(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage(1);
  }, [fetchPage]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} run{total !== 1 ? "s" : ""} total
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchPage(page - 1)}
            disabled={page <= 1 || loading}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchPage(page + 1)}
            disabled={page >= totalPages || loading}
          >
            Next
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Borrower</TableHead>
              <TableHead>Registry</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>By</TableHead>
              <TableHead>PDF</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground py-8"
                >
                  {loading ? "Loading…" : "No checks run yet"}
                </TableCell>
              </TableRow>
            )}
            {runs.map((run) => {
              const badge =
                STATUS_BADGE[run.resultStatus] ?? {
                  label: run.resultStatus,
                  variant: "outline" as const,
                };
              return (
                <TableRow key={run.id}>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {new Date(run.createdAt).toLocaleDateString("en-GB")}
                  </TableCell>
                  <TableCell className="font-medium text-sm">
                    {run.borrowerName}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground uppercase">
                    {run.providerKey.replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={badge.variant} className="text-xs">
                      {badge.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {run.createdByEmail.split("@")[0]}
                  </TableCell>
                  <TableCell>
                    {run.uploadedFileUrl ? (
                      <a
                        href={run.uploadedFileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline text-sm"
                      >
                        ↗
                      </a>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/HistoryTable.tsx
git commit -m "feat: add HistoryTable component with pagination"
```

---

### Task 19: Pages and root layout

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/app/page.tsx`
- Create: `src/app/check/page.tsx`
- Create: `src/app/history/page.tsx`

- [ ] **Step 1: Write root layout with SessionProvider**

Replace `src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { getServerSession } from "next-auth";
import { SessionProvider } from "next-auth/react";
import { authOptions } from "@/lib/auth";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Public Registry Check",
  description: "Internal compliance check tool",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession(authOptions);

  return (
    <html lang="en">
      <body className={inter.className}>
        <SessionProvider session={session}>{children}</SessionProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Write root page (redirect)**

Replace `src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/check");
}
```

- [ ] **Step 3: Write /check page**

Create `src/app/check/page.tsx`:
```tsx
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { CheckForm } from "@/components/CheckForm";

export default async function CheckPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-xl px-4 py-10">
        <h1 className="text-xl font-semibold mb-6">Run a Compliance Check</h1>
        <CheckForm />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Write /history page**

Create `src/app/history/page.tsx`:
```tsx
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { Nav } from "@/components/Nav";
import { HistoryTable } from "@/components/HistoryTable";

export default async function HistoryPage() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/api/auth/signin");

  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="text-xl font-semibold mb-6">Check History</h1>
        <HistoryTable />
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/app/
git commit -m "feat: add pages and root layout with SessionProvider"
```

---

### Task 20: Final scripts and smoke test

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add Prisma utility scripts to package.json**

In `package.json` `scripts`, add:
```json
"db:migrate": "prisma migrate dev",
"db:migrate:prod": "prisma migrate deploy",
"db:studio": "prisma studio"
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Smoke test the running app**

```bash
npm run dev
```

Manual checklist:
- [ ] http://localhost:3000 → redirects to /check
- [ ] /check unauthenticated → redirects to Google sign-in
- [ ] Sign in with Google → back on /check
- [ ] Fill in borrower name + Drive folder URL → click Run Check
- [ ] Result card appears with status, summary, Drive PDF link
- [ ] /history shows the run in the table with correct badge and PDF link

- [ ] **Step 4: Final commit**

```bash
git add package.json
git commit -m "feat: add db utility scripts — implementation complete"
```
