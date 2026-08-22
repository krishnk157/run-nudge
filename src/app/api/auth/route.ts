import { NextResponse, type NextRequest } from "next/server";

import { COOKIE } from "@/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exchange the shared secret for a cookie, once per device.
 *
 * No login form and no accounts table, because there is one user and adding
 * either would be inventing a problem to solve. The cookie is HttpOnly so a
 * script on the page cannot read it, Secure so it never crosses plain HTTP,
 * and SameSite=Lax so another site cannot ride it.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const secret = process.env.ADMIN_TOKEN;

  if (!secret) {
    return NextResponse.json({ error: "ADMIN_TOKEN is not set" }, { status: 503 });
  }
  if (token !== secret) {
    // Deliberately unhelpful: a wrong token learns nothing about the right one.
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(COOKIE, secret, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
