import { sql } from "@/db/client";
import { defaultNotifier } from "./deliver";

/**
 * Operational alerts — the system telling you it is broken.
 *
 * Written after an expired API key took the judge down for a day. Two real
 * workouts arrived, both events recorded the exact 401 that caused it, and
 * nothing said a word. The dashboard showed the activities, because ingestion
 * had worked, and had no judgment to show. For a system whose entire job is
 * deciding when to speak, silence is the one failure mode that cannot be
 * distinguished from working correctly.
 *
 * Telegram is deliberately the channel: it shares no dependency with the model
 * API, so it survives exactly the outage that produced this file.
 *
 * Two rules keep this from becoming the thing you learn to ignore:
 *
 *   1. It is throttled by *cause*, not by time alone. Five activities failing
 *      on one dead key is one problem and one message. A different error is a
 *      different problem and gets through immediately, even inside the window.
 *   2. It never fails the pipeline. An alert that cannot be sent is logged and
 *      dropped — the activity's own error is already recorded, and turning a
 *      notification problem into a processing failure would lose both.
 */

const THROTTLE_HOURS = 6;
const STATE_KEY = "alert:last-failure";

/**
 * A stable identity for "the same thing going wrong".
 *
 * Strips ids, timestamps and anything else that varies between two instances
 * of one fault, so a dead key reads as one cause however many activities hit
 * it. Deliberately crude: over-grouping means one message instead of five,
 * while under-grouping means five messages and a muted chat.
 */
export function causeOf(error: string): string {
  return error
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, "")
    .replace(/\b\d{5,}\b/g, "")
    .replace(/"request_id":\s*"[^"]*"/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

interface AlertState {
  cause: string;
  at: string;
  count: number;
}

export async function alertPipelineFailure(args: {
  objectId: number;
  aspectType: string;
  error: string;
}): Promise<"sent" | "throttled" | "unconfigured" | "failed"> {
  try {
    const cause = causeOf(args.error);

    const [row] = await sql<{ value: AlertState }[]>`
      select value from sync_state where key = ${STATE_KEY}`;
    const last = row?.value;

    const withinWindow =
      last &&
      Date.now() - Date.parse(last.at) < THROTTLE_HOURS * 3_600_000 &&
      last.cause === cause;

    if (withinWindow) {
      // Still count it, so the next message can say how many were affected
      // rather than describing one activity as though it were the whole story.
      await sql`
        update sync_state
        set value = ${sql.json({ ...last, count: last.count + 1 })}, updated_at = now()
        where key = ${STATE_KEY}`;
      return "throttled";
    }

    const notifier = defaultNotifier();
    if (!notifier.isConfigured()) return "unconfigured";

    const result = await notifier.send({
      severity: "warning",
      subject: "Pipeline failure",
      body:
        `An activity was ingested but never judged.\n\n` +
        `${args.aspectType} ${args.objectId}\n` +
        `${args.error.slice(0, 300)}\n\n` +
        `Nothing is lost — the event is recorded. Fix the cause, then run ` +
        `\`npm run retry\`. Further failures from the same cause are ` +
        `suppressed for ${THROTTLE_HOURS} hours.`,
    });

    await sql`
      insert into sync_state (key, value)
      values (${STATE_KEY}, ${sql.json({ cause, at: new Date().toISOString(), count: 1 })})
      on conflict (key) do update
        set value = excluded.value, updated_at = now()`;

    return result.ok ? "sent" : "failed";
  } catch {
    // Never let the alert become the failure.
    return "failed";
  }
}

/** Clear the throttle, so a resolved incident does not suppress the next one. */
export async function clearAlertThrottle(): Promise<void> {
  await sql`delete from sync_state where key = ${STATE_KEY}`;
}
