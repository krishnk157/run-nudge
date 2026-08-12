import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG } from "@/lib/analysis/config";
import type { ActivityLoad } from "@/lib/analysis/load";
import {
  acwrRule,
  consistencyRule,
  efficiencyRule,
  newCache,
  restingHrRule,
  type RuleContext,
} from "@/lib/analysis/rules";
import type { AthleteAnchors } from "@/lib/analysis/types";

/**
 * Rule behaviour, without touching the database.
 *
 * `acwrRule` reads only its context. The other three read through the optional
 * cache, so pre-filling it exercises the real rule logic with no SQL — which
 * also proves the cache path itself is wired correctly.
 */

const anchors: AthleteAnchors = {
  hrMax: 195,
  hrMaxSource: "observed",
  restingHr: 58.8,
  restingHrSource: "overnight-worn",
  restingHrSamples: 11,
};

const DAY = 86_400_000;
const END = Date.UTC(2026, 5, 30);
const asOf = new Date(END + DAY / 2);
const dayStr = (daysAgo: number) =>
  new Date(END - daysAgo * DAY).toISOString().slice(0, 10);

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

/** Twelve sessions spread across all four weeks — a genuinely established base. */
const healthyBase = [1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26].map((d) => load(d));

function ctx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    asOf,
    anchors,
    loads: healthyBase,
    activityId: null,
    config: DEFAULT_CONFIG,
    cache: newCache(),
    ...overrides,
  };
}

describe("acwrRule — the three guards", () => {
  it("refuses after a layoff, however dramatic the arithmetic", async () => {
    // The 5 July case: one big session, nothing in the 28 days before it.
    // Garmin reported 4.8 VERY_HIGH here. A ratio built on an empty
    // denominator describes the gap, not the session.
    const r = await acwrRule(ctx({ loads: [load(0, 600)] }));
    expect(r.status).toBe("ineligible");
    expect(r.data.ratio).toBeUndefined();
  });

  it("refuses when sessions are bunched, even if the count is met", async () => {
    // Four sessions in five days passed a count-only guard and scored 4.0.
    const bunched = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => load(d));
    const r = await acwrRule(ctx({ loads: bunched }));
    expect(r.status).toBe("ineligible");
    expect(r.eligibility.reason).toMatch(/bunched/);
  });

  it("refuses when training is too sparse to form a baseline", async () => {
    // One session a week: enough spread, not enough density. This is the
    // February case where a 2 km run swung the ratio from 1.86 to 0.33.
    const weekly = [2, 9, 16, 23].map((d) => load(d));
    const r = await acwrRule(ctx({ loads: weekly }));
    expect(r.status).toBe("ineligible");
    expect(r.eligibility.need).toBe(DEFAULT_CONFIG.minChronicSessions);
  });

  it("reports a ratio once the baseline is both dense and spread", async () => {
    const r = await acwrRule(ctx());
    expect(r.status).not.toBe("ineligible");
    expect(typeof r.data.ratio).toBe("number");
    expect(r.data.method).toBe("ewma");
  });

  it("keeps the suppressed ratio for debugging without surfacing it", async () => {
    const r = await acwrRule(ctx({ loads: [load(0, 600)] }));
    expect(r.status).toBe("ineligible");
    expect(r.statement).toBeUndefined();
    expect("suppressedRatio" in r.data).toBe(true);
  });

  it("never emits a statement while ineligible", async () => {
    const cases = [[load(0)], [0, 1, 2, 3, 4, 5, 6, 7].map((d) => load(d))];
    for (const loads of cases) {
      const r = await acwrRule(ctx({ loads }));
      if (r.status === "ineligible") expect(r.statement).toBeUndefined();
    }
  });
});

