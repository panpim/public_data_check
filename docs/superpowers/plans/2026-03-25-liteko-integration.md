# LITEKO Court Case Search — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LITEKO court case search as a second provider, running before AVNT, with a combined multi-page evidence PDF and grouped history display.

**Architecture:** Each form submission generates a `runGroupId` (UUID); one `SearchRun` row is written per provider sharing that ID. Providers run sequentially (LITEKO first for CAPTCHA, then AVNT automated). A single combined PDF is uploaded to Drive.

**Tech Stack:** Next.js 16 App Router, Playwright (non-headless for LITEKO), pdf-lib, Prisma SQLite, Vitest.

**Spec:** `docs/superpowers/specs/2026-03-25-liteko-integration-design.md`

---

## Chunk 1: Foundation — git tag, schema, types, Drive service

### Task 1: Tag v1.0 and add schema columns

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Tag the current commit as v1.0**

```bash
git tag v1.0
```

Verify: `git tag` should list `v1.0`.

- [ ] **Step 2: Add the two new columns to `prisma/schema.prisma`**

Open `prisma/schema.prisma`. After the `normalizedResultJson` line, add:

```prisma
  runGroupId       String   @default("")
  uploadedFileName String?
```

Full model after change:
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

  resultStatus         String
  resultsCount         Int
  matchedSummary       String?

  uploadedFileId       String?
  uploadedFileUrl      String?

  requestPayloadJson   String?
  normalizedResultJson String?

  runGroupId           String   @default("")
  uploadedFileName     String?
}
```

- [ ] **Step 3: Run the migration**

Note: `npm run db:migrate` is an alias for `npx prisma migrate dev` (defined in package.json).

```bash
cd /Users/panpimboonchuay/panpim
npm run db:migrate
```

When prompted for a migration name, enter: `add_run_group_id_and_filename`

Expected: `✓ Generated Prisma Client` with no errors.

- [ ] **Step 4: Verify the migration succeeded**

```bash
npx prisma studio
```

Open the URL shown (usually http://localhost:5555). Check that `SearchRun` table shows `runGroupId` and `uploadedFileName` columns. Ctrl+C to exit.

- [ ] **Step 5: Commit**

```bash
git add prisma/ src/generated/
git commit -m "chore: add runGroupId and uploadedFileName to SearchRun schema"
```

---

### Task 2: Type changes + AVNT fix + LITEKO stub + minimal route.ts shim

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/providers/avnt-insolvency/search.ts` — fix `screenshotBuffer: null` in all return paths
- Modify: `src/providers/registry.ts` — register LITEKO
- Create: `src/providers/liteko-court-cases/index.ts` (stub)
- Modify: `src/app/api/checks/run/route.ts` — minimal shim to keep it compiling

All five files must be committed together so TypeScript passes after this task.

- [ ] **Step 1: Establish baseline tsc**

```bash
cd /Users/panpimboonchuay/panpim
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 2: Update `src/lib/types.ts`**

Replace the entire file:

```typescript
import type { DefaultSession } from "next-auth";

export type CheckProviderKey = "avnt_insolvency" | "liteko_court_cases";

export type ResultStatus = "no_match" | "match_found" | "ambiguous" | "error";

export interface RunCheckInput {
  borrowerName: string;
  idCode?: string;
  loanReference?: string;
  driveFolderUrl: string;
  initiatedByEmail: string;
  providerKeys: CheckProviderKey[];   // replaces providerKey (singular)
  runGroupId: string;
}

export interface MatchedEntity {
  name: string;
  caseNumber?: string;
  status?: string;
  date?: string;    // used by LITEKO
  court?: string;   // used by LITEKO
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
  screenshotBuffer: Buffer | null;   // was: Buffer? (optional) — now required, explicitly nullable
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

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
  }
}
```

- [ ] **Step 3: Fix `src/providers/avnt-insolvency/search.ts` — screenshotBuffer in all return paths**

`screenshotBuffer` changes from `Buffer?` (optional/omittable) to `Buffer | null` (required). Every `return { ... }` in `search.ts` must include it. There are two return paths:

**Happy path** (inside the try block): already sets `screenshotBuffer` from `await page.screenshot(...)` — no change needed there.

**Catch block** (bottom of the function, line ~133): add `screenshotBuffer: null`:

```typescript
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
      screenshotBuffer: null,     // ADD THIS
    };
  }
```

After making this change, run tsc on just that file to confirm no remaining errors:
```bash
npx tsc --noEmit 2>&1 | grep "avnt"
```
Expected: no output (no avnt errors).

- [ ] **Step 4: Create `src/providers/liteko-court-cases/index.ts` (stub)**

```typescript
import type { PublicCheckProvider, RunCheckInput, NormalizedCheckResult } from "@/lib/types";

export class LitekoCourtCasesProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    // Stub — real implementation wired in Task 7
    return {
      providerKey: "liteko_court_cases",
      sourceUrl: "https://liteko.teismai.lt/viesasprendimupaieska/",
      searchedAt: new Date().toISOString(),
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: "LITEKO provider not yet implemented",
      screenshotBuffer: null,
    };
  }
}
```

- [ ] **Step 5: Update `src/providers/registry.ts` — register LITEKO**

Replace the entire file:

```typescript
import type { PublicCheckProvider, CheckProviderKey } from "@/lib/types";
import { AvntInsolvencyProvider } from "./avnt-insolvency";
import { LitekoCourtCasesProvider } from "./liteko-court-cases";

const providers: Record<CheckProviderKey, PublicCheckProvider> = {
  avnt_insolvency: new AvntInsolvencyProvider(),
  liteko_court_cases: new LitekoCourtCasesProvider(),
};

function isCheckProviderKey(key: string): key is CheckProviderKey {
  return key in providers;
}

export function getProvider(key: string): PublicCheckProvider | null {
  if (!isCheckProviderKey(key)) return null;
  return providers[key];
}
```

- [ ] **Step 6: Minimally fix `src/app/api/checks/run/route.ts` to compile with new types**

`route.ts` constructs `RunCheckInput` with the old `providerKey` field. We need just enough changes to make it compile — the full rewrite comes in Task 5.

Find the `RunCheckInput` construction block (around line 54) and update it:

```typescript
// BEFORE:
const input: RunCheckInput = {
  borrowerName: borrowerName.trim(),
  idCode: idCode?.trim() || undefined,
  loanReference: loanReference?.trim() || undefined,
  driveFolderUrl,
  initiatedByEmail: session.user.email,
  providerKey,
};

