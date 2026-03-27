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
