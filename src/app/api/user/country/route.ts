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
