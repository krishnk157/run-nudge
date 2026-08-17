import { and, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { TelegramNotifier } from "./telegram";
import type { Notifier } from "./types";

/**
 * Delivery of drafted notifications.
 *
 * Day 4 ended at `decision='notify', status='drafted'`. This closes the loop:
 * find drafted rows, send them, record the outcome. Judgment and delivery stay
 * separate on purpose — a send failure must never make the system re-judge,
 * and a judgment must be recorded even when no channel is configured.
 */

export function defaultNotifier(): Notifier {
  return new TelegramNotifier();
}

export interface DeliverySummary {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
}

/**
 * Send every drafted notification, oldest first.
 *
 * Ordering matters: if two events queued while the channel was down, the
 * athlete should read them in the order they happened.
 */
export async function deliverPending(
  notifier: Notifier = defaultNotifier(),
  { limit = 20 }: { limit?: number } = {},
): Promise<DeliverySummary> {
  const summary: DeliverySummary = {
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  if (!notifier.isConfigured()) {
    summary.errors.push(`${notifier.channel} is not configured`);
    return summary;
  }

  const pending = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.decision, "notify"),
        eq(notifications.status, "drafted"),
      ),
    )
    .orderBy(notifications.createdAt)
    .limit(limit);

  for (const row of pending) {
    summary.attempted++;

    // A notify row without words is a defect upstream, not something to send.
    if (!row.subject || !row.message) {
      await db
        .update(notifications)
        .set({ status: "send_failed", error: "missing subject or message" })
        .where(eq(notifications.id, row.id));
      summary.failed++;
      summary.errors.push(`#${row.id}: missing subject or message`);
      continue;
    }

    const result = await notifier.send({
      subject: row.subject,
      body: row.message,
      severity: row.severity as "info" | "notable" | "warning" | null,
    });

    await db
      .update(notifications)
      .set({
        status: result.ok ? "sent" : "send_failed",
        error: result.ok ? null : result.error,
        channel: notifier.channel,
        externalId: result.externalId ?? null,
        sentAt: result.ok ? new Date() : null,
      })
      .where(eq(notifications.id, row.id));

    if (result.ok) summary.sent++;
    else {
      summary.failed++;
      summary.errors.push(`#${row.id}: ${result.error}`);
    }
  }

  return summary;
}

/**
 * Rows that failed to send are retried by a later run — `send_failed` is not
 * terminal. Called by the cron path so a transient Telegram outage doesn't
 * silently swallow a notification.
 */
export async function requeueFailed(maxAgeHours = 24): Promise<number> {
  // Bounded by age: a notification about last week's run is no longer worth
  // delivering, and retrying it forever would eventually send something
  // stale and confusing.
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000);
  const rows = await db
    .update(notifications)
    .set({ status: "drafted", error: null })
    .where(
      and(
        eq(notifications.decision, "notify"),
        eq(notifications.status, "send_failed"),
        gte(notifications.createdAt, cutoff),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