// AFTER:
const runGroupId = uuidv4();
const input: RunCheckInput = {
  borrowerName: borrowerName.trim(),
  idCode: idCode?.trim() || undefined,
  loanReference: loanReference?.trim() || undefined,
  driveFolderUrl,
  initiatedByEmail: session.user.email,
  providerKeys: [providerKey as CheckProviderKey],
  runGroupId,
};
```

Also add the import for `uuidv4` and `CheckProviderKey` at the top of route.ts:

```typescript
import { v4 as uuidv4 } from "uuid";
import type { RunCheckInput, NormalizedCheckResult, CheckProviderKey } from "@/lib/types";
```

Also find the error-result construction (around line 64) where `providerKey` is used as a string in the return object — that's fine since `NormalizedCheckResult.providerKey` is `CheckProviderKey` and `providerKey` is already typed as string. Add a cast:

```typescript
result = {
  providerKey: providerKey as CheckProviderKey,
  // ... rest unchanged
};
```

- [ ] **Step 7: Run tsc — expect clean**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors. If errors remain, read them and fix — do not proceed until clean.

- [ ] **Step 8: Run all tests**

```bash
npm test
```

Expected: all 14 tests pass. The existing `checks-run.test.ts` mocks the route's dependencies so it should still pass even with the minimal shim.

- [ ] **Step 9: Commit all five files**

```bash
git add src/lib/types.ts \
        src/providers/avnt-insolvency/search.ts \
        src/providers/liteko-court-cases/index.ts \
        src/providers/registry.ts \
        src/app/api/checks/run/route.ts
git commit -m "feat: expand types for multi-provider, register LITEKO stub, shim route.ts"
```

---

### Task 3: Update Drive service to return `fileName`

**Files:**
- Modify: `src/services/drive.ts`
- Modify: `tests/services/drive.test.ts`

- [ ] **Step 1: Add a failing test for `uploadFileToDrive` returning `fileName`**

Open `tests/services/drive.test.ts` and add this test block after the existing `extractFolderIdFromUrl` tests:

```typescript
import { describe, it, expect, vi } from "vitest";
import { extractFolderIdFromUrl } from "@/services/drive";

// --- existing extractFolderIdFromUrl tests stay here ---

vi.mock("googleapis", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    data: { id: "file-abc", webViewLink: "https://drive.google.com/file/d/file-abc/view" },
  });
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })),
      },
      drive: vi.fn().mockReturnValue({
        files: { create: mockCreate },
      }),
    },
  };
});

describe("uploadFileToDrive", () => {
  it("returns fileId, webViewLink, and fileName", async () => {
    const { uploadFileToDrive } = await import("@/services/drive");
    const result = await uploadFileToDrive(
      "fake-access-token",
      "folder-abc",
      "test_evidence.pdf",
      Buffer.from("fake pdf")
    );

    expect(result.fileId).toBe("file-abc");
    expect(result.webViewLink).toBe("https://drive.google.com/file/d/file-abc/view");
    expect(result.fileName).toBe("test_evidence.pdf");  // fails until we add fileName to drive.ts
  });
});
```

Note: the `vi.mock("googleapis", ...)` call must be at the top level of the file (outside `describe`), which is the Vitest hoisting requirement.

The full updated `tests/services/drive.test.ts` (replace entire file):

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("googleapis", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    data: { id: "file-abc", webViewLink: "https://drive.google.com/file/d/file-abc/view" },
  });
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })),
      },
      drive: vi.fn().mockReturnValue({
        files: { create: mockCreate },
      }),
    },
  };
});

import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";

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

describe("uploadFileToDrive", () => {
  it("returns fileId, webViewLink, and fileName", async () => {
    const result = await uploadFileToDrive(
      "fake-access-token",
      "folder-abc",
      "test_evidence.pdf",
      Buffer.from("fake pdf")
    );

    expect(result.fileId).toBe("file-abc");
    expect(result.webViewLink).toBe("https://drive.google.com/file/d/file-abc/view");
    expect(result.fileName).toBe("test_evidence.pdf");
  });
});
```

- [ ] **Step 2: Run the test — expect failure on `fileName`**

```bash
npm test tests/services/drive.test.ts
```

