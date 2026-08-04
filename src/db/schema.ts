import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Strava OAuth credentials. Single-user system, but keyed by athlete so the
 * shape doesn't have to change if that ever stops being true.
 */
export const stravaTokens = pgTable("strava_tokens", {
  athleteId: bigint("athlete_id", { mode: "number" }).primaryKey(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  /** Absolute expiry of accessToken, from Strava's `expires_at` (unix seconds). */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  scope: text("scope"),
  athleteFirstname: text("athlete_firstname"),
  athleteLastname: text("athlete_lastname"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * One row per Strava activity. Normalized columns carry everything the analysis
 * engine needs; `raw` keeps the untouched payload so a schema change never
 * costs a re-backfill.
 *
 * Units are SI and named as such — a bare `distance` column is how you end up
 * dividing miles by seconds three files later.
 */
export const activities = pgTable(
  "activities",
  {
    /** Strava's activity id — natural primary key, makes webhook upserts trivial. */
    id: bigint("id", { mode: "number" }).primaryKey(),
    athleteId: bigint("athlete_id", { mode: "number" }).notNull(),
    source: text("source").notNull().default("strava"),

    name: text("name").notNull(),
    sportType: text("sport_type").notNull(),

    /** Instant the activity started, in UTC. */
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Same instant expressed in the athlete's local wall clock — what "a Tuesday morning run" means. */
    startedAtLocal: timestamp("started_at_local", {
      withTimezone: false,
    }).notNull(),
    timezone: text("timezone"),
    utcOffsetSeconds: integer("utc_offset_seconds"),

    distanceM: doublePrecision("distance_m").notNull(),
    movingTimeS: integer("moving_time_s").notNull(),
    elapsedTimeS: integer("elapsed_time_s").notNull(),
    totalElevationGainM: doublePrecision("total_elevation_gain_m"),

    averageSpeedMps: doublePrecision("average_speed_mps"),
    maxSpeedMps: doublePrecision("max_speed_mps"),

    hasHeartrate: boolean("has_heartrate").notNull().default(false),
    averageHeartrate: doublePrecision("average_heartrate"),
    maxHeartrate: doublePrecision("max_heartrate"),
    averageCadence: doublePrecision("average_cadence"),

    /** Strava's own effort scores — useful as a sanity check against our computed load. */
    sufferScore: integer("suffer_score"),
    kilojoules: doublePrecision("kilojoules"),

    isTrainer: boolean("is_trainer").notNull().default(false),
    isManual: boolean("is_manual").notNull().default(false),
    isRace: boolean("is_race").notNull().default(false),
    gearId: text("gear_id"),

    raw: jsonb("raw").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Every trend query is "this athlete's activities over a window, newest first".
    index("activities_athlete_started_idx").on(t.athleteId, t.startedAt),
    index("activities_sport_type_idx").on(t.sportType),
  ],
);

/**
 * Small key/value log of sync progress, so a rate-limited or crashed backfill
 * resumes instead of restarting.
 */
export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Activity = typeof activities.$inferSelect;
export type NewActivity = typeof activities.$inferInsert;
export type StravaToken = typeof stravaTokens.$inferSelect;
