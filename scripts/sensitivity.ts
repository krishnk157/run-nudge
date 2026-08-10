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
  const points: Point[] = rows.map((r) => ({
    activityId: Number(r.id),
    asOf: new Date(`${r.d}T12:00:00Z`),
  }));

  console.log(
    `Sweeping ${SWEEPS.length} thresholds over ${points.length} activities.\n` +
      `"churn" = how many of the ${points.length} decisions flip versus the previous row.\n`,
  );

  const verdicts: { param: string; kind: string; verdict: string; note: string }[] = [];

  for (const sweep of SWEEPS) {
    if (only && sweep.param !== only) continue;

    const isDefault = (v: number) => v === DEFAULT_CONFIG[sweep.param];
    console.log("─".repeat(76));
    console.log(
      `${sweep.param}  [${sweep.kind}]  → ${sweep.rule}   (default ${DEFAULT_CONFIG[sweep.param]})`,
    );
    console.log(
      `  ${"value".padEnd(9)}${"fired".padEnd(7)}${"quiet".padEnd(7)}${"n/a".padEnd(6)}${"churn".padEnd(7)}`,
    );

    let prev: string[] | null = null;
    let totalChurn = 0;
    let churnAtDefault = 0;

    for (const v of sweep.values) {
      const statuses = await evaluate(sweep, v, points, base, cache);
      const s = summarise(statuses);
      const c = prev ? churn(prev, statuses) : 0;
      totalChurn += c;
      if (isDefault(v) && prev) churnAtDefault = c;

      console.log(
        `  ${(isDefault(v) ? `▸${v}` : ` ${v}`).padEnd(9)}` +
          `${String(s.fired).padEnd(7)}${String(s.quiet).padEnd(7)}` +
          `${String(s.na).padEnd(6)}${String(prev ? c : "–").padEnd(7)}` +
          (s.err ? `  ${s.err} ERRORS` : ""),
      );
      prev = statuses;
    }

    // Two separate questions, and an earlier version of this script conflated
    // them by measuring only `fired` counts — which called a threshold inert
    // while it was visibly moving decisions between quiet and ineligible.
    //   1. Does the threshold change ANY decision anywhere?  (total churn)
    //   2. Is it stable NEAR the value we chose?             (churn at default)
    const pct = (n: number) => Math.round((100 * n) / points.length);
    let verdict: string;
    let note: string;

    if (totalChurn === 0) {
      verdict = "INERT";
      note = "no value changes any outcome — untested on this history, not validated";
    } else if (churnAtDefault === 0) {
      verdict = "PLATEAU";
      note = `nothing flips at the chosen value; ${totalChurn} decisions move across the full range`;
    } else if (churnAtDefault <= Math.max(1, points.length * 0.05)) {
      verdict = "PLATEAU";
      note = `${churnAtDefault} decision(s) flip at the boundary (${pct(churnAtDefault)}%)`;
    } else {
      verdict = "CLIFF";
      note = `${churnAtDefault} decisions flip right at the chosen value (${pct(churnAtDefault)}%)`;
    }

    console.log(`  → ${verdict}: ${note}`);
    verdicts.push({ param: String(sweep.param), kind: sweep.kind, verdict, note });
  }

  console.log("\n" + "═".repeat(76));
  console.log("SUMMARY\n");
  for (const v of verdicts) {
    console.log(`  ${v.verdict.padEnd(9)}${v.kind.padEnd(12)}${v.param}`);
  }
  const cliffs = verdicts.filter((v) => v.verdict === "CLIFF");
  const inert = verdicts.filter((v) => v.verdict === "INERT");
  console.log(
    `\n${verdicts.length - cliffs.length - inert.length} plateau, ${cliffs.length} cliff, ${inert.length} inert.`,
  );
  if (cliffs.length) {
    console.log(
      "\nCliffs need an argument, not a default:\n" +
        cliffs.map((c) => `  • ${c.param} — ${c.note}`).join("\n"),
    );
  }
  if (inert.length) {
    console.log(
      "\nInert thresholds do nothing on this history — untested, not validated:\n" +
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
