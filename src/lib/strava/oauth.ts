import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { stravaTokens } from "@/db/schema";
import { env, stravaRedirectUri } from "@/lib/env";
import { tokenResponseSchema, type TokenResponse } from "./types";

const TOKEN_URL = "https://www.strava.com/oauth/token";
const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";

/**
 * `activity:read_all` is required to see private activities; without it a
 * backfill silently misses runs the athlete marked private.
 */
export const REQUIRED_SCOPES = "read,activity:read_all,profile:read_all";

/** Refresh this far ahead of expiry so an in-flight request can't race the clock. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function buildAuthorizeUrl(state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", env().STRAVA_CLIENT_ID);
  url.searchParams.set("redirect_uri", stravaRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", REQUIRED_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env().STRAVA_CLIENT_ID,
      client_secret: env().STRAVA_CLIENT_SECRET,
      ...body,
    }),
    cache: "no-store",
  });

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Strava token request failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return tokenResponseSchema.parse(json);
}

/** Exchange the one-time `code` from the OAuth callback and persist the result. */
export async function exchangeCodeForTokens(code: string) {
  const token = await postToken({ code, grant_type: "authorization_code" });
  if (!token.athlete) {
    throw new Error("Strava did not return an athlete on code exchange");
  }
  await persistTokens(token.athlete.id, token);
  return token;
}

async function persistTokens(athleteId: number, token: TokenResponse) {
  const row = {
    athleteId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: new Date(token.expires_at * 1000),
    scope: token.scope ?? null,
    athleteFirstname: token.athlete?.firstname ?? null,
    athleteLastname: token.athlete?.lastname ?? null,
    updatedAt: new Date(),
  };

  await db
    .insert(stravaTokens)
    .values(row)
    .onConflictDoUpdate({
      target: stravaTokens.athleteId,
      set: {
        accessToken: row.accessToken,
        refreshToken: row.refreshToken,
        expiresAt: row.expiresAt,
        // Strava omits scope on refresh; don't overwrite a known scope with null.
        ...(row.scope ? { scope: row.scope } : {}),
        updatedAt: row.updatedAt,
      },
    });
}

/** The connected athlete, or null if OAuth hasn't been completed yet. */
export async function getConnectedAthlete() {
  const rows = await db.select().from(stravaTokens).limit(1);
  return rows[0] ?? null;
}

/**
 * Returns a valid access token for the athlete, refreshing and persisting first
 * if the stored one is expired or about to be. This is the only place tokens
 * are read — callers never touch the table directly.
 */
export async function getAccessToken(athleteId?: number): Promise<{
  athleteId: number;
  accessToken: string;
}> {
  const stored = athleteId
    ? (
        await db
          .select()
          .from(stravaTokens)
          .where(eq(stravaTokens.athleteId, athleteId))
          .limit(1)
      )[0]
    : await getConnectedAthlete();

  if (!stored) {
    throw new Error(
      "No Strava tokens stored — complete the OAuth flow at /api/strava/authorize first",
    );
  }

  const expiresSoon =
    stored.expiresAt.getTime() - Date.now() < REFRESH_SKEW_MS;
  if (!expiresSoon) {
    return { athleteId: stored.athleteId, accessToken: stored.accessToken };
  }

  const refreshed = await postToken({
    grant_type: "refresh_token",
    refresh_token: stored.refreshToken,
  });
  await persistTokens(stored.athleteId, refreshed);
  return {
    athleteId: stored.athleteId,
    accessToken: refreshed.access_token,
  };
}
