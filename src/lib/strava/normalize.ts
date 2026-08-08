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

export type UploadSource = "garmin" | "file_upload" | "other";

/**
 * Strava's `external_id` describes how an activity *reached Strava*, not what
 * recorded it. A watch that auto-syncs produces "garmin_ping_<garminActivityId>";
 * anything uploaded as a file produces a UUID-ish "<uuid>-activity.fit"
 * (sometimes "stripped_" prefixed).
 *
 * Those are different questions, and conflating them is wrong: a Samsung
 * Galaxy Watch4 recording arrives as a file upload, so "file_upload" would
 * wrongly imply a phone recorded it. `device_name` answers what recorded it.
 *
 * The Garmin branch is what makes dedup exact rather than heuristic: because
 * the watch pushes directly to Strava, one run yields one Strava activity
 * carrying its own Garmin id — there is no second copy to match on timestamp
 * and distance.
 */
export function parseProvenance(externalId: string | null | undefined): {
  uploadSource: UploadSource;
  garminActivityId: number | null;
} {
  if (!externalId) return { uploadSource: "other", garminActivityId: null };

  const garmin = externalId.match(/^garmin_(?:ping|push)_(\d+)$/);
  if (garmin) {
    return {
      uploadSource: "garmin",
      garminActivityId: Number(garmin[1]),
    };
  }
  if (/-activity\.fit$/.test(externalId)) {
    return { uploadSource: "file_upload", garminActivityId: null };
  }
  return { uploadSource: "other", garminActivityId: null };
}

export function normalizeActivity(a: SummaryActivity): NewActivity {
  const externalId = (a as { external_id?: string | null }).external_id ?? null;
  const { uploadSource, garminActivityId } = parseProvenance(externalId);
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

    externalId,
    deviceName: (a as { device_name?: string | null }).device_name ?? null,
    uploadSource,
    garminActivityId,

    raw: a as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
}

/** Sport types that count as running for the analysis engine. */
export const RUN_SPORT_TYPES = ["Run", "TrailRun", "VirtualRun"] as const;

export function isRun(sportType: string): boolean {
  return (RUN_SPORT_TYPES as readonly string[]).includes(sportType);
}
