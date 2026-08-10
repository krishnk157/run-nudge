import { sql } from "@/db/client";
import type { AthleteAnchors } from "./types";

/**
 * Cross-modal training load.
 *
 * Mileage is not a load measure here: this athlete does 4–5 gym sessions a week
 * and one weekend 5k, so a distance-based model would score most of the
 * training as zero. Heart rate is the only quantity every modality shares.
 */

export type LoadMethod = "trimp" | "calibrated-duration";

export interface ActivityLoad {
  id: number;
  date: string;
  sportType: string;
  durationMin: number;
  load: number;
  method: LoadMethod;
}

/**
 * Banister TRIMP: minutes × HR-reserve fraction × an exponential intensity
 * weight, so a hard 30 minutes outweighs an easy 60 rather than merely
 * matching it.
 *
 * The 0.64 / 1.92 coefficients are the male-referenced form. We don't hold the
 * athlete's sex, and the choice does shift how sharply hard work is weighted
 * relative to easy — so absolute values here aren't comparable to anyone
 * else's. Ratios and trends for one athlete against themselves are what this
 * is used for, and those are what the rules consume.
 */
export function trimp(
  durationS: number,
  avgHr: number,
  anchors: AthleteAnchors,
): number {
  const reserve = anchors.hrMax - anchors.restingHr;
  if (reserve <= 0) return 0;
  const fraction = Math.min(
    1,
    Math.max(0, (avgHr - anchors.restingHr) / reserve),
  );
  const minutes = durationS / 60;
  return minutes * fraction * 0.64 * Math.exp(1.92 * fraction);
}

/**
 * Per-sport load-per-minute, learned from this athlete's own HR-bearing
 * sessions, used to estimate load for sessions that have no heart rate at all.
 *
 * Strava's `suffer_score` would be the obvious fallback, but it is present
 * *only* when heart rate is (18 of 28 activities, exactly the same 18) — so it
 * adds no coverage. Calibrating against the athlete's own measured sessions is
 * the next best thing and stays personal rather than importing a MET table.
 */
export type LoadCalibration = Map<string, number>;

export async function calibrate(anchors: AthleteAnchors): Promise<LoadCalibration> {
  const rows = await sql<
    { sport_type: string; moving_time_s: number; average_heartrate: number }[]
  >`
    select sport_type, moving_time_s, average_heartrate
    from activities
    where average_heartrate is not null and moving_time_s > 0`;

  const bySport = new Map<string, { load: number; min: number }>();
  let allLoad = 0;
  let allMin = 0;

  for (const r of rows) {
    const minutes = r.moving_time_s / 60;
    const load = trimp(r.moving_time_s, r.average_heartrate, anchors);
    const acc = bySport.get(r.sport_type) ?? { load: 0, min: 0 };
    acc.load += load;
    acc.min += minutes;
    bySport.set(r.sport_type, acc);
    allLoad += load;
    allMin += minutes;
  }

  const cal: LoadCalibration = new Map();
  for (const [sport, acc] of bySport) {
    if (acc.min > 0) cal.set(sport, acc.load / acc.min);
  }
  // "*" is the fallback for a sport type we've never seen with a heart rate.
  if (allMin > 0) cal.set("*", allLoad / allMin);
  return cal;
}

/**
 * Every activity with a load and — crucially — the method used to get it.
 * Measured and estimated loads are different regimes; carrying the method lets
 * downstream rules refuse to compare across them rather than quietly doing so.
 */
export async function activityLoads(
  anchors: AthleteAnchors,
  cal: LoadCalibration,
): Promise<ActivityLoad[]> {
  const rows = await sql<
    {
      id: number;
      d: string;
      sport_type: string;
      moving_time_s: number;
      average_heartrate: number | null;
    }[]
  >`
    select id, to_char(started_at_local, 'YYYY-MM-DD') as d,
           sport_type, moving_time_s, average_heartrate
    from activities
    where moving_time_s > 0
    order by started_at_local`;

  return rows.map((r) => {
    const durationMin = r.moving_time_s / 60;
    if (r.average_heartrate != null) {
      return {
        id: Number(r.id),
        date: r.d,
        sportType: r.sport_type,
        durationMin,
        load: trimp(r.moving_time_s, r.average_heartrate, anchors),
        method: "trimp" as const,
      };
    }
    const rate = cal.get(r.sport_type) ?? cal.get("*") ?? 0;
    return {
      id: Number(r.id),
      date: r.d,
      sportType: r.sport_type,
      durationMin,
      load: durationMin * rate,
      method: "calibrated-duration" as const,
    };
  });
}

