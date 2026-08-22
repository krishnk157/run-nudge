import {
  currentPhaseTrend,
  latestWeight,
  phaseSpans,
  weightSeries,
  type PhaseSpan,
  type PhaseTrend,
  type WeightPoint,
} from "@/lib/nutrition/body";
import { recentMeals, type SavedMeal } from "@/lib/nutrition/meals";
import { proteinSummary, type ProteinSummary } from "@/lib/nutrition/summary";
import { athleteToday } from "@/lib/time";
import { sql } from "@/db/client";
import { getAnchors } from "@/lib/analysis/athlete";
import { computeInsights } from "@/lib/analysis/engine";
import { activityLoads, calibrate } from "@/lib/analysis/load";
import type { Finding } from "@/lib/analysis/types";

/**
 * Everything the dashboard renders, in one pass.
 *
 * Two properties the mockup established and this must preserve:
 *  - a stale number is worse than no number, so freshness is surfaced, not
 *    assumed (Day 5's incident);
 *  - a zero week is drawn as a zero, never smoothed over — charts here must
 *    not assert training that didn't happen.
 */

export interface WeeklyPoint {
  weekStart: string;
  load: number;
  gymSessions: number;
  runSessions: number;
  hours: number;
}

/** One run, for the pace series. */
export interface PacePoint {
  date: string;
  /** Seconds per kilometre — lower is faster, so the axis is inverted. */
  secPerKm: number;
  km: number;
}

