/**
 * Threshold sensitivity sweep.
 *
 * Every threshold in the engine was chosen by judgment. This asks the only
 * question that makes such a choice defensible: **does the answer depend on it?**
 *
 *   PLATEAU — findings barely move across a wide range of values. The exact
 *             number doesn't matter; the threshold is doing structural work.
 *   CLIFF   — findings jump sharply near the chosen value. That means the value
 *             was selected to produce a particular answer, which is not a
 *             finding about the athlete, it's a finding about me.
 *
 * A cliff isn't automatically wrong — a real discontinuity in the data can
 * cause one — but it has to be argued for rather than assumed.
 *
 *   npm run sensitivity
 *   npm run sensitivity -- --param minChronicSessions
 */
import "dotenv/config";

import { sql } from "@/db/client";
import { getAnchors } from "@/lib/analysis/athlete";
import { DEFAULT_CONFIG, type AnalysisConfig } from "@/lib/analysis/config";
import { activityLoads, calibrate } from "@/lib/analysis/load";
import {
  newCache,
  RULES,
  type AnalysisCache,
  type RuleContext,
} from "@/lib/analysis/rules";
import type { AthleteAnchors, Finding } from "@/lib/analysis/types";

const argv = process.argv.slice(2);
const only = (() => {
  const i = argv.indexOf("--param");
  return i === -1 ? null : argv[i + 1];
})();

/** Which rule each parameter governs, so the sweep only re-runs what changed. */
type Sweep = {
  param: keyof AnalysisConfig;
  rule: string;
  values: number[];
  kind: "METHOD" | "PREFERENCE";
};

const SWEEPS: Sweep[] = [
  { param: "minChronicSessions", rule: "acute_chronic_ratio", kind: "METHOD",
    values: [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14] },
  { param: "minChronicWeeks", rule: "acute_chronic_ratio", kind: "METHOD",
    values: [1, 2, 3, 4] },
  { param: "acwrHigh", rule: "acute_chronic_ratio", kind: "PREFERENCE",
    values: [1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.0] },
  { param: "acwrLow", rule: "acute_chronic_ratio", kind: "PREFERENCE",
    values: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95] },
  { param: "ewmaChronicDays", rule: "acute_chronic_ratio", kind: "METHOD",
    values: [21, 28, 35, 42] },
  { param: "minEfficiencyRuns", rule: "aerobic_efficiency_trend", kind: "METHOD",
    values: [3, 4, 5, 6, 8, 10, 12] },
  { param: "returnGapDays", rule: "consistency", kind: "PREFERENCE",
    values: [7, 10, 14, 18, 21, 28] },
  { param: "stalledDays", rule: "consistency", kind: "PREFERENCE",
    values: [7, 10, 14, 21] },
  { param: "restingHrDeltaBpm", rule: "resting_hr_drift", kind: "PREFERENCE",
    values: [2, 3, 4, 5, 6, 8] },
  { param: "minRestingBaselineNights", rule: "resting_hr_drift", kind: "METHOD",
    values: [3, 5, 7, 10, 14] },
];

interface Point {
  activityId: number | null;
  asOf: Date;
}

/**
 * The engine has two trigger paths and they exercise different code.
 *
 *   activity  — an upload arrived. `gapBefore` is meaningful; "days since your
 *               last session" is zero by construction.
 *   scheduled — a cron tick with no activity. The reverse: the stalled/idle
 *               branches only ever run here.
 *
 * The first version of this sweep replayed only activity points, which made
 * `stalledDays` look INERT. It wasn't robust — it was never executed. A
 * threshold that is never reached is untested, and untested is indistinguishable
 * from stable if you only count outcomes.
 */
type Cohort = "activity" | "scheduled";

