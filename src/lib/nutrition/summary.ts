import { dailyIntake, type DayIntake } from "./meals";
import { latestWeight } from "./body";
import { athleteToday } from "@/lib/time";

/**
 * The one nutrition number this system reports, and the conditions under which
 * it refuses to.
 *
 * Protein relative to bodyweight is the athlete's single standing dietary
 * constraint, so it is the only intake figure with a stated reason to exist.
 * There is deliberately no calorie target anywhere in this file: the system
 * records what was eaten and never says what should be.
 *
 * The gate matters more than the average. Four logged days out of seven is not
 * "your protein was 1.4 g/kg" — it is your protein on the days you remembered
 * to log, which skews high, because people log the meal they planned and forget
 * the biscuit. Reporting that as a weekly figure would be the food-diary
 * version of reading an unworn watch as a rest day.
 */

/** METHOD: fewer logged days than this and the mean is a self-selected sample. */
export const MIN_LOGGED_DAYS = 4;
/** METHOD: bodyweight older than this no longer divides today's protein. */
export const MAX_WEIGHT_AGE_DAYS = 21;

export interface ProteinSummary {
  eligible: boolean;
  reason?: string;
  windowDays: number;
  loggedDays: number;
  /** Mean over *logged* days only — never over the calendar window. */
  meanProteinG?: number;
  meanKcal?: number;
  weightKg?: number;
  weightOn?: string;
  gPerKg?: number;
  /** Share of the window's calories from compositions nobody has checked. */
  estimatedShare?: number;
  days: DayIntake[];
}

/**
 * `to` is the athlete's calendar date, not the server's. Taking `new Date()`
 * and slicing the ISO string excluded a meal logged after midnight IST from
 * its own week — the window ended yesterday, and the panel reported "0 logged
 * days" over a database that had just been written to.
 */
export async function proteinSummary(
  windowDays = 7,
  to?: string,
): Promise<ProteinSummary> {
  const today = to ?? (await athleteToday());
  const fromDate = new Date(`${today}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1));
  const from = fromDate.toISOString().slice(0, 10);

  const days = await dailyIntake(from, today);
  const base = { windowDays, loggedDays: days.length, days };

  if (days.length < MIN_LOGGED_DAYS) {
    return {
      ...base,
      eligible: false,
      reason: `${MIN_LOGGED_DAYS} logged days needed in the last ${windowDays}; have ${days.length}`,
    };
  }

  const mean = (pick: (d: DayIntake) => number) =>
    days.reduce((a, d) => a + pick(d), 0) / days.length;

  const meanProteinG = Math.round(mean((d) => d.proteinG));
  const meanKcal = Math.round(mean((d) => d.kcal));
  const kcalTotal = days.reduce((a, d) => a + d.kcal, 0);
  const estimatedShare =
    kcalTotal === 0
      ? 0
      : days.reduce((a, d) => a + d.kcal * d.estimatedShare, 0) / kcalTotal;

  const weight = await latestWeight();
  if (!weight) {
    return {
      ...base,
      eligible: false,
      reason: "no weight logged, so protein cannot be expressed per kilogram",
      meanProteinG,
      meanKcal,
      estimatedShare,
    };
  }

  const ageDays = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${weight.date}T00:00:00Z`)) /
      86_400_000,
  );
  if (ageDays > MAX_WEIGHT_AGE_DAYS) {
    return {
      ...base,
      eligible: false,
      reason: `last weigh-in was ${ageDays} days ago; needs to be within ${MAX_WEIGHT_AGE_DAYS}`,
      meanProteinG,
      meanKcal,
      estimatedShare,
      weightKg: weight.weightKg,
      weightOn: weight.date,
    };
  }

  return {
    ...base,
    eligible: true,
    meanProteinG,
    meanKcal,
    estimatedShare,
    weightKg: weight.weightKg,
    weightOn: weight.date,
    gPerKg: Math.round((meanProteinG / weight.weightKg) * 100) / 100,
  };
}
