import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@/lib/analysis/config";

/**
 * The aerobic-dose rule's constants.
 *
 * The rule itself needs a database, so what is pinned here is the reasoning
 * behind the numbers — the part that would quietly stop being true if someone
 * "tuned" them later.
 */

describe("aerobic threshold", () => {
  it("sits where aerobic training begins, not where movement does", () => {
    // 75% of max HR. Against this athlete's observed max of 195 that is
    // 146 bpm, which separates their elliptical (174) and runs (176-186) from
    // their lifting (128-134), badminton (127) and walks. Drop it much lower
    // and a walk becomes cardio; raise it and a genuine tempo run stops
    // counting.
    expect(DEFAULT_CONFIG.aerobicHrFraction).toBeGreaterThanOrEqual(0.7);
    expect(DEFAULT_CONFIG.aerobicHrFraction).toBeLessThanOrEqual(0.8);

    const hrMax = 195;
    const threshold = Math.round(hrMax * DEFAULT_CONFIG.aerobicHrFraction);
    expect(threshold).toBe(146);
    for (const lifting of [128, 129, 130, 132, 133, 134]) {
      expect(lifting).toBeLessThan(threshold);
    }
    for (const cardio of [174, 176, 185, 186]) {
      expect(cardio).toBeGreaterThan(threshold);
    }
  });

  it("demands most sessions carry heart rate before claiming a dose", () => {
    // A session with no HR is not an easy session. Averaging it in as zero
    // would report a training block as a lay-off — the same mistake as reading
    // an unworn watch as rest.
    expect(DEFAULT_CONFIG.minAerobicHrCoverage).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_CONFIG.minAerobicHrCoverage).toBeLessThan(1);
  });

  it("needs several weeks, because one week is not a dose", () => {
    expect(DEFAULT_CONFIG.minAerobicWeeks).toBeGreaterThanOrEqual(3);
  });

  it("has a dead band, so ordinary variation is not a story", () => {
    // Aerobic minutes swing hugely week to week — one missed run is -50%.
    // The band has to be wide or this rule fires every week and means nothing.
    expect(DEFAULT_CONFIG.aerobicChangeFraction).toBeGreaterThanOrEqual(0.25);
  });
});