export interface WindowLoad {
  /** Rolling 7-day total — "acute" in the workload literature. */
  acute: number;
  /** 28-day total scaled to a 7-day equivalent, so the ratio is dimensionless. */
  chronic: number;
  ratio: number | null;
  sessionsAcute: number;
  sessionsChronic: number;
  /**
   * How many of the chronic window's four weeks contain any training.
   *
   * A session *count* is not enough to say the baseline is populated: four
   * sessions crammed into the last five days produce a "chronic" load that is
   * really a second acute load, and a ratio near 1 or 4 that means nothing.
   * Spread is what distinguishes an established baseline from a ramp-up.
   */
  weeksCovered: number;
  /** True when any contributing load was estimated rather than measured. */
  hasEstimated: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Exponentially weighted acute and chronic load.
 *
 * Preferred over flat rolling windows (Williams et al., 2017) because a flat
 * 28-day window treats a session 27 days ago as fully current and one 29 days
 * ago as irrelevant, and because it responds too fast when training resumes
 * after a break.
 *
 * Validating the rolling version against Garmin's own ratio made that concrete:
 * shape matched closely (r = 0.96) but our values ran systematically high
 * through the June build-up — 1.68 against Garmin's 0.60 — because our flat
 * chronic window had only just begun including the layoff. Decay fixes the
 * cause rather than tuning the threshold around it.
 */
export interface EwmaLoad {
  acute: number;
  chronic: number;
  ratio: number | null;
}

const lambda = (days: number) => 2 / (days + 1);

export function ewmaLoad(
  loads: ActivityLoad[],
  asOf: Date,
  { acuteDays = 7, chronicDays = 28 } = {},
): EwmaLoad {
  const end = new Date(asOf.toISOString().slice(0, 10) + "T00:00:00Z").getTime();

  // Seed from the athlete's whole history so the averages are warmed up
  // rather than starting at zero on the day we happen to ask.
  const byDay = new Map<string, number>();
  let firstMs = Infinity;
  for (const l of loads) {
    const t = new Date(`${l.date}T00:00:00Z`).getTime();
    if (t > end) continue;
    firstMs = Math.min(firstMs, t);
    byDay.set(l.date, (byDay.get(l.date) ?? 0) + l.load);
  }
  if (!Number.isFinite(firstMs)) return { acute: 0, chronic: 0, ratio: null };

  const la = lambda(acuteDays);
  const lc = lambda(chronicDays);
  let acute = 0;
  let chronic = 0;

  // Every calendar day contributes, including rest days — a zero-load day is
  // information, and skipping it is what makes a layoff invisible.
  for (let t = firstMs; t <= end; t += DAY_MS) {
    const key = new Date(t).toISOString().slice(0, 10);
    const load = byDay.get(key) ?? 0;
    acute = load * la + acute * (1 - la);
    chronic = load * lc + chronic * (1 - lc);
  }

  return { acute, chronic, ratio: chronic > 0 ? acute / chronic : null };
}

export function windowLoad(
  loads: ActivityLoad[],
  asOf: Date,
): WindowLoad {
  const end = asOf.getTime();
  const inWindow = (l: ActivityLoad, days: number) => {
    const t = new Date(`${l.date}T00:00:00Z`).getTime();
    return t <= end && t > end - days * DAY_MS;
  };

  const acuteRows = loads.filter((l) => inWindow(l, 7));
  const chronicRows = loads.filter((l) => inWindow(l, 28));

  const acute = acuteRows.reduce((s, l) => s + l.load, 0);
  const chronic = chronicRows.reduce((s, l) => s + l.load, 0) / 4;

  const weeks = new Set<number>();
  for (const l of chronicRows) {
    const t = new Date(`${l.date}T00:00:00Z`).getTime();
    weeks.add(Math.floor((end - t) / (7 * DAY_MS)));
  }

  return {
    acute,
    chronic,
    ratio: chronic > 0 ? acute / chronic : null,
    sessionsAcute: acuteRows.length,
    sessionsChronic: chronicRows.length,
    weeksCovered: weeks.size,
    hasEstimated: chronicRows.some((l) => l.method === "calibrated-duration"),
  };
}