describe("consistencyRule", () => {
  const base = {
    daysSinceLast: 0,
    lastDate: dayStr(0),
    sessionsLast7: 2,
    sessionsLast28: 8,
    weeklyBaseline: 2,
    longestGapDays: 30,
  };

  function withCache(consistencyData = base, gap: number | null = null, activityId = 1) {
    const cache = newCache();
    cache.consistency.set(asOf.toISOString().slice(0, 10), consistencyData);
    cache.gaps.set(activityId, gap);
    return ctx({ cache, activityId });
  }

  it("reports the gap a session ended, not days-since-last", async () => {
    // Triggered by an upload, "days since your last session" is zero by
    // construction — the session in hand is the last one.
    const r = await consistencyRule(withCache(base, 28));
    expect(r.status).toBe("fired");
    expect(r.statement).toBe("First session in 28 days.");
    expect(r.data.gapBeforeDays).toBe(28);
  });

  it("stays quiet for a session that continues a normal week", async () => {
    const r = await consistencyRule(withCache(base, 2));
    expect(r.status).toBe("quiet");
  });

  it("only raises the idle alert on the scheduled path", async () => {
    // An upload proves training is happening, so the idle branch must not fire
    // even when the trailing counts still look stale.
    const idle = { ...base, daysSinceLast: 21, sessionsLast7: 0 };
    const onUpload = await consistencyRule(withCache(idle, 1));
    expect(onUpload.status).toBe("quiet");

    const cache = newCache();
    cache.consistency.set(asOf.toISOString().slice(0, 10), idle);
    const onSchedule = await consistencyRule(ctx({ cache, activityId: null }));
    expect(onSchedule.status).toBe("fired");
  });

  it("escalates from notable to warning at four weeks idle", async () => {
    const at = async (days: number) => {
      const cache = newCache();
      cache.consistency.set(asOf.toISOString().slice(0, 10), {
        ...base,
        daysSinceLast: days,
        sessionsLast7: 0,
      });
      return consistencyRule(ctx({ cache, activityId: null }));
    };
    expect((await at(21)).severity).toBe("notable");
    expect((await at(28)).severity).toBe("warning");
  });

  it("is ineligible before any activity exists", async () => {
    const cache = newCache();
    cache.consistency.set(asOf.toISOString().slice(0, 10), {
      ...base,
      daysSinceLast: null,
      lastDate: null,
    });
    const r = await consistencyRule(ctx({ cache }));
    expect(r.status).toBe("ineligible");
  });
});

describe("efficiencyRule", () => {
  const point = (date: string, index: number) => ({
    id: 1,
    date,
    distanceKm: 5,
    speedMps: 2.3,
    avgHr: 180,
    index,
  });

  it("stays dormant below the minimum sample and says what would unlock it", async () => {
    const cache = newCache();
    cache.efficiency = [
      point("2026-05-01", 0.018),
      point("2026-05-08", 0.018),
      point("2026-05-15", 0.019),
    ];
    const r = await efficiencyRule(ctx({ cache }));
    expect(r.status).toBe("ineligible");
    expect(r.eligibility.have).toBe(3);
    expect(r.eligibility.need).toBe(DEFAULT_CONFIG.minEfficiencyRuns);
  });

  it("ignores runs later than the evaluation date", async () => {
    const cache = newCache();
    cache.efficiency = Array.from({ length: 10 }, (_, i) =>
      point(`2026-07-${String(i + 1).padStart(2, "0")}`, 0.018),
    );
    // asOf is 30 June, so none of the July runs may count.
    const r = await efficiencyRule(ctx({ cache }));
    expect(r.status).toBe("ineligible");
    expect(r.eligibility.have).toBe(0);
  });
});

describe("restingHrRule", () => {
  it("refuses when there aren't enough nights the watch was worn", async () => {
    const cache = newCache();
    cache.restingHr.set(asOf.toISOString().slice(0, 10), {
      recent: 62,
      nRecent: 1,
      baseline: 58,
      nBase: 11,
    });
    const r = await restingHrRule(ctx({ cache }));
    expect(r.status).toBe("ineligible");
    expect(r.eligibility.reason).toMatch(/worn to sleep/);
  });

  it("compares only overnight-worn readings", async () => {
    const cache = newCache();
    cache.restingHr.set(asOf.toISOString().slice(0, 10), {
      recent: 65,
      nRecent: 4,
      baseline: 58,
      nBase: 11,
    });
    const r = await restingHrRule(ctx({ cache }));
    expect(r.status).toBe("fired");
    expect(r.data.deltaBpm).toBe(7);
    // The tag matters: it is the record that this number isn't polluted by
    // daytime minima from nights the watch was off.
    expect(r.data.regime).toBe("overnight-worn-only");
  });
});