Expected: 5 pass (extractFolderIdFromUrl), 1 FAIL on `result.fileName` (property doesn't exist yet). This confirms the test is wired correctly.

- [ ] **Step 3: Update `src/services/drive.ts` — add `fileName` to return type and value**

Change line 24 (return type):
```typescript
): Promise<{ fileId: string; webViewLink: string; fileName: string }> {
```

Change the return statement (around line 47):
```typescript
  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink,
    fileName: filename,
  };
```

- [ ] **Step 4: Run the drive tests — expect all 6 pass**

```bash
npm test tests/services/drive.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/drive.ts tests/services/drive.test.ts
git commit -m "feat: drive service returns fileName; add uploadFileToDrive unit test"
```

---

## Chunk 2: Evidence PDF rewrite

### Task 4: Rewrite `src/services/evidence.ts` for multi-provider results

**Files:**
- Modify: `src/services/evidence.ts`
- Create: `tests/services/evidence.test.ts`

The existing `evidence.ts` accepts a single `NormalizedCheckResult`. We rewrite it to accept `results: NormalizedCheckResult[]` and use `input.runGroupId` for the PDF "Request ID". The internal `uuidv4()` call is removed.

- [ ] **Step 1: Write tests first**

Create `tests/services/evidence.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { generateEvidencePdf } from "@/services/evidence";
import type { RunCheckInput, NormalizedCheckResult } from "@/lib/types";

const baseInput: RunCheckInput = {
  borrowerName: "Test Person",
  driveFolderUrl: "https://drive.google.com/drive/folders/abc",
  initiatedByEmail: "user@example.com",
  providerKeys: ["avnt_insolvency"],
  runGroupId: "test-group-id-123",
};

const avntResult: NormalizedCheckResult = {
  providerKey: "avnt_insolvency",
  sourceUrl: "https://nemokumas.avnt.lt/public/case/list",
  searchedAt: new Date().toISOString(),
  borrowerNameInput: "Test Person",
  status: "no_match",
  resultsCount: 0,
  matchedEntities: [],
  summaryText: "No insolvency records found.",
  screenshotBuffer: null,
};

const litekoResult: NormalizedCheckResult = {
  providerKey: "liteko_court_cases",
  sourceUrl: "https://liteko.teismai.lt/viesasprendimupaieska/",
  searchedAt: new Date().toISOString(),
  borrowerNameInput: "Test Person",
  status: "match_found",
  resultsCount: 3,
  matchedEntities: [{ name: "Test Person", caseNumber: "3B-123/2026" }],
  summaryText: "3 court case records found.",
  screenshotBuffer: null,
};

describe("generateEvidencePdf", () => {
  it("returns a non-empty Buffer for a single no_match result", async () => {
    const buf = await generateEvidencePdf(baseInput, [avntResult], "test.pdf");
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(100);
  });

  it("returns a Buffer for two results", async () => {
    const buf = await generateEvidencePdf(
      { ...baseInput, providerKeys: ["liteko_court_cases", "avnt_insolvency"] },
      [litekoResult, avntResult],
      "combined.pdf"
    );
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(100);
  });

  it("handles match_found with matchedEntities", async () => {
    const buf = await generateEvidencePdf(baseInput, [litekoResult], "liteko.pdf");
    expect(buf).toBeInstanceOf(Buffer);
  });

  it("handles ambiguous status", async () => {
    const ambiguous: NormalizedCheckResult = {
      ...avntResult,
      status: "ambiguous",
      resultsCount: 5,
      summaryText: "5 records found — manual review required.",
    };
    const buf = await generateEvidencePdf(baseInput, [ambiguous], "ambiguous.pdf");
    expect(buf).toBeInstanceOf(Buffer);
  });

  it("handles error status", async () => {
    const errResult: NormalizedCheckResult = {
      ...avntResult,
      status: "error",
      summaryText: "CAPTCHA timeout.",
    };
    const buf = await generateEvidencePdf(baseInput, [errResult], "error.pdf");
    expect(buf).toBeInstanceOf(Buffer);
  });
});
```

- [ ] **Step 2: Run the tests — they should fail (old signature)**

```bash
npm test tests/services/evidence.test.ts
```

Expected: FAIL — `generateEvidencePdf` doesn't accept an array.

- [ ] **Step 3: Rewrite `src/services/evidence.ts`**

Replace the entire file:

```typescript
/**
 * Evidence PDF generator — multi-provider combined report
 */
import { PDFDocument, rgb, StandardFonts, PageSizes } from "pdf-lib";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

const BRAND_BLUE = rgb(0.07, 0.27, 0.55);
const GREY = rgb(0.4, 0.4, 0.4);
const BLACK = rgb(0, 0, 0);
const RED = rgb(0.75, 0.1, 0.1);
const GREEN = rgb(0.07, 0.52, 0.18);
const ORANGE = rgb(0.85, 0.45, 0.0);
const WHITE = rgb(1, 1, 1);

const PROVIDER_LABELS: Record<string, string> = {
  avnt_insolvency: "AVNT Insolvency Register",
  liteko_court_cases: "LITEKO Court Cases",
};

function getProviderLabel(key: string): string {
  return PROVIDER_LABELS[key] ?? key;
}

export async function generateEvidencePdf(
  input: RunCheckInput,
  results: NormalizedCheckResult[],
  filename: string
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── Page 1: Summary ──────────────────────────────────────────────
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
  const checksRun = results.map((r) => getProviderLabel(r.providerKey)).join(", ");
  drawRow(cover, regular, bold, "Initiated by:", sanitizeForPdf(input.initiatedByEmail), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Timestamp:", formatDate(results[0]?.searchedAt ?? new Date().toISOString()), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Checks run:", sanitizeForPdf(checksRun), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Request ID:", input.runGroupId, margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Evidence filename:", sanitizeForPdf(filename), margin, y);
  y -= 30;

  // Search Input
  drawSection(cover, bold, "Search Input", margin, y, width - margin * 2);
  y -= 20;
  drawRow(cover, regular, bold, "Borrower name:", sanitizeForPdf(input.borrowerName), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "ID code:", sanitizeForPdf(input.idCode ?? "(not provided)"), margin, y);
  y -= 18;
  drawRow(cover, regular, bold, "Loan reference:", sanitizeForPdf(input.loanReference ?? "(not provided)"), margin, y);
  y -= 30;

  // Results Summary — one block per provider
  // Track screenshot page numbers (pages after cover)
  const screenshotPageNumbers: Map<string, number> = new Map();
  let screenshotPageNum = 2;
  for (const r of results) {
    if (r.screenshotBuffer !== null) {
      screenshotPageNumbers.set(r.providerKey, screenshotPageNum++);
    }
  }

  drawSection(cover, bold, "Results Summary", margin, y, width - margin * 2);
  y -= 16;

  for (const result of results) {
    if (y < margin + 80) break; // guard against overflow

    const statusColor =
      result.status === "no_match" ? GREEN
      : result.status === "match_found" ? RED
      : result.status === "ambiguous" ? ORANGE
      : GREY;

    const statusLabel: Record<string, string> = {
      no_match: "NO RECORD FOUND",
      match_found: `${result.resultsCount} RECORD${result.resultsCount !== 1 ? "S" : ""} FOUND`,
      ambiguous: "AMBIGUOUS — MANUAL REVIEW REQUIRED",
      error: "TECHNICAL ERROR",
    };

    const blockHeight = 52;
    cover.drawRectangle({
      x: margin, y: y - blockHeight,
      width: width - margin * 2, height: blockHeight,
      color: rgb(
        result.status === "no_match" ? 0.94 : result.status === "match_found" ? 1 : result.status === "ambiguous" ? 1 : 0.97,
        result.status === "no_match" ? 1 : result.status === "match_found" ? 0.93 : result.status === "ambiguous" ? 0.97 : 0.97,
        result.status === "no_match" ? 0.94 : result.status === "match_found" ? 0.93 : result.status === "ambiguous" ? 0.9 : 0.97,
      ),
    });
    cover.drawRectangle({
      x: margin, y: y - blockHeight,
      width: width - margin * 2, height: blockHeight,
      borderColor: statusColor,
      borderWidth: 1,
    });

    // Provider label
    cover.drawText(getProviderLabel(result.providerKey).toUpperCase(), {
      x: margin + 8, y: y - 14, font: bold, size: 8, color: statusColor,
    });

    // Status badge (right-aligned)
    const badgeLabel = statusLabel[result.status] ?? result.status.toUpperCase();
    const badgeWidth = badgeLabel.length * 5 + 16;
    cover.drawRectangle({
      x: width - margin - badgeWidth, y: y - 18,
      width: badgeWidth, height: 14,
      color: statusColor,
    });
    cover.drawText(badgeLabel, {
      x: width - margin - badgeWidth + 8, y: y - 13,
      font: bold, size: 7, color: WHITE,
    });

    // Summary text
    const summaryLines = wrapText(sanitizeForPdf(result.summaryText), 80);
    cover.drawText(summaryLines[0] ?? "", {
      x: margin + 8, y: y - 28, font: regular, size: 8, color: BLACK,
    });

    // Screenshot page reference
    const pageRef = screenshotPageNumbers.get(result.providerKey);
    if (pageRef) {
      cover.drawText(`See screenshot on page ${pageRef}.`, {
        x: margin + 8, y: y - 40, font: regular, size: 7, color: GREY,
      });
    }

    y -= blockHeight + 8;
  }

  // Footer
  cover.drawLine({
    start: { x: margin, y: margin + 20 },
    end: { x: width - margin, y: margin + 20 },
    color: GREY, thickness: 0.5,
  });
  cover.drawText(
    `Generated: ${formatDate(new Date().toISOString())}   |   Request ID: ${input.runGroupId}   |   CONFIDENTIAL — INTERNAL USE ONLY`,
    { x: margin, y: margin + 6, font: regular, size: 7, color: GREY }
  );

  // ── Screenshot pages (one per provider with non-null buffer) ────
  for (const result of results) {
    if (!result.screenshotBuffer) continue;
    try {
      const page = doc.addPage(PageSizes.A4);
      const { width: sw, height: sh } = page.getSize();

      // Header bar
      page.drawRectangle({ x: 0, y: sh - 40, width: sw, height: 40, color: BRAND_BLUE });
      page.drawText(`${getProviderLabel(result.providerKey)} — Search Results`, {
        x: margin, y: sh - 26, font: bold, size: 11, color: WHITE,
      });

      // Source URL
      page.drawText(`Source: ${result.sourceUrl}`, {
        x: margin, y: sh - 56, font: regular, size: 8, color: GREY,
      });

      // Screenshot
      const pngImage = await doc.embedPng(result.screenshotBuffer);
      const imgDims = pngImage.scaleToFit(sw - margin * 2, sh - margin - 80);
      page.drawImage(pngImage, {
        x: margin, y: sh - 80 - imgDims.height,
        width: imgDims.width, height: imgDims.height,
      });
    } catch {
      // Skip this screenshot page if embedding fails — cover page still valid
    }
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

function drawSection(
  page: ReturnType<PDFDocument["addPage"]>,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  title: string,
  x: number, y: number, sectionWidth: number
) {
  page.drawText(title.toUpperCase(), { x, y, font: bold, size: 9, color: BRAND_BLUE });
  page.drawLine({
    start: { x, y: y - 4 }, end: { x: x + sectionWidth, y: y - 4 },
    color: BRAND_BLUE, thickness: 0.75,
  });
}

function drawRow(
  page: ReturnType<PDFDocument["addPage"]>,
  regular: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  bold: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  label: string, value: string,
  x: number, y: number, valueFontSize = 9
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
    return new Date(iso).toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC";
  } catch {
    return iso;
  }
}

/**
 * Transliterate Lithuanian and other non-WinAnsi characters so pdf-lib's
 * Helvetica font (WinAnsiEncoding / Latin-1) can render them.
 */
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

- [ ] **Step 4: Run the evidence tests**

```bash
npm test tests/services/evidence.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: evidence tests pass (5); checks-run tests still fail (route not yet updated — expected).

- [ ] **Step 5b: Patch `route.ts` call site to use the new array signature**

The `generateEvidencePdf` call in `src/app/api/checks/run/route.ts` (line ~83) passes a single `result` object. After the signature change it expects an array. Wrap it:

Find:
```typescript
pdfBuffer = await generateEvidencePdf(input, result, filename);
```

Replace with:
```typescript
pdfBuffer = await generateEvidencePdf(input, [result], filename);
```

- [ ] **Step 5c: Run tsc — expect clean**

```bash
npx tsc --noEmit
```

Expected: no errors. If TypeScript complains about `route.ts`, fix the specific line before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/services/evidence.ts tests/services/evidence.test.ts src/app/api/checks/run/route.ts
git commit -m "feat: rewrite evidence PDF to support multiple providers and use runGroupId"
```

---

## Chunk 3: API route rewrite + config endpoint

### Task 5: Rewrite `src/app/api/checks/run/route.ts`

**Files:**
- Modify: `src/app/api/checks/run/route.ts`
- Modify: `tests/api/checks-run.test.ts`

The route is a full rewrite. The new shape: accept `providerKeys[]`, run LITEKO first if both present, write one `SearchRun` row per provider sharing `runGroupId`, generate combined PDF, upload, update all rows.

**Prerequisite: Tasks 1–4 must be fully committed before starting this task.**

- [ ] **Step 0: Verify prerequisite state**

```bash
npx tsc --noEmit
```

Expected: no errors. If errors reference `RunCheckInput.providerKeys`, `runGroupId`, or `screenshotBuffer`, Tasks 1–4 have not been applied — stop and complete those first.

- [ ] **Step 1: Update the tests first**

Replace `tests/api/checks-run.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  db: {
    searchRun: {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));
vi.mock("uuid", () => ({ v4: vi.fn().mockReturnValue("test-group-id") }));

import { POST } from "@/app/api/checks/run/route";
import { getServerSession } from "next-auth";
import { getProvider } from "@/providers/registry";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";

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
  providerKeys: ["avnt_insolvency"],
};

