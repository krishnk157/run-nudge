/**
 * Full Strava history backfill.
 *
 * Run locally (`npm run backfill`) rather than as a serverless function: a
 * multi-year history is hundreds of API calls and will outlive any request
 * timeout. It is resumable — progress is checkpointed after every page, so a
 * rate limit or a crash costs one page, not the whole run.
 *
 *   npm run backfill              # resume (or start) the backfill
 *   npm run backfill -- --restart # ignore the checkpoint and walk from the beginning
 *   npm run backfill -- --since 2024-01-01
 */
import "dotenv/config";

import { sql } from "@/db/client";
import {
  activityCount,
  getSyncState,
  setSyncState,
  upsertActivities,
} from "@/lib/ingest/activities";
import { StravaClient, type RateLimitStatus } from "@/lib/strava/client";
import { isRun } from "@/lib/strava/normalize";
import { getConnectedAthlete } from "@/lib/strava/oauth";

const CURSOR_KEY = "strava.backfill";
const PER_PAGE = 100;

interface BackfillCursor {
  /** Unix seconds of the newest activity ingested so far. */
  after: number;
  pagesFetched: number;
  activitiesIngested: number;
  completedAt?: string;
}

function parseArgs(argv: string[]) {
  const restart = argv.includes("--restart");
  const sinceIdx = argv.indexOf("--since");
  let since: number | undefined;
  if (sinceIdx !== -1) {
    const value = argv[sinceIdx + 1];
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`--since expects a date, got "${value}"`);
    }
    since = Math.floor(date.getTime() / 1000);
  }
  return { restart, since };
}

function formatRateLimit(status: RateLimitStatus | null): string {
  if (!status) return "";
  return ` [quota ${status.shortTermUsage}/${status.shortTermLimit} 15min, ${status.dailyUsage}/${status.dailyLimit} daily]`;
}

async function main() {
  const { restart, since } = parseArgs(process.argv.slice(2));

  const athlete = await getConnectedAthlete();
  if (!athlete) {
    console.error(
      "No Strava connection stored. Start the dev server and visit\n" +
        "  http://localhost:3000/api/strava/authorize?token=$ADMIN_TOKEN",
    );
    process.exit(1);
  }
  console.log(
    `Athlete ${athlete.athleteId}${athlete.athleteFirstname ? ` (${athlete.athleteFirstname})` : ""}`,
  );

  const saved = restart ? null : await getSyncState<BackfillCursor>(CURSOR_KEY);
  const cursor: BackfillCursor = {
    after: since ?? saved?.after ?? 0,
    pagesFetched: saved?.pagesFetched ?? 0,
    activitiesIngested: saved?.activitiesIngested ?? 0,
  };

  if (saved && !restart && !since) {
    console.log(
      `Resuming from ${new Date(cursor.after * 1000).toISOString()} ` +
        `(${cursor.activitiesIngested} activities ingested so far)`,
    );
  } else {
    console.log(
      cursor.after === 0
        ? "Starting full backfill from the beginning of history"
        : `Starting backfill from ${new Date(cursor.after * 1000).toISOString()}`,
    );
  }

  const client = new StravaClient({
    athleteId: athlete.athleteId,
    waitOnRateLimit: true,
    onRateLimit: (status) => {
      if (status.shortTermUsage > status.shortTermLimit * 0.9) {
        console.warn(`  approaching rate limit${formatRateLimit(status)}`);
      }
    },
  });

  let runs = 0;
  // `after` makes Strava return activities in ascending start_date order, which
  // is what lets a single moving cursor represent "everything before this".
  for (let page = 1; ; page++) {
    const batch = await client.listActivities({
      page,
      perPage: PER_PAGE,
      after: cursor.after,
    });

    if (batch.length > 0) {
      const ingested = await upsertActivities(batch);
      runs += batch.filter((a) => isRun(a.sport_type ?? a.type ?? "")).length;

      const newest = batch.reduce(
        (max, a) => Math.max(max, Math.floor(new Date(a.start_date).getTime() / 1000)),
        cursor.after,
      );
      cursor.after = newest;
      cursor.pagesFetched += 1;
      cursor.activitiesIngested += ingested;
      await setSyncState(CURSOR_KEY, cursor);

      console.log(
        `page ${page}: +${ingested} activities → ${new Date(newest * 1000).toISOString().slice(0, 10)}` +
          `${formatRateLimit(client.rateLimit)}`,
      );
    }

    // A short page means we've reached the end of the athlete's history.
    if (batch.length < PER_PAGE) break;
  }

  cursor.completedAt = new Date().toISOString();
  await setSyncState(CURSOR_KEY, cursor);

  const total = await activityCount();
  console.log(
    `\nDone. ${cursor.activitiesIngested} activities ingested this run ` +
      `(${runs} runs), ${total} rows in the database.`,
  );
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("\nBackfill failed:", e instanceof Error ? e.message : e);
    console.error("Re-run `npm run backfill` to resume from the last checkpoint.");
    await sql.end();
    process.exit(1);
  });