async function evaluate(
  sweep: Sweep,
  value: number,
  points: Point[],
  base: { anchors: AthleteAnchors; loads: Awaited<ReturnType<typeof activityLoads>> },
  cache: AnalysisCache,
): Promise<string[]> {
  const config: AnalysisConfig = { ...DEFAULT_CONFIG, [sweep.param]: value };
  const rule = RULES.find((r) => r.name === sweep.rule);
  if (!rule) throw new Error(`no rule ${sweep.rule}`);

  const statuses: string[] = [];
  for (const p of points) {
    const ctx: RuleContext = {
      asOf: p.asOf,
      anchors: base.anchors,
      loads: base.loads,
      activityId: p.activityId,
      config,
      cache,
    };
    let f: Finding;
    try {
      f = await rule.run(ctx);
    } catch (e) {
      f = {
        rule: rule.name,
        status: "error",
        data: { error: e instanceof Error ? e.message : String(e) },
        eligibility: { eligible: true },
      };
    }
    statuses.push(f.status);
  }
  return statuses;
}

function summarise(statuses: string[]) {
  return {
    fired: statuses.filter((s) => s === "fired").length,
    quiet: statuses.filter((s) => s === "quiet").length,
    na: statuses.filter((s) => s === "ineligible").length,
    err: statuses.filter((s) => s === "error").length,
  };
}

/** How many individual decisions flip between two adjacent parameter values. */
function churn(a: string[], b: string[]) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

