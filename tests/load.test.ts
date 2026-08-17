import { describe, expect, it } from "vitest";

import { ewmaLoad, trimp, windowLoad, type ActivityLoad } from "@/lib/analysis/load";
import type { AthleteAnchors } from "@/lib/analysis/types";

/**
 * Invariants — properties that must hold whatever the thresholds are set to.
 *
 * The sensitivity sweep showed most thresholds are choices this dataset is too
 * small to validate. These tests cover the other half: the things that would be
 * *wrong* regardless of tuning. They're the regression net for the three ACWR
 * guards, each of which took a full replay over real history to discover and
 * any of which a refactor could silently undo.
 */

const anchors: AthleteAnchors = {
  hrMax: 195,
  hrMaxSource: "observed",
  restingHr: 58.8,
  restingHrSource: "overnight-worn",
  restingHrSamples: 11,
};

const DAY = 86_400_000;
const dayStr = (offsetFromEnd: number, end = Date.UTC(2026, 5, 30)) =>
  new Date(end - offsetFromEnd * DAY).toISOString().slice(0, 10);

function load(daysAgo: number, value = 100): ActivityLoad {
  return {
    id: daysAgo,
    date: dayStr(daysAgo),
    sportType: "Run",
    durationMin: 40,
    load: value,
    method: "trimp",
  };
}

const asOf = new Date(Date.UTC(2026, 5, 30, 12));

describe("trimp", () => {
  it("is zero at resting heart rate — no effort, no load", () => {
    expect(trimp(3600, anchors.restingHr, anchors)).toBe(0);
  });

  it("increases with duration at the same intensity", () => {
    const short = trimp(1800, 150, anchors);
    const long = trimp(3600, 150, anchors);
    expect(long).toBeGreaterThan(short);
  });

  it("increases with heart rate at the same duration", () => {
    const easy = trimp(3600, 120, anchors);
    const hard = trimp(3600, 180, anchors);
    expect(hard).toBeGreaterThan(easy);
  });

  it("weights intensity super-linearly, not just monotonically", () => {
    // The exponential term is the whole reason to use TRIMP over
    // minutes×intensity. Stated directly: doubling the fraction of heart-rate
    // reserve used must MORE than double the load per minute. A linear model
    // would give exactly 2.
    //
    // An earlier version of this test compared a hard 30 min against an easy
    // 60 min — which a linear model also passes. It was verified by sabotage:
    // replacing the formula with `minutes * fraction` left it green.
    const perMinute = (hr: number) => trimp(60, hr, anchors);
    const lowFraction = 0.4;
    const highFraction = 0.8;
    const hrAt = (f: number) =>
      anchors.restingHr + f * (anchors.hrMax - anchors.restingHr);

    const ratio = perMinute(hrAt(highFraction)) / perMinute(hrAt(lowFraction));
    expect(ratio).toBeGreaterThan(2);
  });

  it("lets a short hard session outweigh a much longer easy one", () => {
    // 15 minutes near threshold against a full easy hour. Under a linear model
    // the easy hour wins (13.9 vs 22.6); under TRIMP the hard block wins.
    const hardShort = trimp(900, 185, anchors);
    const easyLong = trimp(3600, 110, anchors);
    expect(hardShort).toBeGreaterThan(easyLong);
  });

  it("clamps rather than going negative below resting heart rate", () => {
    expect(trimp(3600, 40, anchors)).toBe(0);
  });

  it("returns zero when the heart-rate reserve is degenerate", () => {
    const broken: AthleteAnchors = { ...anchors, hrMax: 50, restingHr: 60 };
    expect(trimp(3600, 150, broken)).toBe(0);
  });
});

describe("ewmaLoad", () => {
  it("is scale-invariant — the ratio ignores the unit of load", () => {
    // Doubling every load must not change acute:chronic. If this breaks, the
    // ratio has picked up an absolute term and stopped being dimensionless.
    const base = [load(1), load(5), load(9), load(14), load(20), load(26)];
    const scaled = base.map((l) => ({ ...l, load: l.load * 10 }));

    const a = ewmaLoad(base, asOf).ratio;
    const b = ewmaLoad(scaled, asOf).ratio;
    expect(a).not.toBeNull();
    expect(b! / a!).toBeCloseTo(1, 6);
  });

  it("decays acute load across rest days", () => {
    const loads = [load(10, 500)];
    const soonAfter = ewmaLoad(loads, new Date(Date.UTC(2026, 5, 21, 12)));
    const longAfter = ewmaLoad(loads, asOf);
    expect(longAfter.acute).toBeLessThan(soonAfter.acute);
  });

  it("counts rest days — a layoff must be visible, not skipped", () => {
    // Same sessions, evaluated later. If zero-load days were skipped rather
    // than averaged in, both would come out the same and a layoff would be
    // invisible to the model.
    const loads = [load(30), load(32), load(34)];
    const near = ewmaLoad(loads, new Date(Date.UTC(2026, 5, 2, 12)));
    const far = ewmaLoad(loads, asOf);
    expect(far.chronic).toBeLessThan(near.chronic);
  });

  it("returns a null ratio when there is no history at all", () => {
    expect(ewmaLoad([], asOf).ratio).toBeNull();
  });
});

describe("windowLoad", () => {
  it("counts how many of the four chronic weeks contain training", () => {
    const spread = [load(2), load(9), load(16), load(23)];
    expect(windowLoad(spread, asOf).weeksCovered).toBe(4);
  });

  it("reports low coverage when sessions are bunched into a few days", () => {
    // The exact case that slipped past a session-count-only guard and scored
    // a load ratio of 4.0 on 21 May: four sessions, all within five days.
    const bunched = [load(1), load(2), load(3), load(4)];
    const w = windowLoad(bunched, asOf);
    expect(w.sessionsChronic).toBe(4);
    expect(w.weeksCovered).toBe(1);
  });

  it("excludes activities older than the chronic window", () => {
    const w = windowLoad([load(2), load(40), load(60)], asOf);
    expect(w.sessionsChronic).toBe(1);
  });

  it("flags when any contributing load was estimated rather than measured", () => {
    const mixed: ActivityLoad[] = [
      load(2),
      { ...load(5), method: "calibrated-duration" },
    ];
    expect(windowLoad(mixed, asOf).hasEstimated).toBe(true);
    expect(windowLoad([load(2)], asOf).hasEstimated).toBe(false);
  });
});