const mockSearchResult = {
  providerKey: "avnt_insolvency" as const,
  sourceUrl: "https://nemokumas.avnt.lt/public/case/list",
  searchedAt: new Date().toISOString(),
  borrowerNameInput: "UAB Test",
  status: "no_match" as const,
  resultsCount: 0,
  matchedEntities: [],
  summaryText: "No records found",
  screenshotBuffer: null,
};

describe("POST /api/checks/run", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

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

  it("returns 400 when providerKeys is empty array", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    const res = await POST(makeReq({ ...validBody, providerKeys: [] }));
    expect(res.status).toBe(400);
  });

  it("runs full pipeline and returns 200 with results array", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue({
      runSearch: vi.fn().mockResolvedValue(mockSearchResult),
    });
    vi.mocked(uploadFileToDrive).mockResolvedValue({
      fileId: "file-1",
      webViewLink: "https://drive.google.com/file/d/file-1/view",
      fileName: "UAB_Test_20260325_evidence.pdf",
    });

    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runGroupId).toBe("test-group-id");
    expect(json.results).toHaveLength(1);
    expect(json.results[0].status).toBe("no_match");
    expect(json.driveWebViewLink).toBe("https://drive.google.com/file/d/file-1/view");
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
    expect(json.driveWebViewLink).toBeNull();
  });

  it("continues to next provider when first provider errors", async () => {
    vi.stubEnv("ENABLE_LITEKO", "true");   // ensure LITEKO is not stripped by feature flag
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    const errorResult = { ...mockSearchResult, status: "error" as const, summaryText: "Search failed" };
    const avntResult = { ...mockSearchResult, providerKey: "avnt_insolvency" as const };
    vi.mocked(getProvider)
      .mockReturnValueOnce({ runSearch: vi.fn().mockResolvedValue(errorResult) })
      .mockReturnValueOnce({ runSearch: vi.fn().mockResolvedValue(avntResult) });
    vi.mocked(uploadFileToDrive).mockResolvedValue({
      fileId: "f1", webViewLink: "https://drive.google.com/...", fileName: "test.pdf",
    });

    const res = await POST(makeReq({
      ...validBody,
      providerKeys: ["liteko_court_cases", "avnt_insolvency"],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.results).toHaveLength(2);
    expect(json.results[0].status).toBe("error");
    expect(json.results[1].status).toBe("no_match");
  });

  it("writes one SearchRun row per provider", async () => {
    vi.stubEnv("ENABLE_LITEKO", "true");   // ensure LITEKO is not stripped
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(extractFolderIdFromUrl).mockReturnValue("folder-id");
    vi.mocked(getProvider).mockReturnValue({
      runSearch: vi.fn().mockResolvedValue(mockSearchResult),
    });
    vi.mocked(uploadFileToDrive).mockResolvedValue({
      fileId: "f1", webViewLink: "https://d.g", fileName: "test.pdf",
    });

    await POST(makeReq({ ...validBody, providerKeys: ["liteko_court_cases", "avnt_insolvency"] }));
    expect(vi.mocked(db.searchRun.create)).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the new tests — expect failures**

```bash
npm test tests/api/checks-run.test.ts
```

Expected: FAIL — route still uses old shape.

- [ ] **Step 3: Rewrite `src/app/api/checks/run/route.ts`**

Replace the entire file:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { v4 as uuidv4 } from "uuid";
import { authOptions } from "@/lib/auth";
import { getProvider } from "@/providers/registry";
import { generateEvidencePdf } from "@/services/evidence";
import { extractFolderIdFromUrl, uploadFileToDrive } from "@/services/drive";
import { db } from "@/lib/db";
import type { RunCheckInput, NormalizedCheckResult, CheckProviderKey } from "@/lib/types";

const VALID_PROVIDER_KEYS: CheckProviderKey[] = ["avnt_insolvency", "liteko_court_cases"];
const LITEKO_ENABLED = process.env.ENABLE_LITEKO === "true";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email || !session.accessToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { borrowerName, idCode, loanReference, driveFolderUrl, providerKeys: rawKeys } = body;

  if (!borrowerName?.trim()) {
    return NextResponse.json({ error: "borrowerName is required" }, { status: 400 });
  }

  const folderId = extractFolderIdFromUrl(driveFolderUrl ?? "");
  if (!folderId) {
    return NextResponse.json({ error: "Invalid Google Drive folder URL" }, { status: 400 });
  }

  // Validate and filter providerKeys
  const requestedKeys: string[] = Array.isArray(rawKeys) ? rawKeys : [];
  const validKeys = requestedKeys.filter((k): k is CheckProviderKey =>
    VALID_PROVIDER_KEYS.includes(k as CheckProviderKey)
  );
  // Strip LITEKO if feature flag is off
  const enabledKeys = LITEKO_ENABLED
    ? validKeys
    : validKeys.filter((k) => k !== "liteko_court_cases");

  if (enabledKeys.length === 0) {
    return NextResponse.json({ error: "No enabled providers selected" }, { status: 400 });
  }

  // LITEKO first (requires user CAPTCHA), then AVNT (automated)
  const orderedKeys = [
    ...enabledKeys.filter((k) => k === "liteko_court_cases"),
    ...enabledKeys.filter((k) => k !== "liteko_court_cases"),
  ];

  const runGroupId = uuidv4();
  const safeName = borrowerName.trim().replace(/[^a-zA-Z0-9]/g, "_");
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `${safeName}_${dateStr}_evidence.pdf`;

  const input: RunCheckInput = {
    borrowerName: borrowerName.trim(),
    idCode: idCode?.trim() || undefined,
    loanReference: loanReference?.trim() || undefined,
    driveFolderUrl,
    initiatedByEmail: session.user.email,
    providerKeys: orderedKeys,
    runGroupId,
  };

  try {
    const results: NormalizedCheckResult[] = [];

    for (const providerKey of orderedKeys) {
      const provider = getProvider(providerKey);
      let result: NormalizedCheckResult;

      if (!provider) {
        result = {
          providerKey,
          sourceUrl: "",
          searchedAt: new Date().toISOString(),
          borrowerNameInput: input.borrowerName,
          status: "error",
          resultsCount: 0,
          matchedEntities: [],
          summaryText: `Unknown provider: ${providerKey}`,
          screenshotBuffer: null,
        };
      } else {
        try {
          result = await provider.runSearch(input);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            providerKey,
            sourceUrl: "",
            searchedAt: new Date().toISOString(),
            borrowerNameInput: input.borrowerName,
            status: "error",
            resultsCount: 0,
            matchedEntities: [],
            summaryText: `Search failed: ${message}`,
            screenshotBuffer: null,
          };
        }
      }

      await db.searchRun.create({
        data: {
          runGroupId,
          createdByEmail: session.user.email!,
          borrowerName: input.borrowerName,
          borrowerIdCode: input.idCode,
          loanReference: input.loanReference,
          providerKey,
          driveFolderUrl,
          resultStatus: result.status,
          resultsCount: result.resultsCount,
          matchedSummary: result.summaryText,
          requestPayloadJson: JSON.stringify({ ...input, runGroupId }),
          normalizedResultJson: JSON.stringify({ ...result, screenshotBuffer: null }),
        },
      });

      results.push(result);
    }

    // Generate combined PDF
    let pdfBuffer: Buffer | undefined;
    let pdfError: string | undefined;
    try {
      pdfBuffer = await generateEvidencePdf(input, results, filename);
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
    }

    // Upload to Drive
    let driveFileId: string | null = null;
    let driveWebViewLink: string | null = null;
    let driveFileName: string | null = pdfBuffer ? filename : null;
    let driveError: string | undefined;

    if (pdfBuffer) {
      try {
        const uploaded = await uploadFileToDrive(
          session.accessToken,
          folderId,
          filename,
          pdfBuffer
        );
        driveFileId = uploaded.fileId;
        driveWebViewLink = uploaded.webViewLink;
        driveFileName = uploaded.fileName;

        // Back-fill all rows in this group with the Drive file info
        await db.searchRun.updateMany({
          where: { runGroupId },
          data: {
            uploadedFileId: driveFileId,
            uploadedFileUrl: driveWebViewLink,
            uploadedFileName: driveFileName,
          },
        });
      } catch (err) {
        driveError = err instanceof Error ? err.message : String(err);
      }
    }

    return NextResponse.json({
      runGroupId,
      results: results.map((r) => ({
        providerKey: r.providerKey,
        status: r.status,
        resultsCount: r.resultsCount,
        summaryText: r.summaryText,
      })),
      driveFileId,
      driveWebViewLink,
      driveFileName,
      ...(driveError ? { driveError } : {}),
      ...(pdfError ? { pdfError } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test tests/api/checks-run.test.ts
```

Expected: all 8 tests pass.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: checks-run tests pass; history tests may need updating (next task).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/checks/run/route.ts tests/api/checks-run.test.ts
git commit -m "feat: rewrite run route for multi-provider, runGroupId, feature flag"
```

---

### Task 6: Add `GET /api/config` endpoint

**Files:**
- Create: `src/app/api/config/route.ts`
- Create: `tests/api/config.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/api/config.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

describe("GET /api/config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns enableLiteko: false when ENABLE_LITEKO is not set", async () => {
    vi.stubEnv("ENABLE_LITEKO", "false");
    const { GET } = await import("@/app/api/config/route");
    const res = await GET(new NextRequest("http://localhost/api/config"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enableLiteko).toBe(false);
  });

  it("returns enableLiteko: true when ENABLE_LITEKO=true", async () => {
    vi.stubEnv("ENABLE_LITEKO", "true");
    // Re-import to pick up env change
    vi.resetModules();
    const { GET } = await import("@/app/api/config/route");
    const res = await GET(new NextRequest("http://localhost/api/config"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enableLiteko).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
npm test tests/api/config.test.ts
```

Expected: FAIL — file doesn't exist yet.

- [ ] **Step 3: Create `src/app/api/config/route.ts`**

```typescript
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    enableLiteko: process.env.ENABLE_LITEKO === "true",
  });
}
```

- [ ] **Step 4: Run the test**

```bash
npm test tests/api/config.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all previously passing tests still pass + 2 new config tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/config/route.ts tests/api/config.test.ts
git commit -m "feat: add GET /api/config endpoint for feature flags"
```

---

## Chunk 4: LITEKO provider

### Task 7: Implement `src/providers/liteko-court-cases/search.ts`

**Files:**
- Create: `src/providers/liteko-court-cases/search.ts`
- Modify: `src/providers/liteko-court-cases/index.ts` — wire to real search

This is the Playwright automation for LITEKO. It cannot be unit tested (requires a live browser and CAPTCHA). Manual verification is required after implementation.

- [ ] **Step 1: Create `src/providers/liteko-court-cases/search.ts`**

```typescript
/**
 * LITEKO Court Cases — Playwright automation layer
 * Site: https://liteko.teismai.lt/viesasprendimupaieska/
 *
 * CAPTCHA handling: opens a visible browser window for the user to solve.
 * Waits up to 3 minutes for navigation away from the search page.
 */
import { chromium } from "playwright";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

export const LITEKO_BASE_URL = "https://liteko.teismai.lt/viesasprendimupaieska/";
const CAPTCHA_TIMEOUT_MS = 180_000; // 3 minutes

export async function runLitekoSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: false, // Visible window — user must solve CAPTCHA
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({ locale: "lt-LT" });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    await page.goto(LITEKO_BASE_URL, { waitUntil: "networkidle" });

    // Fill in the borrower name field
    const nameSelectors = [
      'input[name="searchText"]',
      'input[placeholder*="pavadinimas" i]',
      'input[placeholder*="vardas" i]',
      'input[type="text"]',
    ];
    let filled = false;
    for (const sel of nameSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3_000 });
        await page.fill(sel, input.borrowerName);
        filled = true;
        break;
      } catch { /* try next */ }
    }

    if (!filled) {
      throw new Error(
        "Could not locate the search field on the LITEKO page. " +
          "The page structure may have changed — update nameSelectors in search.ts."
      );
    }

    // Fill ID code if provided
    if (input.idCode) {
      const idSelectors = [
        'input[name="code"]',
        'input[placeholder*="kodas" i]',
      ];
      for (const sel of idSelectors) {
        try {
          await page.waitForSelector(sel, { timeout: 2_000 });
          await page.fill(sel, input.idCode);
          break;
        } catch { /* optional field */ }
      }
    }

    // Register navigation wait BEFORE clicking submit to avoid race condition.
    // waitForURL detects when we've left the search page (CAPTCHA solved + submitted).
    const [_] = await Promise.all([
      page.waitForURL(
        (url) => !url.href.includes("/viesasprendimupaieska"),
        { timeout: CAPTCHA_TIMEOUT_MS }
      ),
      // Attempt to click submit; the user may also press Enter themselves after CAPTCHA
      page.click('button[type="submit"], input[type="submit"]').catch(() => {}),
    ]);

    // Give results page time to settle
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_000);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const bodyText = await page.evaluate(() => document.body.innerText);

    const { status, resultsCount, matchedEntities, summaryText } =
      parseLitekoResults(bodyText, input.borrowerName);

    return {
      providerKey: "liteko_court_cases",
      sourceUrl: LITEKO_BASE_URL,
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
    const isTimeout = message.toLowerCase().includes("timeout");
    return {
      providerKey: "liteko_court_cases",
      sourceUrl: LITEKO_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: isTimeout
        ? "CAPTCHA timeout — not solved within 3 minutes"
        : `Search failed: ${message}`,
      screenshotBuffer: null,
    };
  } finally {
    if (browser) await browser.close();
  }
}

function parseLitekoResults(
  bodyText: string,
  borrowerName: string
): Pick<NormalizedCheckResult, "status" | "resultsCount" | "matchedEntities" | "summaryText"> {
  // Primary signal: "Rasta N bylų" (Found N cases) or similar Lithuanian count text
  const countPatterns = [
    /rasta\s+(\d+)\s+byl[oų]/i,
    /(\d+)\s+byl[oų]\s+rasta/i,
    /iš viso\s+(\d+)/i,
    /rodomi\s+\d+\s*[-–]\s*\d+\s+iš\s+(\d+)/i,
  ];

  for (const pattern of countPatterns) {
    const match = bodyText.match(pattern);
    if (match) {
      const count = parseInt(match[1], 10);
      if (count === 0) {
        return {
          status: "no_match",
          resultsCount: 0,
          matchedEntities: [],
          summaryText: `No court case records found on LITEKO for "${borrowerName}".`,
        };
      }
      const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
      const entities = lines
        .filter((l) => l.toLowerCase().includes(borrowerName.toLowerCase().split(" ")[0].toLowerCase()))
        .slice(0, 10)
        .map((l) => ({ name: l }));
      return {
        status: count === 1 ? "match_found" : "match_found",
        resultsCount: count,
        matchedEntities: entities,
        summaryText: `${count} court case record${count !== 1 ? "s" : ""} found on LITEKO for "${borrowerName}".`,
      };
    }
  }

  // No-result signals
  const lower = bodyText.toLowerCase();
  const noResultSignals = ["nerasta", "rezultatų nerasta", "nothing found", "no results", "0 bylų"];
  if (noResultSignals.some((s) => lower.includes(s))) {
    return {
      status: "no_match",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `No court case records found on LITEKO for "${borrowerName}".`,
    };
  }

  // Could not parse — return ambiguous
  return {
    status: "ambiguous",
    resultsCount: 0,
    matchedEntities: [],
    summaryText:
      "Court case search page loaded but results could not be clearly parsed. " +
      "Please review the screenshot in the PDF.",
  };
}
```

- [ ] **Step 2: Update `src/providers/liteko-court-cases/index.ts` to wire to real search**

Replace the stub:

```typescript
import { runLitekoSearch } from "./search";
import type { PublicCheckProvider, RunCheckInput, NormalizedCheckResult } from "@/lib/types";

export class LitekoCourtCasesProvider implements PublicCheckProvider {
  async runSearch(input: RunCheckInput): Promise<NormalizedCheckResult> {
    return runLitekoSearch(input);
  }
}
```

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/providers/liteko-court-cases/
git commit -m "feat: implement LITEKO court cases provider with CAPTCHA handling"
```

---

## Chunk 5: History API + frontend

### Task 8: Update history API for grouped display

**Files:**
- Modify: `src/app/api/history/route.ts`
- Modify: `tests/api/history.test.ts`

- [ ] **Step 1: Update the history tests**

Replace `tests/api/history.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    searchRun: {
      findMany: vi.fn(),
    },
  },
}));

import { GET } from "@/app/api/history/route";
import { getServerSession } from "next-auth";
import { db } from "@/lib/db";

const mockSession = { user: { email: "tester@example.com" } };

const mockGroupRow = {
  runGroupId: "group-uuid-1",
  groupCreatedAt: new Date("2026-03-25"),
};

const mockRunRows = [
  {
    id: "run-1",
    runGroupId: "group-uuid-1",
    createdAt: new Date("2026-03-25"),
    createdByEmail: "tester@example.com",
    borrowerName: "Test Co",
    providerKey: "liteko_court_cases",
    resultStatus: "no_match",
    resultsCount: 0,
    uploadedFileUrl: "https://drive.google.com/file/d/file-1/view",
    uploadedFileName: "Test_Co_20260325_evidence.pdf",
  },
  {
    id: "run-2",
    runGroupId: "group-uuid-1",
    createdAt: new Date("2026-03-25"),
    createdByEmail: "tester@example.com",
    borrowerName: "Test Co",
    providerKey: "avnt_insolvency",
    resultStatus: "no_match",
    resultsCount: 0,
    uploadedFileUrl: "https://drive.google.com/file/d/file-1/view",
    uploadedFileName: "Test_Co_20260325_evidence.pdf",
  },
];

describe("GET /api/history", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);
    const res = await GET(new NextRequest("http://localhost/api/history"));
    expect(res.status).toBe(401);
  });

  it("returns grouped runs", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.$queryRaw as any).mockResolvedValue([mockGroupRow]);
    vi.mocked(db.searchRun.findMany).mockResolvedValue(mockRunRows as any);

    const res = await GET(new NextRequest("http://localhost/api/history"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.groups).toHaveLength(1);
    expect(json.groups[0].runGroupId).toBe("group-uuid-1");
    expect(json.groups[0].runs).toHaveLength(2);
  });

  it("returns empty groups array when no runs exist", async () => {
    vi.mocked(getServerSession).mockResolvedValue(mockSession as any);
    vi.mocked(db.$queryRaw as any).mockResolvedValue([]);
    vi.mocked(db.searchRun.findMany).mockResolvedValue([] as any);

    const res = await GET(new NextRequest("http://localhost/api/history"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.groups).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

```bash
npm test tests/api/history.test.ts
```

Expected: FAIL — API still uses old flat shape.

- [ ] **Step 3: Rewrite `src/app/api/history/route.ts`**

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
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const offset = (page - 1) * limit;

  // Step 1: Get non-legacy groups (runGroupId != ""), paginated
  const groupRows = await db.$queryRaw<{ runGroupId: string; groupCreatedAt: Date }[]>`
    SELECT runGroupId, MIN(createdAt) AS groupCreatedAt
    FROM SearchRun
    WHERE runGroupId != ''
    GROUP BY runGroupId
    ORDER BY groupCreatedAt DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  // Step 2: For each group, fetch all its rows
  const groups = await Promise.all(
    groupRows.map(async (g) => {
      const runs = await db.searchRun.findMany({
        where: { runGroupId: g.runGroupId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          runGroupId: true,
          createdAt: true,
          createdByEmail: true,
          borrowerName: true,
          providerKey: true,
          resultStatus: true,
          resultsCount: true,
          uploadedFileUrl: true,
          uploadedFileName: true,
        },
      });
      return {
        runGroupId: g.runGroupId,
        groupCreatedAt: g.groupCreatedAt,
        borrowerName: runs[0]?.borrowerName ?? "",
        createdByEmail: runs[0]?.createdByEmail ?? "",
        uploadedFileUrl: runs.find((r) => r.uploadedFileUrl)?.uploadedFileUrl ?? null,
        uploadedFileName: runs.find((r) => r.uploadedFileName)?.uploadedFileName ?? null,
        runs,
      };
    })
  );

  // Step 3: Legacy rows (runGroupId = "") — each displayed individually
  const legacyRuns = await db.searchRun.findMany({
    where: { runGroupId: "" },
    orderBy: { createdAt: "desc" },
    skip: 0,
    take: 50, // cap legacy display
    select: {
      id: true,
      runGroupId: true,
      createdAt: true,
      createdByEmail: true,
      borrowerName: true,
      providerKey: true,
      resultStatus: true,
      resultsCount: true,
      uploadedFileUrl: true,
      uploadedFileName: true,
    },
  });

  const legacyGroups = legacyRuns.map((r) => ({
    runGroupId: r.id, // use row ID as pseudo-group ID for key
    groupCreatedAt: r.createdAt,
    borrowerName: r.borrowerName,
    createdByEmail: r.createdByEmail,
    uploadedFileUrl: r.uploadedFileUrl,
    uploadedFileName: r.uploadedFileName,
    runs: [r],
  }));

  return NextResponse.json({ groups, legacyGroups, page, limit });
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test tests/api/history.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/history/route.ts tests/api/history.test.ts
git commit -m "feat: update history API for grouped multi-provider display"
```

---

### Task 9: Update `CheckForm` — checkboxes + new result display

**Files:**
- Modify: `src/components/CheckForm.tsx`

No unit tests for React components in this project — verify manually via `npm run dev`.

- [ ] **Step 1: Replace `src/components/CheckForm.tsx`**

```typescript
"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { ResultStatus } from "@/lib/types";

interface ProviderResult {
  providerKey: string;
  status: ResultStatus;
  resultsCount: number;
  summaryText: string;
}

interface RunResult {
  runGroupId: string;
  results: ProviderResult[];
  driveWebViewLink: string | null;
  driveFileName: string | null;
  driveError?: string;
  pdfError?: string;
}

const STATUS_CONFIG: Record<ResultStatus, { label: string; className: string }> = {
  no_match: { label: "NO RECORD FOUND", className: "border-green-600 bg-green-600 text-white" },
  match_found: { label: "RECORD FOUND", className: "border-red-600 bg-red-600 text-white" },
  ambiguous: { label: "AMBIGUOUS — MANUAL REVIEW REQUIRED", className: "border-amber-500 bg-amber-500 text-white" },
  error: { label: "TECHNICAL ERROR", className: "border-gray-400 bg-gray-400 text-white" },
};

const PROVIDER_LABELS: Record<string, string> = {
  avnt_insolvency: "AVNT Insolvency Register",
  liteko_court_cases: "LITEKO Court Cases",
};

export function CheckForm() {
  const [borrowerName, setBorrowerName] = useState("");
  const [idCode, setIdCode] = useState("");
  const [loanReference, setLoanReference] = useState("");
  const [driveFolderUrl, setDriveFolderUrl] = useState("");
  const [avntChecked, setAvntChecked] = useState(true);
  const [litekoChecked, setLitekoChecked] = useState(true);
  const [litekoEnabled, setLitekoEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingLiteko, setLoadingLiteko] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => setLitekoEnabled(d.enableLiteko === true))
      .catch(() => {}); // silently ignore — LITEKO checkbox stays hidden
  }, []);

  const selectedKeys = [
    ...(litekoEnabled && litekoChecked ? ["liteko_court_cases"] : []),
    ...(avntChecked ? ["avnt_insolvency"] : []),
  ];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedKeys.length === 0) {
      setError("Please select at least one registry to check.");
      return;
    }
    setLoading(true);
    setLoadingLiteko(selectedKeys.includes("liteko_court_cases"));
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
          providerKeys: selectedKeys,
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
      setLoadingLiteko(false);
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
          <Label>Registries to Check *</Label>
          <div className="space-y-2">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={avntChecked}
                onChange={(e) => setAvntChecked(e.target.checked)}
                className="mt-0.5"
              />
              <div>
                <div className="text-sm font-medium">AVNT Insolvency Register</div>
                <div className="text-xs text-muted-foreground">Automated · ~20s</div>
              </div>
            </label>
            {litekoEnabled && (
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={litekoChecked}
                  onChange={(e) => setLitekoChecked(e.target.checked)}
                  className="mt-0.5"
                />
                <div>
                  <div className="text-sm font-medium">LITEKO Court Cases</div>
                  <div className="text-xs text-muted-foreground">Requires CAPTCHA · ~2 min</div>
                </div>
              </label>
            )}
          </div>
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
          {loading
            ? loadingLiteko
              ? "Running checks… A browser window has opened — solve the CAPTCHA to continue. AVNT will run automatically after."
              : "Running check…"
            : "Run Check"}
        </Button>
      </form>

      {result && (
        <div className="space-y-3">
          {result.results.map((r) => {
            const cfg = STATUS_CONFIG[r.status] ?? STATUS_CONFIG.error;
            return (
              <div key={r.providerKey} className="rounded-lg border p-4 space-y-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {PROVIDER_LABELS[r.providerKey] ?? r.providerKey}
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className={`text-xs font-bold tracking-wide px-3 py-1 ${cfg.className}`}>
                    {r.status === "match_found"
                      ? `${r.resultsCount} RECORD${r.resultsCount !== 1 ? "S" : ""} FOUND`
                      : cfg.label}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {r.resultsCount} {r.resultsCount === 1 ? "result" : "results"}
                  </span>
                </div>
                <p className="text-sm">{r.summaryText}</p>
              </div>
            );
          })}

          {/* Combined PDF tile */}
          <div className="rounded-lg border p-4 space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Combined Evidence PDF
            </div>
            {result.driveWebViewLink ? (
              <>
                {result.driveFileName && (
                  <p className="text-sm text-muted-foreground">{result.driveFileName}</p>
                )}
                <a
                  href={result.driveWebViewLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-500 hover:underline"
                >
                  Open combined PDF →
                </a>
              </>
            ) : result.driveError ? (
              <div className="space-y-1">
                <p className="text-sm text-destructive">Drive upload failed: {result.driveError}</p>
                {(result.driveError.includes("401") ||
                  result.driveError.toLowerCase().includes("invalid_grant")) && (
                  <p className="text-sm text-muted-foreground">
                    Your Google session may have expired. Please sign out and sign back in.
                  </p>
                )}
              </div>
            ) : result.pdfError ? (
              <p className="text-sm text-destructive">PDF generation failed: {result.pdfError}</p>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run all tests (no component tests — check TypeScript)**

```bash
npx tsc --noEmit && npm test
```

Expected: no TypeScript errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/CheckForm.tsx
git commit -m "feat: replace registry select with checkboxes, update result display for multi-provider"
```

---

### Task 10: Update `HistoryTable` for grouped display

**Files:**
- Modify: `src/components/HistoryTable.tsx`

- [ ] **Step 1: Replace `src/components/HistoryTable.tsx`**

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ResultStatus } from "@/lib/types";

interface RunRow {
  id: string;
  runGroupId: string;
  createdAt: string;
  createdByEmail: string;
  borrowerName: string;
  providerKey: string;
  resultStatus: ResultStatus;
  resultsCount: number;
  uploadedFileUrl: string | null;
  uploadedFileName: string | null;
}

interface GroupRow {
  runGroupId: string;
  groupCreatedAt: string;
  borrowerName: string;
  createdByEmail: string;
  uploadedFileUrl: string | null;
  uploadedFileName: string | null;
  runs: RunRow[];
}

const STATUS_BADGE: Record<ResultStatus, { label: string; className: string }> = {
  no_match: { label: "No match", className: "border-green-600 bg-green-600 text-white" },
  match_found: { label: "Match", className: "border-red-600 bg-red-600 text-white" },
  ambiguous: { label: "Ambiguous", className: "border-amber-500 bg-amber-500 text-white" },
  error: { label: "Error", className: "border-gray-400 bg-gray-400 text-white" },
};

const PROVIDER_SHORT: Record<string, string> = {
  avnt_insolvency: "AVNT",
  liteko_court_cases: "LITEKO",
};

export function HistoryTable() {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [legacyGroups, setLegacyGroups] = useState<GroupRow[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const limit = 20;

  const fetchPage = useCallback(async (p: number) => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/history?page=${p}&limit=${limit}`);
      const data = await res.json();
      if (!res.ok) {
        setFetchError(data.error ?? "Failed to load history");
        return;
      }
      setGroups(data.groups ?? []);
      setLegacyGroups(p === 1 ? (data.legacyGroups ?? []) : []);
      setPage(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPage(1); }, [fetchPage]);

  const allRows = [
    ...groups,
    ...(page === 1 ? legacyGroups : []),
  ].sort(
    (a, b) => new Date(b.groupCreatedAt).getTime() - new Date(a.groupCreatedAt).getTime()
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {allRows.length} run group{allRows.length !== 1 ? "s" : ""} shown
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fetchPage(page - 1)} disabled={page <= 1 || loading}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" onClick={() => fetchPage(page + 1)} disabled={groups.length < limit || loading}>
            Next
          </Button>
        </div>
      </div>

      {fetchError && (
        <p className="text-sm text-destructive text-center py-4">{fetchError}</p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Borrower</TableHead>
              <TableHead>Checks</TableHead>
              <TableHead>By</TableHead>
              <TableHead>PDF</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {loading ? "Loading…" : "No checks run yet"}
                </TableCell>
              </TableRow>
            )}
            {allRows.map((group) => (
              <TableRow key={group.runGroupId}>
                <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                  {new Date(group.groupCreatedAt).toLocaleDateString("en-GB")}
                </TableCell>
                <TableCell className="font-medium text-sm">{group.borrowerName}</TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {group.runs.map((run) => {
                      const badge = STATUS_BADGE[run.resultStatus] ?? { label: run.resultStatus, className: "" };
                      return (
                        <div key={run.id} className="flex items-center gap-1">
                          <span className="text-xs text-muted-foreground">
                            {PROVIDER_SHORT[run.providerKey] ?? run.providerKey}
                          </span>
                          <Badge variant="outline" className={`text-xs ${badge.className}`}>
                            {badge.label}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {group.createdByEmail.split("@")[0]}
                </TableCell>
                <TableCell>
                  {group.uploadedFileUrl ? (
                    <a
                      href={group.uploadedFileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open PDF for ${group.borrowerName}`}
                      className="text-blue-500 hover:underline text-sm"
                    >
                      ↗
                    </a>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run TypeScript check and tests**

```bash
npx tsc --noEmit && npm test
```

Expected: no TypeScript errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/HistoryTable.tsx
git commit -m "feat: update history table for grouped multi-provider display"
```

---

### Task 11: Update `.env.example` and verify full build

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Add ENABLE_LITEKO to `.env.example`**

Open `.env.example` and add at the end:

```
# Set to true to enable LITEKO court case search.
# Requires a visible display (headless: false) — do not enable on headless servers.
# When enabled, set reverse proxy read timeout >= 300s.
ENABLE_LITEKO=false
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass (14 original + new ones from Tasks 4, 5, 6, 8).

- [ ] **Step 3: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run build to verify no build errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "chore: add ENABLE_LITEKO to .env.example with documentation"
```

- [ ] **Step 6: Manual smoke test**

```bash
npm run dev
```

Open `http://localhost:3000/check` and verify:
- AVNT checkbox is visible and checked
- LITEKO checkbox is hidden (ENABLE_LITEKO=false by default)
- Running AVNT-only check works end-to-end (no regression)
- History page shows existing runs correctly

To test LITEKO:
- Add `ENABLE_LITEKO=true` to `.env.local`
- Restart `npm run dev`
- LITEKO checkbox should appear
- Submit form with both checked — visible browser window should open

---
