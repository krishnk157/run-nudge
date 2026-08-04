import { z } from "zod";

/**
 * Strava's token endpoint response. Note `refresh_token` is returned on refresh
 * too and *can* rotate — always persist what comes back, never reuse the old one.
 */
export const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(), // unix seconds
  expires_in: z.number(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  athlete: z
    .object({
      id: z.number(),
      firstname: z.string().nullish(),
      lastname: z.string().nullish(),
    })
    .optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * The subset of Strava's SummaryActivity we normalize into columns. Everything
 * else survives in `activities.raw`, so this stays permissive: unknown keys pass
 * through and anything Strava omits for a given activity stays nullish.
 */
export const summaryActivitySchema = z.object({
  id: z.number(),
  athlete: z.object({ id: z.number() }),
  name: z.string(),
  sport_type: z.string().nullish(),
  type: z.string().nullish(),
  start_date: z.string(),
  start_date_local: z.string(),
  timezone: z.string().nullish(),
  utc_offset: z.number().nullish(),
  distance: z.number(),
  moving_time: z.number(),
  elapsed_time: z.number(),
  total_elevation_gain: z.number().nullish(),
  average_speed: z.number().nullish(),
  max_speed: z.number().nullish(),
  has_heartrate: z.boolean().nullish(),
  average_heartrate: z.number().nullish(),
  max_heartrate: z.number().nullish(),
  average_cadence: z.number().nullish(),
  suffer_score: z.number().nullish(),
  kilojoules: z.number().nullish(),
  trainer: z.boolean().nullish(),
  manual: z.boolean().nullish(),
  workout_type: z.number().nullish(),
  gear_id: z.string().nullish(),
});

export type SummaryActivity = z.infer<typeof summaryActivitySchema>;

/** Strava's workout_type for runs: 0 default, 1 race, 2 long run, 3 workout. */
export const RUN_WORKOUT_TYPE_RACE = 1;