async function main() {
  const anchors = await getAnchors();
  const cal = await calibrate(anchors);
  const loads = await activityLoads(anchors, cal);
  const base = { anchors, loads };
  const cache = newCache();

  const rows = await sql<{ id: number; d: string }[]>`
    select id, to_char(started_at_local,'YYYY-MM-DD') as d
    from activities order by started_at_local`;

  const activityPoints: Point[] = rows.map((r) => ({
    activityId: Number(r.id),
    asOf: new Date(`${r.d}T12:00:00Z`),
  }));

  // One scheduled tick per day from the first activity to today — the cron
  // path, which no activity replay ever reaches.
  const scheduledPoints: Point[] = [];
  const first = new Date(`${rows[0].d}T12:00:00Z`).getTime();
  const today = Date.now();
  for (let t = first; t <= today; t += 86_400_000) {
    scheduledPoints.push({ activityId: null, asOf: new Date(t) });
  }

  const cohorts: { name: Cohort; points: Point[] }[] = [
    { name: "activity", points: activityPoints },
    { name: "scheduled", points: scheduledPoints },
  ];

  console.log(
    `Sweeping ${SWEEPS.length} thresholds over two trigger paths:\n` +
      `  activity   ${activityPoints.length} uploads\n` +
      `  scheduled  ${scheduledPoints.length} daily cron ticks\n` +
      `"churn" = decisions that flip versus the previous row.\n`,
  );

  interface Verdict {
    param: string;
    kind: string;
    verdict: string;
    note: string;
    cohort: Cohort;
  }
  const verdicts: Verdict[] = [];

  for (const sweep of SWEEPS) {
    if (only && sweep.param !== only) continue;

    const isDefault = (v: number) => v === DEFAULT_CONFIG[sweep.param];
    console.log("─".repeat(76));
    console.log(
      `${sweep.param}  [${sweep.kind}]  → ${sweep.rule}   (default ${DEFAULT_CONFIG[sweep.param]})`,
    );

    for (const cohort of cohorts) {
      let prev: string[] | null = null;
      let totalChurn = 0;
      let churnAtDefault = 0;
      const lines: string[] = [];
      // Which points this threshold governs at all — i.e. those whose status
      // changes somewhere in the sweep. Everything else is decided by other
      // conditions and would only dilute the denominator.
      const governed = new Set<number>();
      let firstStatuses: string[] | null = null;

      for (const v of sweep.values) {
        const statuses = await evaluate(sweep, v, cohort.points, base, cache);
        const s = summarise(statuses);
        const c = prev ? churn(prev, statuses) : 0;
        totalChurn += c;
        if (isDefault(v) && prev) churnAtDefault = c;
        firstStatuses ??= statuses;
        statuses.forEach((st, i) => {
          if (st !== firstStatuses![i]) governed.add(i);
        });

        lines.push(
          `    ${(isDefault(v) ? `▸${v}` : ` ${v}`).padEnd(9)}` +
            `${String(s.fired).padEnd(7)}${String(s.quiet).padEnd(7)}` +
            `${String(s.na).padEnd(6)}${String(prev ? c : "–").padEnd(7)}` +
            (s.err ? `  ${s.err} ERRORS` : ""),
        );
        prev = statuses;
      }

      // Two separate questions, and an earlier version conflated them by
      // measuring only `fired` counts:
      //   1. Does the threshold change ANY decision here?  (total churn)
      //   2. Is it stable NEAR the value we chose?         (churn at default)
      // Denominator is the set of decisions this threshold actually governs,
      // not the cohort size. Using cohort size made the same 3 flips read as
      // 11% on 28 activities and 2% on 199 cron ticks — the verdict was
      // tracking how many points I happened to sample, not stability.
      const n = cohort.points.length;
      const gov = governed.size;
      const pct = (x: number) => (gov ? Math.round((100 * x) / gov) : 0);
      let verdict: string;
      let note: string;

      if (totalChurn === 0) {
        verdict = "INERT";
        note = "never reached on this path — untested, not validated";
      } else if (churnAtDefault === 0) {
        verdict = "PLATEAU";
        note = `nothing flips at the chosen value; governs ${gov} of ${n} decisions`;
      } else if (churnAtDefault / gov <= 0.25) {
        verdict = "PLATEAU";
        note = `${churnAtDefault} of the ${gov} decisions it governs flip at the boundary (${pct(churnAtDefault)}%)`;
      } else {
        verdict = "CLIFF";
        note = `${churnAtDefault} of the ${gov} decisions it governs flip right at the chosen value (${pct(churnAtDefault)}%)`;
      }

      console.log(`  ${cohort.name} (${n} points)`);
      if (totalChurn > 0) {
        console.log(
          `    ${"value".padEnd(9)}${"fired".padEnd(7)}${"quiet".padEnd(7)}${"n/a".padEnd(6)}${"churn".padEnd(7)}`,
        );
        console.log(lines.join("\n"));
      }
      console.log(`    → ${verdict}: ${note}`);
      verdicts.push({
        param: String(sweep.param),
        kind: sweep.kind,
        verdict,
        note,
        cohort: cohort.name,
      });
    }
  }

  console.log("\n" + "═".repeat(76));
  console.log("SUMMARY — worst verdict across the two trigger paths\n");

  const params = [...new Set(verdicts.map((v) => v.param))];
  const rank = { CLIFF: 3, INERT: 2, PLATEAU: 1 } as const;
  const overall = params.map((p) => {
    const vs = verdicts.filter((v) => v.param === p);
    // A threshold exercised on neither path is untested overall; one that is
    // a cliff anywhere is a cliff.
    const allInert = vs.every((v) => v.verdict === "INERT");
    const worst = vs.reduce((a, b) =>
      rank[b.verdict as keyof typeof rank] > rank[a.verdict as keyof typeof rank] ? b : a,
    );
    return {
      param: p,
      kind: vs[0].kind,
      verdict: allInert ? "INERT" : worst.verdict === "INERT" ? "PLATEAU" : worst.verdict,
      driver: worst.cohort,
      note: worst.note,
      allInert,
    };
  });

  for (const v of overall) {
    console.log(
      `  ${v.verdict.padEnd(9)}${v.kind.padEnd(12)}${v.param.padEnd(28)}` +
        (v.verdict === "CLIFF" ? `(${v.driver} path)` : ""),
    );
  }

  const cliffs = overall.filter((v) => v.verdict === "CLIFF");
  const inert = overall.filter((v) => v.verdict === "INERT");
  console.log(
    `\n${overall.length - cliffs.length - inert.length} plateau, ${cliffs.length} cliff, ${inert.length} inert.`,
  );
  if (cliffs.length) {
    console.log(
      "\nCliffs need an argument, not a default:\n" +
        cliffs.map((c) => `  • ${c.param} — ${c.note} [${c.driver}]`).join("\n"),
    );
  }
  if (inert.length) {
    console.log(
      "\nNever exercised on either path — untested, not validated:\n" +
        inert.map((c) => `  • ${c.param}`).join("\n"),
    );
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("Failed:", e);
    await sql.end();
    process.exit(1);
  });
