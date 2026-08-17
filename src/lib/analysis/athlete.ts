import { sql } from "@/db/client";
import type { AthleteAnchors } from "./types";

/**
 * Fallbacks used only when the athlete's own history can't supply an anchor.
 * They exist so the engine degrades instead of crashing — every finding that
 * relies on an assumed anchor says so, because a personalized threshold
 * computed from a population guess is not personalized.
 */
const ASSUMED_HR_MAX = 190;
const ASSUMED_RESTING_HR = 60;

/** Below this many overnight samples, a resting-HR baseline isn't trustworthy. */
const MIN_RESTING_SAMPLES = 5;

/**
 * Derive heart-rate anchors from the athlete's own data.
 *
 * Max HR is taken from observed effort rather than the usual 220−age formula:
 * we don't hold the athlete's age, and an observed maximum is a stronger
 * anchor than an estimate even when it slightly understates the true ceiling.
 *
 * Resting HR is filtered to nights the watch was actually worn. This is the
 * single most important line in this file: readings from unworn nights are a
 * daytime minimum (58.8 vs 68.5 bpm here), so mixing regimes would make
 * resuming consistent wear look like a 10 bpm fitness gain.
 */
export async function getAnchors(): Promise<AthleteAnchors> {
  const [hr] = await sql<{ observed_max: number | null }[]>`
    select max(max_heartrate)::float as observed_max from activities`;

  const [worn] = await sql<{ n: number; avg_rhr: number | null }[]>`
    select count(*)::int as n, avg(resting_hr)::float as avg_rhr
    from daily_metrics
    where resting_hr is not null and valid_sleep is true`;

  const hrMax = hr?.observed_max ?? null;
  const hasWorn = (worn?.n ?? 0) >= MIN_RESTING_SAMPLES && worn?.avg_rhr != null;

  let restingHr = ASSUMED_RESTING_HR;
  let restingHrSource: AthleteAnchors["restingHrSource"] = "assumed";
  let restingHrSamples = 0;

  if (hasWorn) {
    restingHr = worn.avg_rhr as number;
    restingHrSource = "overnight-worn";
    restingHrSamples = worn.n;
  }

  return {
    hrMax: hrMax ?? ASSUMED_HR_MAX,
    hrMaxSource: hrMax ? "observed" : "assumed",
    restingHr: Math.round(restingHr * 10) / 10,
    restingHrSource,
    restingHrSamples,
  };
}
