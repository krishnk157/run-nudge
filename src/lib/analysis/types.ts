/**
 * Findings produced by the analysis engine.
 *
 * The engine is deterministic — every number here is computed in code or SQL.
 * The LLM (Day 4) reads these findings to decide whether to speak and how to
 * phrase it; it never recalculates them.
 */

/**
 * Four outcomes, not two.
 *
 * `quiet`      — ran, nothing worth saying.
 * `ineligible` — could not run; the data isn't there. Expected and benign.
 * `error`      — tried to run and broke. A defect, never a data condition.
 *
 * `error` is separate from `ineligible` because collapsing them hides bugs
 * behind a status that looks routine. A broken rule reported as "dormant for
 * want of data" is a defect that will never be investigated — which is the
 * same mistake, one level up, as letting absent data read as reassurance.
 */
export type RuleStatus = "fired" | "quiet" | "ineligible" | "error";

export type Severity = "info" | "notable" | "warning";

/** Why a rule can or cannot run, in terms a person can act on. */
export interface Eligibility {
  eligible: boolean;
  /** Present when ineligible: what's missing, phrased as the unlock condition. */
  reason?: string;
  have?: number;
  need?: number;
}

export interface Finding {
  rule: string;
  status: RuleStatus;
  severity?: Severity;
  /**
   * A plain factual statement of what was computed — deterministic, and safe to
   * show without an LLM. Day 4 rewrites this for tone; it does not invent it.
   */
  statement?: string;
  data: Record<string, unknown>;
  eligibility: Eligibility;
}

/** Anchors derived from the athlete's own history rather than population norms. */
export interface AthleteAnchors {
  hrMax: number;
  hrMaxSource: "observed" | "assumed";
  restingHr: number;
  /**
   * Which measurement regime the resting HR came from. Values recorded on
   * nights the watch wasn't worn are a daytime minimum, ~10 bpm higher, and
   * must never be averaged together with true overnight readings.
   */
  restingHrSource: "overnight-worn" | "mixed-regime" | "assumed";
  restingHrSamples: number;
}

export interface InsightReport {
  activityId: number | null;
  asOf: string;
  anchors: AthleteAnchors;
  findings: Finding[];
  counts: { fired: number; quiet: number; ineligible: number; error: number };
}

export const ok = (): Eligibility => ({ eligible: true });

export const needs = (reason: string, have: number, need: number): Eligibility => ({
  eligible: false,
  reason,
  have,
  need,
});
