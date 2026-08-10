import { sql } from "@/db/client";
import { getAnchors } from "./athlete";
import { loadContext, RULES } from "./rules";
import type { Finding, InsightReport } from "./types";

/**
 * The Day 3 deliverable: structured findings for one activity (or for a point
 * in time, when triggered by a schedule rather than an upload).
 *
 * Everything returned here is computed deterministically. Day 4's LLM reads
 * this report to decide whether to notify and how to word it — it never
 * recalculates a number, and it is handed the ineligible findings too, so it
 * cannot phrase missing data as reassurance.
 */
export async function computeInsights(
  activityId: number | null = null,
  asOf?: Date,
): Promise<InsightReport> {
  const when = asOf ?? (await resolveAsOf(activityId));
  const anchors = await getAnchors();
  const ctx = await loadContext(when, anchors, activityId);

  const findings: Finding[] = [];
  for (const { name, run } of RULES) {
    try {
      findings.push(await run(ctx));
    } catch (e) {
      // A broken rule must not take down the report — the other rules still
      // have something to say. But it is recorded as `error`, attributed to
      // the rule that threw, and never as `ineligible`: a defect dressed as a
      // data condition is a defect nobody will ever look into.
      findings.push({
        rule: name,
        status: "error",
        severity: "warning",
        statement: `Rule ${name} failed to evaluate.`,
        data: { error: e instanceof Error ? e.message : String(e) },
        eligibility: { eligible: true },
      });
    }
  }

  const count = (s: Finding["status"]) =>
    findings.filter((f) => f.status === s).length;

  return {
    activityId,
    asOf: when.toISOString().slice(0, 10),
    anchors,
    findings,
    counts: {
      fired: count("fired"),
      quiet: count("quiet"),
      ineligible: count("ineligible"),
      error: count("error"),
    },
  };
}

async function resolveAsOf(activityId: number | null): Promise<Date> {
  if (activityId == null) return new Date();
  const [r] = await sql<{ d: string }[]>`
    select to_char(started_at_local, 'YYYY-MM-DD') as d
    from activities where id = ${activityId}`;
  if (!r) throw new Error(`No activity ${activityId}`);
  return new Date(`${r.d}T12:00:00Z`);
}
