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
