import { tool } from "ai";
import { z } from "zod";

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
};
