import { tool } from "ai";
import { z } from "zod";

import { findFoods, foodKey } from "@/lib/nutrition/foods";
import { MAX_ROWS, queryMetrics, SCHEMA_DOC } from "./queryMetrics";

/**
 * Tools in AI SDK form.
 *
 * The guardrails live in `queryMetrics` rather than here on purpose: the
 * Postgres READ ONLY transaction is what actually protects the data, and it
 * shouldn't care which SDK is calling it. Swapping the framework must never
 * be able to swap out the safety.
 */

export const chatTools = {
  query_metrics: tool({
    description: `Run a read-only SQL query against the athlete's training database and get rows back.

Use this for any question about their training — it is the only way to see their data. Prefer one well-shaped query over several small ones. Results are capped at ${MAX_ROWS} rows, so aggregate in SQL rather than pulling raw rows and counting them yourself.

Only SELECT (or WITH ... SELECT) is permitted; a single statement, no semicolons. If a query errors, read the message and try a corrected one.

${SCHEMA_DOC}`,
    inputSchema: z.object({
      query: z.string().describe("A single read-only SQL SELECT statement."),
      purpose: z
        .string()
        .describe(
          "One short phrase describing what this query is for, shown to the user while it runs.",
        ),
    }),
    execute: async ({ query }) => queryMetrics(query),
  }),

  render_chart: tool({
    description: `Draw a chart from data you have already retrieved with query_metrics.

Use it when a shape is easier to see than to read — a trend over time, a comparison across weeks — not for two or three numbers, which belong in your prose.

Choose the type carefully:
- "bar" for counts or totals per period. Use this for anything where a zero period is meaningful, because bars show a zero and lines hide it.
- "line" for a continuous measure sampled over time (weight, VO2max).
- "scatter" for sparse points where the gaps between them matter and joining them would assert continuity that doesn't exist.

Never chart across a gap in a way that implies training happened. If the series has long gaps, prefer bar or scatter.`,
    inputSchema: z.object({
      title: z.string(),
      type: z.enum(["bar", "line", "scatter"]),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
      points: z
        .array(z.object({ x: z.string(), y: z.number() }))
        .describe("The data to plot, in order."),
    }),
    // Pure: the browser draws it. Keeping this free of data access means a
    // chart can never show figures that weren't first fetched and quoted.
    execute: async (spec) => ({ ok: true, ...spec }),
  }),

  /**
   * Turn a photo or a sentence into a meal draft. It does not save anything.
   *
   * Two deliberate constraints:
   *
   * 1. The model supplies `grams` and, for a food nothing has seen before, a
   *    composition per 100 g. It never supplies a meal's calories or protein —
   *    those are multiplied out of stored composition, in SQL, on save.
   *
   * 2. The lookup against `foods` happens *inside this tool*, not in the
   *    prompt. So a food the athlete has logged before comes back with its
   *    stored composition regardless of what the model would have guessed this
   *    time, and the draft the athlete confirms is the arithmetic that will be
   *    written. Asking the model nicely to reuse foods would work most of the
   *    time; this works every time.
   */
  propose_meal: tool({
    description: `Turn a described or photographed meal into a draft for the athlete to confirm. Use it whenever they tell you what they ate or send a picture of food.

This does NOT save anything — it produces a card the athlete edits and confirms. Say briefly what you saw and that they can correct the portions; do not state calorie or protein totals yourself, because the numbers are computed from stored food composition after they confirm.

For each item give a weight in grams — your best reading of the portion, which they will correct if it's wrong — and a short natural description of the amount ("2 eggs", "1 bowl") for the card.

Composition per 100 g is only used for foods not already in the athlete's food table; anything they have logged before keeps the composition already stored, so the same dish always produces the same numbers. Give your best estimate for the food as prepared.

Split a plate into its recognisable components rather than logging it as one thing, but don't invent detail you can't see — "chicken curry" is better than guessing three spices.

Never give dietary advice, a calorie target, or an opinion on whether the meal was a good idea. Log what was eaten.`,
    inputSchema: z.object({
      eatenOn: z
        .string()
        .describe("Date the meal was eaten, YYYY-MM-DD. Today unless they say otherwise."),
      loggedVia: z.enum(["photo", "text"]),
      note: z.string().optional().describe("Short label for the meal, e.g. 'lunch'."),
      items: z
        .array(
          z.object({
            name: z.string().describe("The food, as the athlete would name it."),
            grams: z.number().positive(),
            count: z
              .string()
              .optional()
              .describe("Natural description of the portion, e.g. '2 eggs'."),
            kcalPer100g: z.number().nonnegative(),
            proteinGPer100g: z.number().nonnegative(),
            carbsGPer100g: z.number().nonnegative(),
            fatGPer100g: z.number().nonnegative(),
          }),
        )
        .min(1),
    }),
    execute: async ({ eatenOn, loggedVia, note, items }) => {
      const known = await findFoods(items.map((i) => i.name));

      return {
        ok: true,
        eatenOn,
        loggedVia,
        note,
        items: items.map((i) => {
          const stored = known.get(foodKey(i.name));
          return {
            name: stored?.name ?? i.name,
            grams: i.grams,
            count: i.count,
            // Stored composition wins. This is the line that makes the same
            // dish reproduce exactly, and it is enforced here rather than
            // requested in the prompt.
            composition: stored
              ? {
                  kcalPer100g: stored.kcalPer100g,
                  proteinGPer100g: stored.proteinGPer100g,
                  carbsGPer100g: stored.carbsGPer100g,
                  fatGPer100g: stored.fatGPer100g,
                }
              : {
                  kcalPer100g: i.kcalPer100g,
                  proteinGPer100g: i.proteinGPer100g,
                  carbsGPer100g: i.carbsGPer100g,
                  fatGPer100g: i.fatGPer100g,
                },
            known: Boolean(stored),
            source: stored?.source ?? "model",
          };
        }),
      };
    },
  }),
};
