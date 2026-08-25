import { sql } from "@/db/client";
import type { AthleteAnchors } from "./types";

export const RUN_TYPES = ["Run", "TrailRun", "VirtualRun"];

export interface EfficiencyPoint {
  id: number;
  date: string;
  distanceKm: number;
  speedMps: number;
  avgHr: number;
  /**
   * Metres per second per beat of heart-rate reserve used. Higher is better:
   * more speed for the same cardiac cost.
   */
  index: number;
}

/**
 * Aerobic efficiency — the quantity that actually tracks "improve VO2max and
 * pace". Raw pace confounds fitness with how hard the run felt; Garmin's
 * VO2max estimate updates only after qualifying runs (5 values in 3 months).
 *
 * Heart-rate *reserve* is used rather than raw bpm so the number is anchored to
 * this athlete's own range, and because a 10 bpm difference near resting means
 * something very different from 10 bpm near max.
 */
export async function efficiencySeries(
  anchors: AthleteAnchors,
): Promise<EfficiencyPoint[]> {
  const rows = await sql<
    {
      id: number;
      d: string;
      distance_m: number;
      moving_time_s: number;
      average_heartrate: number;
    }[]
  >`
    select id, to_char(started_at_local,'YYYY-MM-DD') as d,
           distance_m, moving_time_s, average_heartrate
    from activities
    where sport_type = any(${RUN_TYPES})
      and average_heartrate is not null
      and moving_time_s > 0 and distance_m > 0
    order by started_at_local`;

  return rows.map((r) => {
    const speedMps = r.distance_m / r.moving_time_s;
    const used = Math.max(1, r.average_heartrate - anchors.restingHr);
    return {
      id: Number(r.id),
      date: r.d,
      distanceKm: r.distance_m / 1000,
      speedMps,
      avgHr: r.average_heartrate,
      index: speedMps / used,
    };
  });
}

