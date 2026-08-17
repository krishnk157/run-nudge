import { describe, expect, it } from "vitest";

import { buildJudgeInput, JUDGE_SYSTEM } from "@/lib/llm/judge";
import type { InsightReport } from "@/lib/analysis/types";

/**
 * The judge's *input contract*. The model call itself isn't unit-testable,
 * but what it gets to see is — and the honesty constraint depends entirely
 * on ineligible findings reaching the prompt with their reasons attached.
 */

const report: InsightReport = {
  activityId: 42,
  asOf: "2026-06-01",
  anchors: {
    hrMax: 195,
    hrMaxSource: "observed",
    restingHr: 58.8,
    restingHrSource: "overnight-worn",
    restingHrSamples: 11,
  },
  findings: [
    {
      rule: "acute_chronic_ratio",
      status: "fired",
      severity: "notable",
      statement: "Load ratio 1.51 — this week is well above your 4-week baseline.",
      data: { ratio: 1.51, acute: 306, chronic: 202 },
      eligibility: { eligible: true },
    },
    {
      rule: "resting_hr_drift",
      status: "ineligible",
      data: { overnightNightsRecent: 0 },
      eligibility: {
        eligible: false,
        reason:
          "needs nights with the watch worn to sleep — daytime readings are a different measurement and can't be compared",
        have: 0,
        need: 3,
      },
    },
    {
      rule: "strength_progression",
      status: "error",
      statement: "Rule strength_progression failed to evaluate.",
      data: { error: "boom" },
      eligibility: { eligible: true },
    },
  ],
  counts: { fired: 1, quiet: 0, ineligible: 1, error: 1 },
};

describe("buildJudgeInput", () => {
  const input = buildJudgeInput(report, "webhook");

  it("carries ineligible findings with their unlock reasons", () => {
    // Without this the model cannot distinguish "checked and fine" from
    // "couldn't check" — the exact conflation the system exists to prevent.
    expect(input).toContain("ineligible");
    expect(input).toContain("worn to sleep");
    expect(input).toContain('"have": 0');
    expect(input).toContain('"need": 3');
  });

  it("carries error findings so the rationale can note them", () => {
    expect(input).toContain('"status": "error"');
  });

  it("quotes the deterministic statement and numbers verbatim", () => {
    expect(input).toContain("Load ratio 1.51");
    expect(input).toContain('"ratio": 1.51');
  });

  it("includes the counts summary and trigger", () => {
    expect(input).toContain('"fired": 1');
    expect(input).toContain('"trigger": "webhook"');
  });
});

describe("JUDGE_SYSTEM", () => {
  it("states the honesty constraint about ineligible rules", () => {
    // Pin the load-bearing instructions so a prompt edit that drops them
    // fails a test instead of silently shipping.
    expect(JUDGE_SYSTEM).toMatch(/ineligible/i);
    expect(JUDGE_SYSTEM).toMatch(/never present an ineligible rule/i);
  });

  it("forbids the model from computing numbers", () => {
    expect(JUDGE_SYSTEM).toMatch(/never compute/i);
    expect(JUDGE_SYSTEM).toMatch(/verbatim/i);
  });

  it("defaults to silence", () => {
    expect(JUDGE_SYSTEM).toMatch(/default to silence/i);
  });
});
