# Public Registry Check Tool — Design Spec

**Date:** 2026-03-24
**Status:** Approved

---

## Overview

An internal web tool for loan operations teams to run public-registry compliance checks and automatically save PDF evidence to Google Drive. A teammate signs in with Google, fills in a borrower name and Drive folder URL, and the tool runs a Playwright-automated search, generates a PDF evidence report, uploads it to the specified Drive folder, and writes an audit record to a local database.

---

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Framework | Next.js App Router | Modern, server components, matches spec |
| Database | SQLite via Prisma | Zero-setup, single-server deploy, sufficient for internal tool |
| UI library | shadcn/ui + Tailwind CSS | Headless, dark-mode ready, minimal bundle |
| Auth | NextAuth v5 — Google OAuth only | Simple, no user management needed |
| Session storage | JWT (no DB adapter) | Keeps schema to a single table |
| Architecture | App Router + API route | Matches documented architecture exactly |

---

## Architecture

```
Frontend (Next.js App Router)
  └─ CheckForm  →  POST /api/checks/run
                       │
          ┌────────────┼────────────────────┐
          ▼            ▼                    ▼
    Provider layer  Evidence service   Drive service
    (Playwright)    (pdf-lib)          (googleapis)
          │
    AVNT search → normalise → screenshot
```

### Request pipeline — POST /api/checks/run

1. **Auth check** — 401 if no session
2. **Input validation** — borrowerName required, driveFolderUrl must be a valid Drive URL
3. **Provider lookup** — resolve `providerKey` → `PublicCheckProvider` from registry (400 if unknown)
4. **Run search** — `provider.runSearch(input)` → `NormalizedCheckResult` (Playwright, ~10–25 s)
5. **Generate PDF** — `generateEvidencePdf(input, result, filename)` → `Buffer`
6. **Upload to Drive** — extract folder ID from URL, upload PDF with user's OAuth access token → `{ fileId, webViewLink }`
7. **Write audit row** — `prisma.searchRun.create(…)` — always written, even on partial failure
8. **Return JSON** — `{ status, resultsCount, summaryText, driveUrl, runId }`

### Error handling

| Failure point | Behaviour |
|---|---|
| Playwright search fails | `resultStatus = "error"`, audit row written, PDF still generated with error cover page |
| Drive upload fails | Audit row written with no `fileId`, result returned to UI with a warning |
| Drive token expired | NextAuth refreshes via `refresh_token`; 401 returned if refresh fails |

---

## Project Structure

```
panpim/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app/
│   │   ├── layout.tsx               # SessionProvider, fonts
│   │   ├── page.tsx                 # redirect → /check
│   │   ├── check/page.tsx           # CheckForm (protected)
│   │   ├── history/page.tsx         # Audit log table (protected)
│   │   └── api/
│   │       ├── auth/[...nextauth]/route.ts
│   │       ├── checks/run/route.ts  # POST handler
│   │       └── history/route.ts     # GET audit rows
│   ├── components/
│   │   ├── CheckForm.tsx
│   │   ├── ResultCard.tsx
│   │   ├── HistoryTable.tsx
│   │   ├── Nav.tsx
│   │   └── ui/                      # shadcn components
│   ├── providers/
│   │   ├── avnt-insolvency/
│   │   │   ├── index.ts
│   │   │   └── search.ts            # (already written)
│   │   └── registry.ts
│   ├── services/
│   │   ├── evidence.ts              # (already written)
│   │   └── drive.ts
│   └── lib/
│       ├── auth.ts                  # NextAuth config
│       ├── db.ts                    # Prisma client singleton
│       └── types.ts                 # shared TypeScript types
├── data/                            # checks.db lives here
├── .env.example
└── package.json
```

---

## Database Schema

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model SearchRun {
  id                  String   @id @default(cuid())
  createdAt           DateTime @default(now())
  createdByEmail      String

  // Search input
  borrowerName        String
  borrowerIdCode      String?
  loanReference       String?
  providerKey         String
  driveFolderUrl      String

  // Normalised result
  resultStatus        String   // no_match | match_found | ambiguous | error
  resultsCount        Int
  matchedSummary      String?

  // Drive evidence
  uploadedFileId      String?
  uploadedFileUrl     String?

  // Raw payloads for reprocessing
  requestPayloadJson  String?
  normalizedResultJson String?
}
```

**Key decisions:**
- `@id @default(cuid())` — collision-safe, URL-safe string IDs
- `resultStatus String` — SQLite has no enum; validated in app layer
- `requestPayloadJson` — enables re-generating PDFs without re-searching
- No Account/Session tables — NextAuth uses JWT sessions

---

## Services

### drive.ts

```typescript
uploadFileToDrive(
  accessToken: string,   // user's Google OAuth token from NextAuth session
  folderId: string,      // extracted from Drive folder URL
  filename: string,
  pdfBuffer: Buffer
): Promise<{ fileId: string; webViewLink: string }>
```

Uses `drive.file` scope — the app can only touch files it created. No service account required.

---

## Frontend

### Pages

| Route | Purpose | Auth required |
|---|---|---|
| `/` | Redirect to `/check` | No |
| `/check` | Run a compliance check | Yes |
| `/history` | Audit log of all past runs | Yes |
| `/api/auth/*` | NextAuth Google OAuth | — |

### Components

| Component | Responsibility |
|---|---|
| `Nav.tsx` | Top bar with links, signed-in email, sign out |
| `CheckForm.tsx` | Controlled form, calls POST /api/checks/run, shows loading state |
| `ResultCard.tsx` | Coloured result badge (green/red/amber/grey) + Drive link |
| `HistoryTable.tsx` | Paginated table, fetches GET /api/history, Drive link per row |

### Result badge colours

| Status | Colour | Label |
|---|---|---|
| `no_match` | Green | NO RECORD FOUND |
| `match_found` | Red | RECORD FOUND |
| `ambiguous` | Amber | AMBIGUOUS — MANUAL REVIEW REQUIRED |
| `error` | Grey | TECHNICAL ERROR |

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | `file:./data/checks.db` |
| `NEXTAUTH_SECRET` | Random string (`openssl rand -base64 32`) |
| `NEXTAUTH_URL` | Public URL (e.g. `http://localhost:3000`) |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth 2.0 client secret |

---

## Out of Scope

- Email/password authentication
- User allowlist / invite system
- Multiple simultaneous providers per check run
- Background job queue (checks run synchronously in the API route)
- PDF reprocessing UI (raw JSON stored in DB for future use)
