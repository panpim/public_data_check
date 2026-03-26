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
    expect(json.results).toHaveLength(1);
  });
});
