import { NextResponse, type NextRequest } from "next/server";

import { authorizeCron } from "@/lib/cron/auth";
import { deliverPending, requeueFailed } from "@/lib/notify/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Delivery sweep. The webhook path sends inline, so on a healthy day this
 * finds nothing — it exists for the unhealthy ones: Telegram down, a deploy
 * mid-flight, a row drafted while credentials were missing.
 *
 * Failed sends are requeued (bounded by age) before the sweep, so a transient
 * outage self-heals on the next tick instead of losing the notification.
 *
 * Once a day, not hourly: Vercel's Hobby plan permits one cron run per day and
 * rejects the deploy outright otherwise — a platform limit that changed the
 * design rather than just the schedule. The compensation is that the webhook
 * path requeues stale failures before it delivers, so an activity is what
 * usually heals a failed send and this route is genuinely the backstop it was
 * always described as.
 */
export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  try {
    const requeued = await requeueFailed(24);
    const summary = await deliverPending();
    return NextResponse.json({ requeued, ...summary });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
