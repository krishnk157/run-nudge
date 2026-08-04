import { NextResponse, type NextRequest } from "next/server";

import { exchangeCodeForTokens, REQUIRED_SCOPES } from "@/lib/strava/oauth";
import { OAUTH_STATE_COOKIE } from "../authorize/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const error = params.get("error");
  if (error) {
    return NextResponse.json(
      { error: `Strava authorization denied: ${error}` },
      { status: 400 },
    );
  }

  const state = params.get("state");
  const expectedState = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!state || !expectedState || state !== expectedState) {
    return NextResponse.json(
      { error: "Invalid OAuth state — start again at /api/strava/authorize" },
      { status: 400 },
    );
  }

  const code = params.get("code");
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  // Strava lets the user untick scopes on the consent screen; without
  // activity:read_all the backfill would quietly skip private activities.
  const granted = (params.get("scope") ?? "").split(",").filter(Boolean);
  const missing = REQUIRED_SCOPES.split(",").filter(
    (s) => !granted.includes(s),
  );
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Missing required scopes: ${missing.join(", ")}. Re-authorize and accept all permissions.`,
      },
      { status: 400 },
    );
  }

  try {
    const token = await exchangeCodeForTokens(code);
    const res = NextResponse.json({
      connected: true,
      athleteId: token.athlete?.id,
      athlete:
        `${token.athlete?.firstname ?? ""} ${token.athlete?.lastname ?? ""}`.trim() ||
        undefined,
      scope: token.scope,
      next: "Run `npm run backfill` to pull your history.",
    });
    res.cookies.delete(OAUTH_STATE_COOKIE);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Token exchange failed" },
      { status: 500 },
    );
  }
}