/** One day of training, for the calendar. */
export interface DayLoad {
  date: string;
  load: number;
  sessions: number;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface EfficiencyPoint {
  date: string;
  index: number;
  km: number;
  avgHr: number;
}

export interface FeedEntry {
  id: number;
  createdAt: string;
  trigger: string;
  decision: string;
  severity: string | null;
  subject: string | null;
  message: string | null;
  rationale: string | null;
  status: string;
  activityDate: string | null;
  chips: { label: string; tone: "ok" | "warn" | "crit" | "skip" | "plain" }[];
}

export interface DashboardData {
  /** The athlete's calendar date, so charts never read the browser's clock. */
  today: string;
  freshness: { lastSyncedAt: string | null; daysSinceSync: number | null };
  state: {
    weekLoad: number;
    weekSessions: number;
    daysSinceLast: number | null;
    lastActivityDate: string | null;
    acwr: number | null;
    acwrAsOf: string | null;
    acwrStale: boolean;
    vo2max: number | null;
    vo2maxChange: number | null;
    vo2maxSince: string | null;
  };
  findings: Finding[];
  weekly: WeeklyPoint[];
  efficiency: EfficiencyPoint[];
  pace: PacePoint[];
  vo2max: SeriesPoint[];
  /** Per-day training load for the last 12 weeks — the calendar's source. */
  calendar: DayLoad[];
  feed: FeedEntry[];
  totals: { activities: number; notifications: number; sent: number };
  /**
   * Day 7. Deliberately a separate branch of the payload rather than merged
   * into `state`: training data arrives by itself from Strava, nutrition data
   * only exists if the athlete typed it, and the dashboard has to be able to
   * say which of the two is missing.
   */
  nutrition: {
    protein: ProteinSummary;
    weight: WeightPoint[];
    latestWeight: WeightPoint | null;
    phases: PhaseSpan[];
    phaseTrend: PhaseTrend;
    recentMeals: SavedMeal[];
  };
}

/** Chips summarising a notification's findings, for the feed. */
function chipsFor(findings: unknown): FeedEntry["chips"] {
  const out: FeedEntry["chips"] = [];
  const report = findings as { findings?: Finding[] } | undefined;
  const list = Array.isArray(report?.findings) ? report.findings : [];

  for (const f of list) {
    if (f.status === "fired") {
      const d = f.data as Record<string, unknown>;
      if (f.rule === "acute_chronic_ratio" && typeof d.ratio === "number") {
        out.push({
          label: `acwr ${d.ratio}`,
          tone: d.ratio >= 1.8 ? "crit" : d.ratio >= 1.5 ? "warn" : "ok",
        });
      } else if (f.rule === "consistency" && d.gapBeforeDays != null) {
        out.push({ label: `gap ${d.gapBeforeDays}d`, tone: "warn" });
      } else {
        out.push({ label: f.rule.replace(/_/g, " "), tone: "plain" });
      }
    }
  }
  const skipped = list.filter((f) => f.status === "ineligible").length;
  if (skipped) out.push({ label: `${skipped} rules dormant`, tone: "skip" });
  return out;
}

export async function getDashboardData(): Promise<DashboardData> {
  const today = await athleteToday();
  const [protein, weight, phases, phaseTrend, meals, lastWeight] =
    await Promise.all([
      proteinSummary(7),
      weightSeries(),
      phaseSpans(),
      currentPhaseTrend(),
      recentMeals(6),
      latestWeight(),
    ]);

  const [fresh] = await sql<
    { last_sync: string | null; days: number | null }[]
  >`
    select to_char(max(ingested_at),'YYYY-MM-DD HH24:MI') as last_sync,
           extract(day from now() - max(ingested_at))::int as days
    from activities`;

  const [state] = await sql<
    {
      week_sessions: number;
      week_hours: number;
      last_date: string | null;
      days_since: number | null;
    }[]
  >`
    select
      count(*) filter (where started_at_local >= current_date - 7)::int as week_sessions,
      coalesce(round((sum(moving_time_s) filter (where started_at_local >= current_date - 7)/3600.0)::numeric,1),0)::float as week_hours,
      to_char(max(started_at_local),'YYYY-MM-DD') as last_date,
      (current_date - max(started_at_local)::date)::int as days_since
    from activities`;

  // Findings drive the coverage panel and the "state of training" strip. This
  // is a scheduled-style evaluation (no activity), which is what a dashboard
  // view is: "how do things stand right now", not "what about that session".
  const report = await computeInsights(null);

  const acwrFinding = report.findings.find(
    (f) => f.rule === "acute_chronic_ratio",
  );
  const acwrData = acwrFinding?.data as Record<string, unknown> | undefined;

  // Last computed ACWR from the notification log, so the strip can show a
  // value *and* admit it's from an earlier date — Day 5's staleness lesson
  // applied to a number rather than to a row count.
  const lastAcwr = await sql<{ ratio: number; d: string }[]>`
    select (findings->'findings') as f, to_char(created_at,'YYYY-MM-DD') as d,
           coalesce((
             select (x->'data'->>'ratio')::float
             from jsonb_array_elements(findings->'findings') x
             where x->>'rule' = 'acute_chronic_ratio' and x->>'status' <> 'ineligible'
           ), null) as ratio
    from notifications
    where findings ? 'findings'
    order by created_at desc
    limit 50`.then((rows) =>
    (rows as unknown as { ratio: number | null; d: string }[]).filter(
      (r) => r.ratio != null,
    ),
  );

  const vo2 = await sql<{ d: string; v: number }[]>`
    select to_char(date,'YYYY-MM-DD') as d, vo2max_running as v
    from daily_metrics where vo2max_running is not null order by date`;

  // Weekly load comes from the analysis engine's own model, not from a
  // separate SQL expression. The first version summed Strava's suffer_score
  // here, which meant the dashboard could show a "load" the engine had never
  // computed and would disagree with every notification. One system, one
  // definition of load.
  const anchors = await getAnchors();
  const loads = await activityLoads(anchors, await calibrate(anchors));
  const loadByWeek = new Map<string, number>();
  for (const l of loads) {
    const d = new Date(`${l.date}T00:00:00Z`);
    // ISO weeks start Monday, matching date_trunc('week', ...) below.
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    loadByWeek.set(key, (loadByWeek.get(key) ?? 0) + l.load);
  }

  /*
   * The calendar reads the engine's per-activity loads rather than a second
   * SQL sum, for the same reason the weekly bars do: one definition of load,
   * or the dashboard eventually contradicts the notifications.
   */
  const calByDay = new Map<string, { load: number; sessions: number }>();
  for (const l of loads) {
    const cur = calByDay.get(l.date) ?? { load: 0, sessions: 0 };
    calByDay.set(l.date, { load: cur.load + l.load, sessions: cur.sessions + 1 });
  }

  const weekly = await sql<
    { week: string; gym: number; run: number; hours: number }[]
  >`
    select to_char(date_trunc('week', started_at_local),'YYYY-MM-DD') as week,
           count(*) filter (where sport_type = 'WeightTraining')::int as gym,
           count(*) filter (where sport_type in ('Run','TrailRun','VirtualRun'))::int as run,
           round((sum(moving_time_s)/3600.0)::numeric,1)::float as hours
    from activities
    where started_at_local >= current_date - interval '16 weeks'
    group by 1 order by 1`;

  const pace = await sql<{ d: string; sec: number; km: number }[]>`
    select to_char(started_at_local,'YYYY-MM-DD') as d,
           round((moving_time_s / (distance_m/1000.0))::numeric, 0)::float as sec,
           round((distance_m/1000.0)::numeric, 2)::float as km
    from activities
    where sport_type in ('Run','TrailRun','VirtualRun')
      and distance_m >= 1000 and moving_time_s > 0
    order by started_at_local`;

  const eff = await sql<
    { d: string; km: number; hr: number; idx: number }[]
  >`
    select to_char(started_at_local,'YYYY-MM-DD') as d,
           round((distance_m/1000)::numeric,2)::float as km,
           average_heartrate::float as hr,
           round(((distance_m/moving_time_s) / nullif(average_heartrate - 58.8,0))::numeric,5)::float as idx
    from activities
    where sport_type in ('Run','TrailRun','VirtualRun')
      and average_heartrate is not null and moving_time_s > 0
    order by started_at_local`;

  const feedRows = await sql<
    {
      id: number;
      created_at: string;
      trigger: string;
      decision: string;
      severity: string | null;
      subject: string | null;
      message: string | null;
      rationale: string | null;
      status: string;
      activity_date: string | null;
      findings: unknown;
    }[]
  >`
    select n.id, to_char(n.created_at,'YYYY-MM-DD HH24:MI') as created_at,
           n.trigger, n.decision, n.severity, n.subject, n.message, n.rationale,
           n.status, to_char(a.started_at_local,'YYYY-MM-DD') as activity_date,
           n.findings
    from notifications n
    left join activities a on a.id = n.activity_id
    order by n.created_at desc limit 12`;

  const [totals] = await sql<
    { activities: number; notifications: number; sent: number }[]
  >`
    select (select count(*)::int from activities) as activities,
           (select count(*)::int from notifications) as notifications,
           (select count(*)::int from notifications where status='sent') as sent`;

  return {
    freshness: {
      lastSyncedAt: fresh?.last_sync ?? null,
      daysSinceSync: fresh?.days ?? null,
    },
    state: {
      weekLoad: Math.round(loadByWeek.get(weekly.at(-1)?.week ?? "") ?? 0),
      weekSessions: state?.week_sessions ?? 0,
      daysSinceLast: state?.days_since ?? null,
      lastActivityDate: state?.last_date ?? null,
      acwr:
        acwrFinding?.status !== "ineligible" && typeof acwrData?.ratio === "number"
          ? acwrData.ratio
          : (lastAcwr[0]?.ratio ?? null),
      acwrAsOf:
        acwrFinding?.status !== "ineligible"
          ? new Date().toISOString().slice(0, 10)
          : (lastAcwr[0]?.d ?? null),
      acwrStale: acwrFinding?.status === "ineligible",
      vo2max: vo2.at(-1)?.v ?? null,
      vo2maxChange:
        vo2.length > 1 ? Number((vo2.at(-1)!.v - vo2[0].v).toFixed(1)) : null,
      vo2maxSince: vo2[0]?.d ?? null,
    },
    findings: report.findings,
    weekly: weekly.map((w) => ({
      weekStart: w.week,
      load: Math.round(loadByWeek.get(w.week) ?? 0),
      gymSessions: w.gym,
      runSessions: w.run,
      hours: w.hours,
    })),
    pace: pace.map((p) => ({ date: p.d, secPerKm: p.sec, km: p.km })),
    vo2max: vo2.map((v) => ({ date: v.d, value: v.v })),
    calendar: [...calByDay.entries()]
      .map(([date, v]) => ({ date, load: Math.round(v.load), sessions: v.sessions }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    efficiency: eff.map((e) => ({
      date: e.d,
      index: e.idx,
      km: e.km,
      avgHr: e.hr,
    })),
    feed: feedRows.map((r) => ({
      id: Number(r.id),
      createdAt: r.created_at,
      trigger: r.trigger,
      decision: r.decision,
      severity: r.severity,
      subject: r.subject,
      message: r.message,
      rationale: r.rationale,
      status: r.status,
      activityDate: r.activity_date,
      chips: chipsFor(r.findings),
    })),
    today,
    totals: totals ?? { activities: 0, notifications: 0, sent: 0 },
    nutrition: {
      protein,
      weight,
      latestWeight: lastWeight,
      phases,
      phaseTrend,
      recentMeals: meals,
    },
  };
}
