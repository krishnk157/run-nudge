import type { NewActivity } from "@/db/schema";
import { RUN_WORKOUT_TYPE_RACE, type SummaryActivity } from "./types";

/**
 * Strava's `start_date_local` is an ISO string with a `Z` suffix that is a lie:
 * the digits are local wall-clock time, not UTC. Stripping the suffix and
 * storing it in a `timestamp without time zone` keeps "7am Tuesday" meaning 7am
 * Tuesday regardless of where the run happened or where the server runs.
 */
function parseLocalWallClock(startDateLocal: string): Date {
  const naive = startDateLocal.replace(/Z$/, "");
  return new Date(`${naive}Z`);
}

/**
 * Strava's timezone field looks like "(GMT+01:00) Europe/London" — we want the
 * IANA half.
 */
function parseTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const match = tz.match(/\)\s*(.+)$/);
  return (match?.[1] ?? tz).trim();
}

export function normalizeActivity(a: SummaryActivity): NewActivity {
  return {
    id: a.id,
    athleteId: a.athlete.id,
    source: "strava",

    name: a.name,
    // `sport_type` is the modern field; `type` is the deprecated fallback.
    sportType: a.sport_type ?? a.type ?? "Unknown",

    startedAt: new Date(a.start_date),
    startedAtLocal: parseLocalWallClock(a.start_date_local),
    timezone: parseTimezone(a.timezone),
    utcOffsetSeconds: a.utc_offset ?? null,

    distanceM: a.distance,
    movingTimeS: a.moving_time,
    elapsedTimeS: a.elapsed_time,
    totalElevationGainM: a.total_elevation_gain ?? null,

    averageSpeedMps: a.average_speed ?? null,
    maxSpeedMps: a.max_speed ?? null,

    hasHeartrate: a.has_heartrate ?? false,
    averageHeartrate: a.average_heartrate ?? null,
    maxHeartrate: a.max_heartrate ?? null,
    averageCadence: a.average_cadence ?? null,

    sufferScore: a.suffer_score ?? null,
    kilojoules: a.kilojoules ?? null,

    isTrainer: a.trainer ?? false,
    isManual: a.manual ?? false,
    isRace: a.workout_type === RUN_WORKOUT_TYPE_RACE,
    gearId: a.gear_id ?? null,

    raw: a as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
}

/** Sport types that count as running for the analysis engine. */
export const RUN_SPORT_TYPES = ["Run", "TrailRun", "VirtualRun"] as const;

export function isRun(sportType: string): boolean {
  return (RUN_SPORT_TYPES as readonly string[]).includes(sportType);
}
