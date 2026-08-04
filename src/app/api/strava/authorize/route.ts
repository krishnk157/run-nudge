import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { env } from "@/lib/env";
import { buildAuthorizeUrl } from "@/lib/strava/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const OAUTH_STATE_COOKIE = "strava_oauth_state";

function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Single-user entrypoint: this is deployed on a public URL, so it's gated by a
 * shared secret. Visit /api/strava/authorize?token=$ADMIN_TOKEN to connect.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!safeEquals(token, env().ADMIN_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // CSRF: a nonce echoed back by Strava in `state` and compared to an httpOnly cookie.
  const state = randomBytes(16).toString("hex");
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return res;
}
