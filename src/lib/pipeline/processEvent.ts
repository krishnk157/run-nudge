import { db } from "@/db/client";
import { notifications, webhookEvents } from "@/db/schema";
import { computeInsights } from "@/lib/analysis/engine";
import { deleteActivity, upsertActivities } from "@/lib/ingest/activities";
import { judgeInsights } from "@/lib/llm/judge";
import { StravaClient } from "@/lib/strava/client";
import { eq } from "drizzle-orm";

/**
 * The async half of the webhook: everything that happens after we've already
 * told Strava 200 OK. Ingest → recompute → judge → log the decision.
 *
 * Design constraints this encodes:
 * - Idempotent: delivery is at-least-once, so a duplicate event re-upserts
 *   the same activity and re-judges — annoying, never corrupting.
 * - Never waits out a rate limit: the API client's waiting is opt-in and this
 *   caller doesn't opt in. A serverless function that sleeps is billed until
 *   the platform kills it.
 * - Failures land in webhook_events.error — after the 200, this table is the
 *   only evidence anything went wrong.
 */

export interface StravaWebhookEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  subscription_id?: number;
  event_time?: number;
  updates?: Record<string, unknown>;
}

export interface ProcessResult {
  status: "processed" | "ignored" | "failed";
  detail: string;
  notificationId?: number;
  decision?: string;
}

export async function processEvent(
  event: StravaWebhookEvent,
  trigger: "webhook" | "simulated" = "webhook",
): Promise<ProcessResult> {
  const [logged] = await db
    .insert(webhookEvents)
    .values({
      objectType: event.object_type,
      objectId: event.object_id,
      aspectType: event.aspect_type,
      raw: event as unknown as Record<string, unknown>,
    })
    .returning({ id: webhookEvents.id });

  const finish = async (r: ProcessResult) => {
    await db
      .update(webhookEvents)
      .set({
        status: r.status,
        error: r.status === "failed" ? r.detail : null,
        processedAt: new Date(),
      })
      .where(eq(webhookEvents.id, logged.id));
    return r;
  };

  try {
    // Athlete events are (de)authorizations — log and stop. If the athlete
    // revoked access, every later fetch will fail loudly on its own.
    if (event.object_type === "athlete") {
      return await finish({
        status: "ignored",
        detail: `athlete event: ${JSON.stringify(event.updates ?? {})}`,
      });
    }

    if (event.aspect_type === "delete") {
      await deleteActivity(event.object_id);
      return await finish({
        status: "processed",
        detail: "activity deleted locally",
      });
    }

    // create / update: fetch the full activity and upsert. The same upsert
    // the backfill uses — one write path, one idempotency story.
    const client = new StravaClient({ waitOnRateLimit: false });
    const activity = await client.getActivity(event.object_id);
    await upsertActivities([activity]);

    // A brand-new run should be judged; a title edit on last month's run
    // shouldn't wake the LLM. Updates re-ingest data but stay silent.
    if (event.aspect_type === "update") {
      return await finish({
        status: "processed",
        detail: "activity re-ingested; updates are not judged",
      });
    }

    const report = await computeInsights(event.object_id);
    const judgment = await judgeInsights(report, trigger);

    const decision = judgment.degraded
      ? "error"
      : judgment.notify
        ? "notify"
        : "skip";

    const [row] = await db
      .insert(notifications)
      .values({
        trigger,
        activityId: event.object_id,
        decision,
        severity: judgment.severity,
        subject: judgment.subject,
        message: judgment.message,
        rationale: judgment.rationale,
        findings: report as unknown as Record<string, unknown>,
        model: judgment.model,
        inputTokens: judgment.inputTokens,
        outputTokens: judgment.outputTokens,
        error: judgment.degraded ?? null,
      })
      .returning({ id: notifications.id });

    return await finish({
      status: "processed",
      detail: `judged: ${decision}`,
      notificationId: row.id,
      decision,
    });
  } catch (e) {
    return await finish({
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
