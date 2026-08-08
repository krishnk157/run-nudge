import { desc, eq, sql as raw } from "drizzle-orm";

import { db } from "@/db/client";
import { activities, syncState, type NewActivity } from "@/db/schema";
import { normalizeActivity } from "@/lib/strava/normalize";
import type { SummaryActivity } from "@/lib/strava/types";

/**
 * Upsert on Strava's activity id. Both the backfill and the webhook path go
 * through here, which is why it's idempotent: re-running a backfill or
 * receiving a duplicate webhook must not create a second row or lose edits
 * (a renamed or re-uploaded activity should overwrite).
 */
export async function upsertActivities(
  summaries: SummaryActivity[],
): Promise<number> {
  if (summaries.length === 0) return 0;

  const rows: NewActivity[] = summaries.map(normalizeActivity);

  await db
    .insert(activities)
    .values(rows)
    .onConflictDoUpdate({
      target: activities.id,
      set: {
        name: raw`excluded.name`,
        sportType: raw`excluded.sport_type`,
        startedAt: raw`excluded.started_at`,
        startedAtLocal: raw`excluded.started_at_local`,
        timezone: raw`excluded.timezone`,
        utcOffsetSeconds: raw`excluded.utc_offset_seconds`,
        distanceM: raw`excluded.distance_m`,
        movingTimeS: raw`excluded.moving_time_s`,
        elapsedTimeS: raw`excluded.elapsed_time_s`,
        totalElevationGainM: raw`excluded.total_elevation_gain_m`,
        averageSpeedMps: raw`excluded.average_speed_mps`,
        maxSpeedMps: raw`excluded.max_speed_mps`,
        hasHeartrate: raw`excluded.has_heartrate`,
        averageHeartrate: raw`excluded.average_heartrate`,
        maxHeartrate: raw`excluded.max_heartrate`,
        averageCadence: raw`excluded.average_cadence`,
        sufferScore: raw`excluded.suffer_score`,
        kilojoules: raw`excluded.kilojoules`,
        isTrainer: raw`excluded.is_trainer`,
        isManual: raw`excluded.is_manual`,
        isRace: raw`excluded.is_race`,
        gearId: raw`excluded.gear_id`,
        externalId: raw`excluded.external_id`,
        deviceName: raw`excluded.device_name`,
        uploadSource: raw`excluded.upload_source`,
        garminActivityId: raw`excluded.garmin_activity_id`,
        raw: raw`excluded.raw`,
        updatedAt: new Date(),
      },
    });

  return rows.length;
}

export async function deleteActivity(id: number) {
  await db.delete(activities).where(eq(activities.id, id));
}

/** Start time of the newest stored activity — the resume point for an incremental sync. */
export async function latestActivityStart(): Promise<Date | null> {
  const rows = await db
    .select({ startedAt: activities.startedAt })
    .from(activities)
    .orderBy(desc(activities.startedAt))
    .limit(1);
  return rows[0]?.startedAt ?? null;
}

export async function activityCount(): Promise<number> {
  const rows = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(activities);
  return rows[0]?.count ?? 0;
}

export async function getSyncState<T>(key: string): Promise<T | null> {
  const rows = await db
    .select()
    .from(syncState)
    .where(eq(syncState.key, key))
    .limit(1);
  return (rows[0]?.value as T) ?? null;
}

export async function setSyncState(key: string, value: unknown) {
  await db
    .insert(syncState)
    .values({ key, value: value as object, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { value: value as object, updatedAt: new Date() },
    });
}
