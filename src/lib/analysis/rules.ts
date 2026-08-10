import { sql } from "@/db/client";
import { DEFAULT_CONFIG, type AnalysisConfig } from "./config";
import {
  activityLoads,
  calibrate,
  ewmaLoad,
  windowLoad,
  type ActivityLoad,
} from "./load";
import {
  consistency,
  efficiencySeries,
  gapBefore,
  slope,
  type Consistency,
  type EfficiencyPoint,
} from "./metrics";
import { needs, ok, type AthleteAnchors, type Finding } from "./types";

/**
 * A rule is a computation *plus a precondition*.
 *
 * That pairing is the whole architecture: sensor availability here is
 * intermittent by nature, so a rule that assumes its inputs exist will either
 * fire on nothing or go silent in a way indistinguishable from "all clear".
 * Declaring what a rule needs lets the engine report `ineligible` with a
 * reason, and lets the rule switch itself back on when the data returns —
 * no code change, nothing to remember.
 */
export interface RuleContext {
  asOf: Date;
  anchors: AthleteAnchors;
  loads: ActivityLoad[];
  activityId: number | null;
  config: AnalysisConfig;
  /**
   * Optional memo for the SQL-backed lookups. The engine gives each report a
   * fresh one (so a long-lived process can't serve stale data); the sensitivity
   * sweep shares one across thousands of runs, where the data is static by
   * construction.
   */
  cache?: AnalysisCache;
}

export interface AnalysisCache {
  efficiency?: EfficiencyPoint[];
  gaps: Map<number, number | null>;
  consistency: Map<string, Consistency>;
  restingHr: Map<string, RestingHrWindow>;
}

export const newCache = (): AnalysisCache => ({
  gaps: new Map(),
  consistency: new Map(),
  restingHr: new Map(),
});

export type Rule = (ctx: RuleContext) => Promise<Finding>;

const round = (n: number, p = 1) => Math.round(n * 10 ** p) / 10 ** p;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */

/**
 * Acute:chronic workload ratio, with three guards.
 *
 * Garmin scored this athlete's 5 Jul run at ACWR 4.8 "VERY_HIGH" — not because
 * the run was extreme, but because seven weeks off had decayed chronic load to
 * 131. A ratio whose denominator is near-zero measures the layoff, not the
 * session. The density and spread guards below were each added after replaying
 * real history showed the previous version emitting nonsense.
 */
export const acwrRule: Rule = async (ctx) => {
  const cfg = ctx.config;
  const w = windowLoad(ctx.loads, ctx.asOf);

  const byWeeks = w.weeksCovered < cfg.minChronicWeeks;
  const bySessions = w.sessionsChronic < cfg.minChronicSessions;

  if (byWeeks || bySessions) {
    return {
      rule: "acute_chronic_ratio",
      status: "ineligible",
      data: {
        acute: round(w.acute),
        chronic: round(w.chronic),
        sessionsChronic: w.sessionsChronic,
        weeksCovered: w.weeksCovered,
        // What the ratio *would* have been. Kept for debugging and the
        // validation script; never surfaced as a finding.
        suppressedRatio: w.ratio == null ? null : round(w.ratio, 2),
      },
      eligibility: needs(
        byWeeks
          ? "training in the last 28 days is too bunched to be a baseline — a ratio here would describe the ramp-up, not the session"
          : "not enough training in the last 28 days to form a baseline — a ratio here would describe the gap, not the session",
        byWeeks ? w.weeksCovered : w.sessionsChronic,
        byWeeks ? cfg.minChronicWeeks : cfg.minChronicSessions,
      ),
    };
  }

  // The exponentially weighted ratio is the reported one; the flat rolling
  // version is kept alongside because the two disagreeing is itself a signal
  // worth seeing during a ramp-up.
  const e = ewmaLoad(ctx.loads, ctx.asOf, {
    acuteDays: cfg.ewmaAcuteDays,
    chronicDays: cfg.ewmaChronicDays,
  });
  const ratio = e.ratio ?? (w.ratio as number);
  const high = ratio >= cfg.acwrHigh;
  const low = ratio < cfg.acwrLow;

  return {
    rule: "acute_chronic_ratio",
    status: high || low ? "fired" : "quiet",
    severity:
      ratio >= cfg.acwrWarning ? "warning" : high || low ? "notable" : "info",
    statement: high
      ? `Load ratio ${round(ratio, 2)} — this week is well above your 4-week baseline.`
      : low
        ? `Load ratio ${round(ratio, 2)} — this week is well below your 4-week baseline.`
        : `Load ratio ${round(ratio, 2)}, within the usual band.`,
    data: {
      ratio: round(ratio, 2),
      method: "ewma",
      acute: round(e.acute),
      chronic: round(e.chronic),
      rollingRatio: w.ratio == null ? null : round(w.ratio, 2),
      sessionsAcute: w.sessionsAcute,
      sessionsChronic: w.sessionsChronic,
      weeksCovered: w.weeksCovered,
      // Flags that some contributing load was estimated from duration rather
      // than measured from heart rate — the two are different regimes.
      includesEstimatedLoad: w.hasEstimated,
    },
    eligibility: ok(),
  };
};

