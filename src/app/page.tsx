import { desc } from "drizzle-orm";

import { db } from "@/db/client";
import { activities } from "@/db/schema";
import { activityCount } from "@/lib/ingest/activities";
import { getConnectedAthlete } from "@/lib/strava/oauth";

export const dynamic = "force-dynamic";

async function loadStatus() {
  try {
    const [athlete, total, latest] = await Promise.all([
      getConnectedAthlete(),
      activityCount(),
      db
        .select({
          startedAtLocal: activities.startedAtLocal,
          distanceM: activities.distanceM,
        })
        .from(activities)
        .orderBy(desc(activities.startedAt))
        .limit(1),
    ]);
    return { athlete, total, latest: latest[0] ?? null, error: null };
  } catch (e) {
    return {
      athlete: null,
      total: 0,
      latest: null,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-black/10 py-3 dark:border-white/10">
      <span className="text-sm text-black/60 dark:text-white/60">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  );
}

export default async function Home() {
  const { athlete, total, latest, error } = await loadStatus();

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">RunNudge</h1>
      <p className="mt-2 text-sm text-black/60 dark:text-white/60">
        Ingestion status — Day 1
      </p>

      {error ? (
        <p className="mt-8 rounded-md bg-red-500/10 p-4 font-mono text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : (
        <div className="mt-8">
          <Row
            label="Strava"
            value={
              athlete
                ? `connected — athlete ${athlete.athleteId}`
                : "not connected"
            }
          />
          <Row label="Activities stored" value={String(total)} />
          <Row
            label="Most recent"
            value={
              latest
                ? `${latest.startedAtLocal.toISOString().slice(0, 10)} · ${(latest.distanceM / 1000).toFixed(1)} km`
                : "—"
            }
          />
        </div>
      )}

      {!athlete && !error && (
        <p className="mt-6 text-sm text-black/60 dark:text-white/60">
          Connect Strava at{" "}
          <code className="font-mono">
            /api/strava/authorize?token=$ADMIN_TOKEN
          </code>
          , then run <code className="font-mono">npm run backfill</code>.
        </p>
      )}
    </main>
  );
}
