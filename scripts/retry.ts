/**
 * Re-run the pipeline for webhook events that failed.
 *
 * `npm run retry`            — show what failed and why
 * `npm run retry -- --run`   — reprocess them
 *
 * This exists because of a real outage rather than a hypothetical one. An
 * Anthropic key expired, two genuine workouts arrived while it was dead, and
 * both events were recorded as `failed` with the exact 401 that caused it —
 * the pipeline degraded exactly as designed. What did not exist was any way to
 * pick them back up afterwards. The evidence was perfect and the recovery was
 * manual.
 *
 * Replay is safe for the *database* because ingestion always was: the upsert is
 * keyed on Strava's activity id, so re-running an event overwrites the same row
 * rather than creating a duplicate.
 *
 * It is not automatically safe for the *athlete*, which the first run of this
 * script proved by sending two Telegram messages about workouts from June and
 * July. Three long-dead events from Day 4's testing were still sitting at
 * `failed`, the judge assessed them on their merits, and "first session in 28
 * days" is a perfectly good notification about a run seven weeks ago.
 *
 * Hence the window. A notification's value is time-bound in a way its
 * correctness is not, so replay defaults to the last two days and going further
 * back has to be asked for explicitly.
 */
import "dotenv/config";

import { sql } from "@/db/client";
import { processEvent, type StravaWebhookEvent } from "@/lib/pipeline/processEvent";

interface FailedRow {
  id: number;
  at: string;
  raw: StravaWebhookEvent;
  error: string | null;
}

const DEFAULT_WINDOW_DAYS = 2;

async function main() {
  const run = process.argv.includes("--run");
  const all = process.argv.includes("--all");
  const sinceArg = process.argv.find((a) => a.startsWith("--since="));
  const days = sinceArg ? Number(sinceArg.split("=")[1]) : DEFAULT_WINDOW_DAYS;

  const failed = await sql<FailedRow[]>`
    select id, to_char(received_at, 'YYYY-MM-DD HH24:MI') as at, raw, error
    from webhook_events
    where status = 'failed'
      ${all ? sql`` : sql`and received_at > now() - (${days} || ' days')::interval`}
    order by received_at`;

  const [older] = await sql<{ n: number }[]>`
    select count(*)::int as n from webhook_events
    where status = 'failed' and received_at <= now() - (${days} || ' days')::interval`;

  if (failed.length === 0) {
    console.log(
      all
        ? "nothing failed — no events to retry"
        : `no failures in the last ${days} days` +
            (older.n ? ` (${older.n} older, --all to include them)` : ""),
    );
    await sql.end();
    return;
  }

  if (!all && older.n > 0) {
    console.log(
      `note: ${older.n} older failure${older.n === 1 ? "" : "s"} excluded. ` +
        `Replaying those would judge them on their merits and may send a ` +
        `notification about a workout from weeks ago — pass --all only if you ` +
        `mean that.\n`,
    );
  }

  console.log(`${failed.length} failed event${failed.length === 1 ? "" : "s"}:\n`);
  for (const f of failed) {
    console.log(
      `  #${f.id}  ${f.at}  ${f.raw.aspect_type} ${f.raw.object_id}\n` +
        `      ${(f.error ?? "").replace(/\s+/g, " ").slice(0, 140)}`,
    );
  }

  if (!run) {
    console.log("\nre-run with --run to reprocess");
    await sql.end();
    return;
  }

  console.log("\nreprocessing:\n");
  for (const f of failed) {
    // Trigger is "replay", not "webhook": the notification this produces is
    // real, but it was not prompted by a live delivery, and the feed should
    // not claim otherwise.
    const result = await processEvent(f.raw, "replay" as "webhook");
    console.log(`  #${f.id} → ${result.status}: ${result.detail}`);
    if (result.status === "processed") {
      // Mark the original so it stops showing up as outstanding. The row stays
      // — it is the record that this failed once, which is worth keeping.
      await sql`
        update webhook_events
        set status = 'retried',
            error = ${`${f.error ?? ""} · retried successfully`}
        where id = ${f.id}`;
    }
  }
  await sql.end();
}

main();