/* ------------------------------------------------------------------ */

/**
 * Aerobic efficiency trend — the quantity that tracks "improve VO2max and
 * pace". Dormant until there are enough HR-bearing runs to distinguish a trend
 * from noise.
 */
export const efficiencyRule: Rule = async (ctx) => {
  const cfg = ctx.config;
  let series = ctx.cache?.efficiency;
  if (!series) {
    series = await efficiencySeries(ctx.anchors);
    if (ctx.cache) ctx.cache.efficiency = series;
  }
  const pts = series.filter((p) => p.date <= isoDay(ctx.asOf));

  if (pts.length < cfg.minEfficiencyRuns) {
    return {
      rule: "aerobic_efficiency_trend",
      status: "ineligible",
      data: {
        runsWithHr: pts.length,
        latestIndex: pts.length ? round(pts[pts.length - 1].index, 5) : null,
      },
      eligibility: needs(
        "needs more runs recorded with heart rate before a trend means anything",
        pts.length,
        cfg.minEfficiencyRuns,
      ),
    };
  }

  const t0 = new Date(pts[0].date).getTime();
  const s = slope(
    pts.map((p) => ({
      x: (new Date(p.date).getTime() - t0) / 86_400_000,
      y: p.index,
    })),
  );
  const perMonth = s == null ? 0 : (s * 30) / pts[0].index;

  return {
    rule: "aerobic_efficiency_trend",
    status:
      Math.abs(perMonth) >= cfg.efficiencyChangePerMonth ? "fired" : "quiet",
    severity: "info",
    statement: `Aerobic efficiency ${perMonth >= 0 ? "up" : "down"} ${round(Math.abs(perMonth) * 100)}% per month across ${pts.length} runs.`,
    data: {
      runsWithHr: pts.length,
      changePerMonthPct: round(perMonth * 100, 2),
    },
    eligibility: ok(),
  };
};

/* ------------------------------------------------------------------ */

/** Consistency is the one rule that never lacks data — absence *is* its input. */
export const consistencyRule: Rule = async (ctx) => {
  const cfg = ctx.config;
  const key = isoDay(ctx.asOf);
  let c = ctx.cache?.consistency.get(key);
  if (!c) {
    c = await consistency(ctx.asOf);
    ctx.cache?.consistency.set(key, c);
  }

  if (c.daysSinceLast == null) {
    return {
      rule: "consistency",
      status: "ineligible",
      data: {},
      eligibility: needs("no activities recorded yet", 0, 1),
    };
  }

  // Triggered by an upload, the useful figure is the gap this session ended,
  // not "days since last" — which is zero by construction.
  let gap: number | null = null;
  if (ctx.activityId != null) {
    if (ctx.cache?.gaps.has(ctx.activityId)) {
      gap = ctx.cache.gaps.get(ctx.activityId) ?? null;
    } else {
      gap = await gapBefore(ctx.activityId);
      ctx.cache?.gaps.set(ctx.activityId, gap);
    }
  }

  const returning = gap != null && gap >= cfg.returnGapDays;
  const stalled = ctx.activityId == null && c.daysSinceLast >= cfg.stalledDays;
  const belowBaseline =
    ctx.activityId == null && c.sessionsLast7 === 0 && c.weeklyBaseline >= 1;

  return {
    rule: "consistency",
    status: returning || stalled || belowBaseline ? "fired" : "quiet",
    severity:
      (gap ?? c.daysSinceLast) >= 28
        ? "warning"
        : returning || stalled
          ? "notable"
          : "info",
    statement: returning
      ? `First session in ${gap} days.`
      : stalled
        ? `${c.daysSinceLast} days since your last session — your recent norm is ${round(c.weeklyBaseline)} a week.`
        : `${c.sessionsLast7} sessions in the last 7 days.`,
    data: {
      gapBeforeDays: gap,
      daysSinceLast: c.daysSinceLast,
      lastDate: c.lastDate,
      sessionsLast7: c.sessionsLast7,
      sessionsLast28: c.sessionsLast28,
      weeklyBaseline: round(c.weeklyBaseline, 2),
      longestGapDays: c.longestGapDays,
    },
    eligibility: ok(),
  };
};

