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
  const skip = (page - 1) * limit;
  const q = searchParams.get("q")?.trim() || undefined;

  const where = q
    ? { borrowerName: { contains: q, mode: "insensitive" as const } }
    : undefined;

  const [runs, total] = await Promise.all([
    db.searchRun.findMany({
      where,
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
    db.searchRun.count({ where }),
  ]);

  return NextResponse.json({ runs, total, page, limit });
}
