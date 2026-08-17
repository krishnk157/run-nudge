import {
  bigint,
  bigserial,
  boolean,
  date,
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

    // Provenance. Strava's external_id encodes how the activity reached
    // Strava: "garmin_ping_<garminActivityId>" for a watch auto-push, a
    // UUID-ish ".fit" name for a file upload. Because the watch pushes
    // straight to Strava, this is an exact link rather than the
    // timestamp+distance heuristic the plan anticipated — there is no
    // dual-logging to reconcile.
    externalId: text("external_id"),
    /**
     * The recording device, per Strava. This and `uploadSource` answer
     * different questions: a Samsung Galaxy Watch4 recording arrives as a file
     * upload, so the upload path alone would wrongly imply "phone".
     */
    deviceName: text("device_name"),
    /** How it reached Strava, from externalId: 'garmin' | 'file_upload' | 'other'. */
    uploadSource: text("upload_source"),
    /** Garmin's own activity id, parsed out of a garmin_ping external_id. */
    garminActivityId: bigint("garmin_activity_id", { mode: "number" }),

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
 * One row per calendar day of Garmin wellness data — the recovery context
 * Strava has no equivalent of (sleep, HRV, VO2max, training readiness).
 *
 * Keyed by date rather than by an activity: these are whole-day measurements,
 * and they exist for rest days too. That's the point — a rest day with poor
 * sleep and suppressed HRV is exactly the context that should temper what the
 * system says about the next hard run.
 *
 * Every column is nullable. Garmin returns nothing for days the watch wasn't
 * worn, and a day with only step data is normal, not an error.
 */
export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    /** Calendar date in the athlete's local timezone, as Garmin reports it. */
    date: date("date").primaryKey(),
    source: text("source").notNull().default("garmin"),

    // Sleep — durations in seconds to match the activity columns' SI convention.
    sleepSeconds: integer("sleep_seconds"),
    deepSleepSeconds: integer("deep_sleep_seconds"),
    lightSleepSeconds: integer("light_sleep_seconds"),
    remSleepSeconds: integer("rem_sleep_seconds"),
    awakeSeconds: integer("awake_seconds"),
    sleepScore: integer("sleep_score"),

    restingHr: integer("resting_hr"),

    // HRV. `hrvStatus` is Garmin's own classification (BALANCED / UNBALANCED /
    // LOW / POOR) — it already accounts for personal baseline, so it's more
    // useful than the raw ms value on its own.
    hrvLastNightAvgMs: integer("hrv_last_night_avg_ms"),
    hrvLastNightHighMs: integer("hrv_last_night_high_ms"),
    hrvStatus: text("hrv_status"),
    hrvBaselineLowUpper: integer("hrv_baseline_low_upper"),
    hrvBaselineBalancedLow: integer("hrv_baseline_balanced_low"),
    hrvBaselineBalancedUpper: integer("hrv_baseline_balanced_upper"),

    vo2maxRunning: doublePrecision("vo2max_running"),

    /** Garmin's own verdict: PRODUCTIVE_2, OVERREACHING, DETRAINING, … */
    trainingStatus: text("training_status"),
    trainingReadinessScore: integer("training_readiness_score"),
    trainingReadinessLevel: text("training_readiness_level"),
    recoveryTimeSeconds: integer("recovery_time_seconds"),

    // Garmin computes acute:chronic workload itself. Day 3 computes its own
    // from Strava data — keeping Garmin's lets us check ours against a
    // reference implementation instead of trusting it blind.
    acuteTrainingLoad: doublePrecision("acute_training_load"),
    chronicTrainingLoad: doublePrecision("chronic_training_load"),
    garminAcwr: doublePrecision("garmin_acwr"),
    garminAcwrStatus: text("garmin_acwr_status"),

    // Amounts gained/spent over the day, not high/low readings — Garmin's
    // fields are `charged` and `drained`, and naming them high/low would
    // invite exactly the wrong interpretation downstream.
    bodyBatteryCharged: integer("body_battery_charged"),
    bodyBatteryDrained: integer("body_battery_drained"),
    averageStress: integer("average_stress"),
    steps: integer("steps"),

    /**
     * Wear-time quality signals. This watch is worn for runs, not overnight,
     * so most days have no sleep or HRV at all. Recording that explicitly
     * keeps Day 3 from mistaking "not measured" for "measured and fine".
     */
    validSleep: boolean("valid_sleep"),
    /** Count of real stress samples; the rest of Garmin's array is -1 (not worn) / -2 (in activity). */
    stressSampleCount: integer("stress_sample_count"),

    /** Full per-endpoint payloads, keyed by endpoint name. Same reasoning as
     * activities.raw: a schema change should cost a migration, not a re-sync. */
    raw: jsonb("raw").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // No index on `date` — it is the primary key, which Postgres already backs
  // with a unique index. A second one would be pure write overhead.
);

/**
 * Every webhook delivery Strava sends us, verbatim, with its processing
 * outcome. Delivery is at-least-once, the receiver must answer within
 * seconds, and processing happens after the response — so when something
 * goes wrong the only evidence is what we wrote down here.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    objectType: text("object_type").notNull(),
    objectId: bigint("object_id", { mode: "number" }).notNull(),
    aspectType: text("aspect_type").notNull(),
    /** 'received' → 'processed' | 'failed' | 'ignored' */
    status: text("status").notNull().default("received"),
    error: text("error"),
    raw: jsonb("raw").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [index("webhook_events_received_idx").on(t.receivedAt)],
);

/**
 * Every notification decision, sent or withheld. The plan calls this the
 * debugging trail, and the withheld rows are the point: "quiet" is only
 * distinguishable from "broken" if silence is logged too.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** What ran the pipeline: 'webhook' | 'cron' | 'simulated' | 'replay' */
    trigger: text("trigger").notNull(),
    activityId: bigint("activity_id", { mode: "number" }),

    /** 'notify' | 'skip' | 'error' — the judgment, not the delivery. */
    decision: text("decision").notNull(),
    severity: text("severity"),
    subject: text("subject"),
    message: text("message"),
    /** The model's stated reason — for tuning the significance prompt later. */
    rationale: text("rationale"),

    /** Full findings JSON the judge saw — reproduces the decision exactly. */
    findings: jsonb("findings").notNull(),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    /** 'drafted' | 'sent' | 'send_failed'. Not terminal: failures are retried. */
    status: text("status").notNull().default("drafted"),
    error: text("error"),

    // Delivery (Day 5). Kept separate from the judgment above so a send
    // failure never looks like a judgment failure — and so the channel can
    // change without rewriting how decisions are recorded.
    channel: text("channel"),
    /** The channel's own id for the sent message (Telegram message_id). */
    externalId: text("external_id"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [index("notifications_created_idx").on(t.createdAt)],
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
export type DailyMetric = typeof dailyMetrics.$inferSelect;