/** Least-squares slope of y over x, or null when there's nothing to fit. */
export function slope(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

export interface Consistency {
  daysSinceLast: number | null;
  lastDate: string | null;
  sessionsLast7: number;
  sessionsLast28: number;
  /** Sessions per week over the trailing 12 weeks, excluding the current one. */
  weeklyBaseline: number;
  longestGapDays: number;
}

/**
 * Days between an activity and the one before it.
 *
 * When the engine is triggered *by* an upload, "days since your last session"
 * is always zero — the session in hand is the last one. The quantity that
 * carries meaning is the gap it just ended, which is how "first run in 50 days"
 * becomes sayable at all.
 */
export async function gapBefore(activityId: number): Promise<number | null> {
  const [r] = await sql<{ gap: number | null }[]>`
    with cur as (
      select started_at_local from activities where id = ${activityId}
    )
    select (cur.started_at_local::date - prev.d)::int as gap
    from cur
    cross join lateral (
      select max(a.started_at_local::date) as d
      from activities a
      where a.started_at_local < cur.started_at_local
    ) prev`;
  return r?.gap ?? null;
}

export async function consistency(asOf: Date): Promise<Consistency> {
  const iso = asOf.toISOString().slice(0, 10);

  const [row] = await sql<
    {
      last_date: string | null;
      days_since: number | null;
      s7: number;
      s28: number;
      s84: number;
    }[]
  >`
    with a as (
      /*
       * DISTINCT date, not one row per activity.
       *
       * The athlete now finishes a lift with eleven minutes on the elliptical,
       * and Garmin records that as a second activity: 21:09 lifting, 22:10
       * elliptical. Counting rows made one evening in the gym read as two
       * sessions, so "4 sessions in the last 7 days" described 2 training days
       * and the weekly baseline was drifting toward double its true value
       * while nothing about the training had changed.
       *
       * A session is a time the athlete trained. The longest-gap query below
       * always counted it that way; this half of the same function did not,
       * which is how the inconsistency survived until a habit made it plain.
       *
       * The load model is unaffected and deliberately so: two activities on one
       * evening are two doses of work and their loads should sum. Frequency and
       * volume are different questions and are counted differently.
       */
      select distinct started_at_local::date as d from activities
      where started_at_local::date <= ${iso}::date
    )
    select to_char(max(d),'YYYY-MM-DD') as last_date,
           (${iso}::date - max(d))::int as days_since,
           count(*) filter (where d > ${iso}::date - 7)::int  as s7,
           count(*) filter (where d > ${iso}::date - 28)::int as s28,
           count(*) filter (where d > ${iso}::date - 84)::int as s84
    from a`;

  const [gap] = await sql<{ longest: number | null }[]>`
    with a as (
      select distinct started_at_local::date as d from activities
      where started_at_local::date <= ${iso}::date
    ), g as (
      select d, lag(d) over (order by d) as prev from a
    )
    select max((d - prev))::int as longest from g`;

  return {
    daysSinceLast: row?.days_since ?? null,
    lastDate: row?.last_date ?? null,
    sessionsLast7: row?.s7 ?? 0,
    sessionsLast28: row?.s28 ?? 0,
    weeklyBaseline: (row?.s84 ?? 0) / 12,
    longestGapDays: gap?.longest ?? 0,
  };
}

/* ------------------------------------------------------------------ */

export interface AerobicWeek {
  weekStart: string;
  minutes: number;
  sessions: number;
  /** Sessions in that week that carried heart rate at all. */
  withHr: number;
  /** Total sessions, including the ones with no HR to judge. */
  total: number;
  /** Which modalities contributed, for attribution. */
  sports: string[];
}

/**
 * Weekly minutes of genuinely aerobic work, across every modality.
 *
 * The athlete's stated goals are VO2max and pace, and until now nothing
 * measured the work that serves them. The efficiency rule only sees runs with
 * heart rate — five on file, none since July — so it is dormant and will stay
 * dormant through an entire block of aerobic training. Meanwhile eleven
 * minutes on an elliptical at 90% of max HR is exactly the stimulus the goal
 * asks for, and the system could not see it.
 *
 * Heart rate rather than sport type is the discriminator, deliberately. It is
 * the only quantity every modality shares (the same reason the load model uses
 * it), and it is the only way a hard badminton game counts and an easy jog
 * does not. Asking "was this a cardio session?" by looking at the label gets
 * both wrong.
 *
 * `withHr` and `total` are returned separately because a week where the watch
 * was left at home is not a week of no aerobic work. The caller decides
 * whether coverage is good enough to make a claim; this function only reports.
 */
export async function aerobicWeeks(
  asOf: Date,
  hrThreshold: number,
  weeks = 12,
): Promise<AerobicWeek[]> {
  const iso = asOf.toISOString().slice(0, 10);
  const rows = await sql<
    {
      week: string;
      minutes: number;
      sessions: number;
      with_hr: number;
      total: number;
      sports: string[];
    }[]
  >`
    select
      to_char(date_trunc('week', started_at_local), 'YYYY-MM-DD') as week,
      coalesce(round(sum(moving_time_s) filter (
        where has_heartrate and average_heartrate >= ${hrThreshold}
      ) / 60.0), 0)::int as minutes,
      count(*) filter (
        where has_heartrate and average_heartrate >= ${hrThreshold}
      )::int as sessions,
      count(*) filter (where has_heartrate and average_heartrate is not null)::int as with_hr,
      count(*)::int as total,
      coalesce(array_agg(distinct sport_type) filter (
        where has_heartrate and average_heartrate >= ${hrThreshold}
      ), '{}') as sports
    from activities
    where started_at_local::date <= ${iso}::date
      and started_at_local::date > (${iso}::date - ${weeks * 7}::int)
    group by 1
    order by 1`;

  return rows.map((r) => ({
    weekStart: r.week,
    minutes: r.minutes,
    sessions: r.sessions,
    withHr: r.with_hr,
    total: r.total,
    sports: r.sports ?? [],
  }));
}
