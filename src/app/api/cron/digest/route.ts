import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { authorizeCron } from "@/lib/cron/auth";
import { writeDigest } from "@/lib/llm/digest";
import { defaultNotifier } from "@/lib/notify/deliver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The digest does real work (SQL + one model call) — give it room. */
export const maxDuration = 60;

/**
 * Weekly digest. Unlike the per-activity path, this always sends: a quiet
 * week is itself the report, and a cadence the athlete can rely on is what
 * makes the *absence* of an alert meaningful the rest of the time.
 *
 * Sends inline rather than drafting-then-delivering, because there is no
 * judgment step to separate from delivery here.
 */
export async function GET(req: NextRequest) {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: 401 });
  }

  try {
    const { digest, stats } = await writeDigest();
    const notifier = defaultNotifier();

    const result = notifier.isConfigured()
      ? await notifier.send({
          subject: digest.subject,
          body: digest.body,
          severity: "info",
        })
      : { ok: false, error: `${notifier.channel} is not configured` };

    await db.insert(notifications).values({
      trigger: "cron",
      decision: "notify",
      severity: "info",
      subject: digest.subject,
      message: digest.body,
      rationale: `weekly digest for ${stats.weekStart}..${stats.weekEnd}${digest.degraded ? ` (degraded: ${digest.degraded})` : ""}`,
      findings: stats as unknown as Record<string, unknown>,
      model: digest.model,
      inputTokens: digest.inputTokens,
      outputTokens: digest.outputTokens,
      status: result.ok ? "sent" : "send_failed",
      channel: notifier.channel,
      externalId: result.externalId ?? null,
      sentAt: result.ok ? new Date() : null,
      error: result.ok ? null : result.error,
    });

    return NextResponse.json({
      sent: result.ok,
      subject: digest.subject,
      sessions: stats.sessions,
      degraded: digest.degraded ?? null,
      error: result.ok ? null : result.error,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
