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
  aerobicWeeks,
  consistency,
  efficiencySeries,
  gapBefore,
  slope,
  type Consistency,
  type EfficiencyPoint,
} from "./metrics";
import {
  currentPhaseTrend,
  MIN_PHASE_READINGS,
} from "@/lib/nutrition/body";
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

  const byRecent = win.nRecent < cfg.minRestingRecentNights;
  const byBaseline = win.nBase < cfg.minRestingBaselineNights;
  if (byRecent || byBaseline) {
    // Report whichever condition actually failed. The first version always
    // reported the recent-nights dimension, so a baseline failure showed
    // have=6 need=3 — numbers that look satisfied. Found by the LLM judge,
    // whose rationale flagged the contradiction on a simulated event.
    return {
      rule: "resting_hr_drift",
      status: "ineligible",
      data: {
        overnightNightsRecent: win.nRecent,
        overnightNightsBaseline: win.nBase,
      },
      eligibility: needs(
        byRecent
          ? "needs recent nights with the watch worn to sleep — daytime readings are a different measurement and can't be compared"
          : "needs more history of watch-worn nights to form a baseline to compare against",
        byRecent ? win.nRecent : win.nBase,
        byRecent ? cfg.minRestingRecentNights : cfg.minRestingBaselineNights,
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
export const strengthRule: Rule = async (ctx) => {
  const iso = isoDay(ctx.asOf);
  const [r] = await sql<{ sessions: number }[]>`
    select count(*)::int as sessions
    from activities
    where sport_type = 'WeightTraining'
      and started_at_local <= ${iso}::date
      and started_at_local > ${iso}::date - 28`;

  const sessions = r?.sessions ?? 0;

  // Phrasing matters here. The first version reported
  // `sessionsWithSetData: 0` as a constant and the weekly digest repeated it
  // as "none of the gym sessions carry per-set data" — a claim about Garmin
  // that this rule had never checked. It happened to be true, which is worse
  // than being wrong: an unverified assertion that survives by luck.
  //
  // Ingestion of per-set data isn't built yet (deferred from Day 2), so the
  // only honest statement is about what has been ingested, not about what
  // Garmin holds.
  return {
    rule: "strength_progression",
    status: "ineligible",
    data: {
      gymSessionsLast28Days: sessions,
      setDataIngested: false,
      note: "per-set ingestion not implemented; this rule cannot see set data yet",
    },
    eligibility: needs(
      "no per-set strength data has been ingested yet — the ingestion for it isn't built, so set-level progression can't be assessed either way",
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


/**
 * Weekly aerobic minutes, and whether they are going anywhere.
 *
 * The athlete wants VO2max and pace to improve. Every other rule here either
 * measures strain (ACWR), frequency (consistency) or a response to training
 * (efficiency, resting HR) — none of them measure the *dose* of the specific
 * work that moves those two numbers. That was a hole rather than a decision,
 * and it went unnoticed because the athlete's aerobic work used to be runs,
 * which the efficiency rule happened to cover.
 *
 * It stopped being covered the moment the aerobic work moved to a machine.
 * Eleven minutes on an elliptical at 90% of max heart rate is a real stimulus
 * that the efficiency rule cannot see, because that rule needs pace, and a
 * machine reports none.
 *
 * What this rule will not do is prescribe. It reports minutes and the
 * direction they are moving, with the modalities that produced them. There is
 * no target here, because the system holds no aerobic target and inventing one
 * to measure against would be training advice.
 */
export const aerobicDoseRule: Rule = async (ctx) => {
  const cfg = ctx.config;
  const threshold = Math.round(ctx.anchors.hrMax * cfg.aerobicHrFraction);
  const weeks = await aerobicWeeks(ctx.asOf, threshold, 12);

  /*
   * The current week is excluded from the *comparison* because it is partly
   * unlived — on a Monday it will always look like a collapse against a
   * finished week. It is not excluded from the *statement*, and that
   * distinction was learned the hard way: the first version reported "aerobic
   * minutes down 66%" on the exact day the athlete had started a new cardio
   * habit, because the three complete weeks behind it were the tail of a
   * stopped running block and the 22 minutes already banked this week sat
   * outside the window.
   *
   * Both facts were true. Only one of them was the news.
   */
  const complete = weeks.slice(0, -1);
  const current = weeks.at(-1);

  const base = {
    hrThreshold: threshold,
    hrMaxSource: ctx.anchors.hrMaxSource,
    weeksOnFile: complete.length,
  };

  if (ctx.anchors.hrMaxSource === "assumed") {
    // Every minute counted here depends on where the threshold sits, and the
    // threshold is a fraction of max HR. Against an assumed maximum this rule
    // would be measuring a guess and reporting it as a dose.
    return {
      rule: "aerobic_dose",
      status: "ineligible",
      data: base,
      eligibility: needs(
        "max heart rate has never been observed, so an aerobic threshold would be a fraction of a guess — needs one hard session recorded with heart rate",
        0,
        1,
      ),
    };
  }

  if (complete.length < cfg.minAerobicWeeks) {
    return {
      rule: "aerobic_dose",
      status: "ineligible",
      data: base,
      eligibility: needs(
        `needs ${cfg.minAerobicWeeks} complete weeks of training to compare aerobic minutes against`,
        complete.length,
        cfg.minAerobicWeeks,
      ),
    };
  }

  const recent = complete.slice(-cfg.minAerobicWeeks);
  const covered = recent.reduce((a, w) => a + w.withHr, 0);
  const totalSessions = recent.reduce((a, w) => a + w.total, 0);
  const coverage = totalSessions === 0 ? 0 : covered / totalSessions;

  if (coverage < cfg.minAerobicHrCoverage) {
    // Sessions without heart rate are not zero-intensity sessions. Averaging
    // them in as zero would report a training block as a lay-off.
    return {
      rule: "aerobic_dose",
      status: "ineligible",
      data: { ...base, coverage: round(coverage, 2), sessionsWithHr: covered, sessions: totalSessions },
      eligibility: needs(
        `only ${Math.round(coverage * 100)}% of recent sessions carry heart rate — the rest can't be scored, and counting them as easy would understate the work`,
        covered,
        Math.ceil(totalSessions * cfg.minAerobicHrCoverage),
      ),
    };
  }

  const minutes = recent.map((w) => w.minutes);
  const avg = minutes.reduce((a, b) => a + b, 0) / minutes.length;
  const earlier = complete.slice(0, -cfg.minAerobicWeeks);
  const priorAvg = earlier.length
    ? earlier.reduce((a, w) => a + w.minutes, 0) / earlier.length
    : null;

  const sports = [...new Set(recent.flatMap((w) => w.sports))].sort();
  const data = {
    ...base,
    weeklyMinutes: minutes,
    recentAvgMinutes: round(avg),
    priorAvgMinutes: priorAvg == null ? null : round(priorAvg),
    coverage: round(coverage, 2),
    modalities: sports,
    currentWeekMinutes: current?.minutes ?? 0,
    currentWeekPartial: true,
  };

  if (avg === 0) {
    // Distinct from ineligible: the watch was worn, the sessions were scored,
    // and none of them were aerobic. That is a finding, not a data gap.
    return {
      rule: "aerobic_dose",
      status: "fired",
      severity: "info",
      statement:
        `No aerobic minutes in the last ${cfg.minAerobicWeeks} weeks — no session ` +
        `averaged above ${threshold} bpm, though heart rate was recorded for ` +
        `${Math.round(coverage * 100)}% of them.`,
      data,
      eligibility: ok(),
    };
  }

  const change = priorAvg && priorAvg > 0 ? (avg - priorAvg) / priorAvg : null;
  const moved = change != null && Math.abs(change) >= cfg.aerobicChangeFraction;

  if (!moved) {
    return { rule: "aerobic_dose", status: "quiet", data, eligibility: ok() };
  }

  const thisWeek = current?.minutes ?? 0;
  const thisWeekSports = [...new Set(current?.sports ?? [])].sort();
  const newModality = thisWeekSports.filter((s) => !sports.includes(s));

  return {
    rule: "aerobic_dose",
    status: "fired",
    severity: "info",
    statement:
      `Aerobic minutes ${change! > 0 ? "up" : "down"} ` +
      `${Math.abs(Math.round(change! * 100))}%: ${round(avg)} min/week over the ` +
      `last ${cfg.minAerobicWeeks} complete weeks against ${round(priorAvg!)} ` +
      `before, above ${threshold} bpm, from ${sports.join(" and ") || "no modality"}.` +
      (thisWeek > 0
        ? ` This week so far: ${thisWeek} min` +
          (thisWeekSports.length ? ` from ${thisWeekSports.join(" and ")}` : "") +
          (newModality.length
            ? `, which is new — ${newModality.join(" and ")} does not appear in the weeks above`
            : "") +
          `.`
        : ""),
    data: {
      ...data,
      changeFraction: round(change!, 2),
      currentWeekSports: thisWeekSports,
      currentWeekNewModalities: newModality,
    },
    eligibility: ok(),
  };
};

/* ------------------------------------------------------------------ */

/**
 * Weight moving against the declared goal.
 *
 * This is the only rule that reads data the athlete typed rather than data a
 * device produced, and it is deliberately the most conservative one here. It
 * reports a discrepancy between a stated intention and a measured direction —
 * "you have been drifting down 0.3 kg/week during a bulk" — and then stops.
 * It does not suggest eating more, because this system does not hold a calorie
 * target and giving one would be dietary advice it has no standing to give.
 *
 * Everything is scoped to the current phase. Fitting across a phase boundary
 * would produce a slope describing neither side of it, and the whole reason
 * phases are stored as dated state is to make that mistake unrepresentable.
 *
 * `maintain` never fires: for a maintain phase, "flat" is agreement and any
 * drift is the thing you'd want to know — but distinguishing meaningful drift
 * from ordinary fluctuation needs a variance model this doesn't have, and a
 * rule that fires on noise is worse than one that stays quiet.
 */
export const phaseDriftRule: Rule = async () => {
  const trend = await currentPhaseTrend();

  if (!trend.eligible) {
    return {
      rule: "phase_drift",
      status: "ineligible",
      data: {
        phase: trend.phase ?? null,
        readings: trend.readings ?? 0,
        spanDays: trend.spanDays ?? 0,
      },
      eligibility: needs(
        trend.reason ?? "not enough weigh-ins in the current phase",
        trend.readings ?? 0,
        MIN_PHASE_READINGS,
      ),
    };
  }

  if (trend.phase === "maintain" || trend.agrees) {
    return {
      rule: "phase_drift",
      status: "quiet",
      data: {
        phase: trend.phase,
        kgPerWeek: trend.kgPerWeek,
        readings: trend.readings,
        spanDays: trend.spanDays,
      },
      eligibility: ok(),
    };
  }

  const direction = trend.kgPerWeek! > 0 ? "gaining" : "losing";
  return {
    rule: "phase_drift",
    status: "fired",
    severity: "info",
    statement:
      `Weight is ${direction} ${Math.abs(trend.kgPerWeek!)} kg/week during a ` +
      `${trend.phase} phase that began ${trend.startedOn} — ` +
      `${trend.readings} weigh-ins over ${trend.spanDays} days, ` +
      `${trend.firstKg} kg to ${trend.lastKg} kg.`,
    data: {
      phase: trend.phase,
      startedOn: trend.startedOn,
      kgPerWeek: trend.kgPerWeek,
      readings: trend.readings,
      spanDays: trend.spanDays,
      firstKg: trend.firstKg,
      lastKg: trend.lastKg,
    },
    eligibility: ok(),
  };
};

/* ------------------------------------------------------------------ */

export const RULES: RegisteredRule[] = [
  { name: "acute_chronic_ratio", run: acwrRule },
  { name: "consistency", run: consistencyRule },
  { name: "aerobic_efficiency_trend", run: efficiencyRule },
  { name: "resting_hr_drift", run: restingHrRule },
  { name: "strength_progression", run: strengthRule },
  { name: "phase_drift", run: phaseDriftRule },
  { name: "aerobic_dose", run: aerobicDoseRule },
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
