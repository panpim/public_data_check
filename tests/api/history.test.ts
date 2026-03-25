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
