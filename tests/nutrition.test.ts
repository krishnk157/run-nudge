import { describe, expect, it } from "vitest";

import { foodKey } from "@/lib/nutrition/foods";
import { shiftToDate } from "@/lib/time";
import { chatTools } from "@/lib/chat/aiTools";
import { chatSystem } from "@/lib/chat/prompt";
import { MIN_LOGGED_DAYS } from "@/lib/nutrition/summary";
import {
  FLAT_KG_PER_WEEK,
  MIN_PHASE_DAYS,
  MIN_PHASE_READINGS,
} from "@/lib/nutrition/body";

/**
 * Day 7's guardrails.
 *
 * The interesting invariants here are about *where numbers come from*, not
 * about arithmetic: a meal's calories must be reproducible, and the model must
 * be structurally unable to write a row or state a total.
 */

describe("food identity", () => {
  it("treats case and spacing as noise", () => {
    // This is the whole reproducibility guarantee in one assertion: if these
    // normalize differently, the same dish becomes two foods with two
    // compositions and the same plate produces two different totals.
    const variants = [
      "Chicken Biryani",
      "chicken biryani",
      "  chicken   biryani ",
      "CHICKEN BIRYANI",
    ];
    const keys = new Set(variants.map(foodKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("chicken biryani");
  });

  it("does not merge foods that genuinely differ", () => {
    // Deliberately stops short of stemming: preparation changes composition.
    expect(foodKey("grilled chicken")).not.toBe(foodKey("fried chicken"));
    expect(foodKey("whole milk")).not.toBe(foodKey("skimmed milk"));
  });
});

describe("propose_meal", () => {
  it("is the only nutrition tool, and it cannot write", () => {
    // The write path is a REST route the model has no access to. If a
    // save_meal tool ever appears here, the confirmation step has stopped
    // being structural and become a policy the model is asked to respect.
    const names = Object.keys(chatTools).sort();
    expect(names).toEqual(["propose_meal", "query_metrics", "render_chart"]);
    expect(names).not.toContain("save_meal");
    expect(names).not.toContain("log_weight");
  });

  it("asks for grams and composition, never for a total", () => {
    const shape = JSON.stringify(
      chatTools.propose_meal.inputSchema,
      (_k, v) => (typeof v === "bigint" ? String(v) : v),
    );
    // The model supplies quantity and per-100g composition; kcal and protein
    // for the meal are multiplied out of stored rows in SQL.
    expect(shape).toContain("grams");
    expect(shape).toContain("kcalPer100g");
    expect(shape).not.toMatch(/"totalKcal"|"mealKcal"|"totalProtein"/);
  });

  it("tells the model the totals are not its to state", () => {
    const d = chatTools.propose_meal.description ?? "";
    expect(d).toMatch(/does NOT save/i);
    expect(d).toMatch(/do not state calorie or protein totals yourself/i);
    expect(d).toMatch(/same dish always produces the same numbers/i);
  });

  it("forbids dietary advice and calorie targets at the tool boundary", () => {
    // Stated in the tool description as well as the system prompt, because the
    // description is what travels with the tool if the prompt is ever rewritten.
    const d = chatTools.propose_meal.description ?? "";
    expect(d).toMatch(/never give dietary advice/i);
    expect(d).toMatch(/calorie target/i);
  });
});

describe("chat contract, extended for nutrition", () => {
  it("states there is no calorie target to work from", () => {
    expect(chatSystem("2026-08-23")).toMatch(/no calorie target for this athlete/i);
    expect(chatSystem("2026-08-23")).toMatch(/do not invent one/i);
  });

  it("carries dietary advice into the same prohibition as training advice", () => {
    expect(chatSystem("2026-08-23")).toMatch(/training, dietary, or medical advice/i);
  });

  it("describes meal totals as computed, not stored", () => {
    const d = chatTools.query_metrics.description ?? "";
    expect(d).toMatch(/never stored — they are computed/i);
    expect(d).toContain("mi.grams / 100.0");
  });

  it("warns against fitting a weight trend across a phase boundary", () => {
    const d = chatTools.query_metrics.description ?? "";
    expect(d).toMatch(/NEVER average or fit a weight trend across a phase boundary/i);
  });

  it("says an unlogged day is not a fasted day", () => {
    const d = chatTools.query_metrics.description ?? "";
    // The same absence-vs-nonexistence rule as training, applied to food.
    expect(d).toMatch(/not logged.*not the same[\s\S]*not eaten/i);
  });
});

describe("the athlete's clock", () => {
  it("rolls the date over on their midnight, not UTC's", () => {
    // 00:12 IST is 18:42 UTC the previous day. The UTC date filed a meal to
    // yesterday, and nothing on screen would have shown it.
    const justAfterMidnightIST = new Date("2026-08-22T18:42:00Z");
    expect(shiftToDate(justAfterMidnightIST, 0)).toBe("2026-08-22");
    expect(shiftToDate(justAfterMidnightIST, 5.5 * 3600)).toBe("2026-08-23");
  });

  it("handles offsets west of UTC too", () => {
    // 21:00 in Los Angeles is already tomorrow in UTC — the same bug mirrored.
    const eveningInLA = new Date("2026-08-23T04:00:00Z");
    expect(shiftToDate(eveningInLA, 0)).toBe("2026-08-23");
    expect(shiftToDate(eveningInLA, -7 * 3600)).toBe("2026-08-22");
  });
});

describe("gates", () => {
  it("requires a majority of the week to be logged before reporting a mean", () => {
    // 4 of 7. Below this the mean is a self-selected sample: people log the
    // meal they planned and forget the biscuit.
    expect(MIN_LOGGED_DAYS).toBeGreaterThanOrEqual(4);
    expect(MIN_LOGGED_DAYS).toBeLessThan(7);
  });

  it("requires enough weigh-ins, spread over enough days, to call a trend", () => {
    // Two readings a day apart can show any slope you like; day-to-day
    // fluctuation exceeds a week of real change.
    expect(MIN_PHASE_READINGS).toBeGreaterThanOrEqual(4);
    expect(MIN_PHASE_DAYS).toBeGreaterThanOrEqual(14);
  });

  it("has a dead band, so noise is not reported as a direction", () => {
    expect(FLAT_KG_PER_WEEK).toBeGreaterThan(0);
    expect(FLAT_KG_PER_WEEK).toBeLessThanOrEqual(0.2);
  });
});
