import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";

import {
  processEvent,
  type StravaWebhookEvent,
} from "@/lib/pipeline/processEvent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Strava webhook receiver.
 *
 * Two hard timing rules from Strava's side shape everything here:
 * - Subscription validation (GET) must echo hub.challenge within seconds.
 * - Event delivery (POST) expects a 200 within 2 seconds, or Strava retries —
 *   so the response goes out first and the pipeline runs in after(), which
 *   executes once the response is sent.
 */

function verifyToken(): string {
  const token = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
  if (!token) throw new Error("STRAVA_WEBHOOK_VERIFY_TOKEN is not set");
  return token;
}

/** Subscription validation handshake. */
export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe" || token !== verifyToken() || !challenge) {
    return NextResponse.json({ error: "verification failed" }, { status: 403 });
  }
  // Strava requires exactly this shape back.
  return NextResponse.json({ "hub.challenge": challenge });
}

/** Event delivery: acknowledge fast, process after the response. */
export async function POST(req: NextRequest) {
  let event: StravaWebhookEvent;
  try {
    event = (await req.json()) as StravaWebhookEvent;
  } catch {
    // Malformed body: acknowledge anyway. A 4xx makes Strava retry the same
    // unparseable payload, and repeated failures disable the subscription.
    return NextResponse.json({ received: false });
  }

  after(async () => {
    try {
      await processEvent(event, "webhook");
    } catch (e) {
      // processEvent records its own failures; this catches everything before
      // that logging exists (e.g. the DB itself being down).
      console.error("webhook pipeline failed", e);
    }
  });

  return NextResponse.json({ received: true });
}