/* ------------------------------------------------------------------ */

interface RestingHrWindow {
  recent: number | null;
  nRecent: number;
  baseline: number | null;
  nBase: number;
}

/**
 * Resting-HR drift, gated on measurement regime rather than on presence.
 *
 * Resting HR averages 58.8 bpm on nights the watch was worn and 68.5 when it
 * wasn't — the second is a daytime minimum wearing the same column name. A
 * baseline spanning both would read a return to consistent wear as a 10 bpm
 * improvement in fitness. So this rule only ever looks at `valid_sleep` days.
 */
export const restingHrRule: Rule = async (ctx) => {
  const cfg = ctx.config;
  const iso = isoDay(ctx.asOf);

  let win = ctx.cache?.restingHr.get(iso);
  if (!win) {
    const [r] = await sql<
      {
        recent: number | null;
        n_recent: number;
        baseline: number | null;
        n_base: number;
      }[]
    >`
      select
        avg(resting_hr) filter (where date >  ${iso}::date - 14)::float as recent,
        count(*)        filter (where date >  ${iso}::date - 14)::int   as n_recent,
        avg(resting_hr) filter (where date <= ${iso}::date - 14)::float as baseline,
        count(*)        filter (where date <= ${iso}::date - 14)::int   as n_base
      from daily_metrics
      where resting_hr is not null and valid_sleep is true and date <= ${iso}::date`;
    win = {
      recent: r?.recent ?? null,
      nRecent: r?.n_recent ?? 0,
      baseline: r?.baseline ?? null,
      nBase: r?.n_base ?? 0,
    };
    ctx.cache?.restingHr.set(iso, win);
  }

  if (
    win.nRecent < cfg.minRestingRecentNights ||
    win.nBase < cfg.minRestingBaselineNights
  ) {
    return {
      rule: "resting_hr_drift",
      status: "ineligible",
      data: {
        overnightNightsRecent: win.nRecent,
        overnightNightsBaseline: win.nBase,
      },
      eligibility: needs(
        "needs nights with the watch worn to sleep — daytime readings are a different measurement and can't be compared",
        win.nRecent,
        cfg.minRestingRecentNights,
      ),
    };
  }

  const delta = (win.recent as number) - (win.baseline as number);
  return {
    rule: "resting_hr_drift",
    status: Math.abs(delta) >= cfg.restingHrDeltaBpm ? "fired" : "quiet",
    severity: delta >= cfg.restingHrDeltaBpm + 2 ? "warning" : "notable",
    statement: `Resting HR ${delta >= 0 ? "up" : "down"} ${round(Math.abs(delta))} bpm versus your baseline.`,
    data: {
      recent: round(win.recent as number),
      baseline: round(win.baseline as number),
      deltaBpm: round(delta),
      regime: "overnight-worn-only",
    },
    eligibility: ok(),
  };
};

/* ------------------------------------------------------------------ */

/**
 * Strength progression. Structurally complete, permanently ineligible until
 * sessions are recorded in Garmin's strength mode — all 10 historical gym
 * sessions return 404 for exercise sets, so there is nothing to count yet.
 */
export const strengthRule: Rule = async () => {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from information_schema.tables
    where table_schema = 'public' and table_name = 'strength_sets'`;

  return {
    rule: "strength_progression",
    status: "ineligible",
    data: { sessionsWithSetData: 0, tableExists: (r?.n ?? 0) > 0 },
    eligibility: needs(
      "needs gym sessions recorded in Garmin's strength mode — earlier sessions have no per-set data",
      0,
      1,
    ),
  };
};

/* ------------------------------------------------------------------ */

/** Named so a failure can be attributed to a rule rather than to "unknown". */
export interface RegisteredRule {
  name: string;
  run: Rule;
}

export const RULES: RegisteredRule[] = [
  { name: "acute_chronic_ratio", run: acwrRule },
  { name: "consistency", run: consistencyRule },
  { name: "aerobic_efficiency_trend", run: efficiencyRule },
  { name: "resting_hr_drift", run: restingHrRule },
  { name: "strength_progression", run: strengthRule },
];

export async function loadContext(
  asOf: Date,
  anchors: AthleteAnchors,
  activityId: number | null = null,
  config: AnalysisConfig = DEFAULT_CONFIG,
  cache?: AnalysisCache,
): Promise<RuleContext> {
  const cal = await calibrate(anchors);
  const loads = await activityLoads(anchors, cal);
  return { asOf, anchors, loads, activityId, config, cache };
}
