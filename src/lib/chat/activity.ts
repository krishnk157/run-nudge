import type { ToolUIPart } from "ai";

/**
 * What the model is doing right now, in words.
 *
 * A spinner says "wait"; this says what it is waiting *for*. That distinction
 * matters more here than in most chat UIs, because one question can take three
 * round trips — write SQL, run it, read the rows back — and several seconds can
 * pass with nothing on screen. Silence in that window reads as a hang.
 *
 * It lives outside the component so it can be tested without rendering one:
 * the interesting behaviour is a small state machine over streamed message
 * parts, and that is exactly the sort of thing that quietly stops working when
 * the SDK changes its part shapes.
 */

const WRITING: Record<string, string> = {
  "tool-query_metrics": "Writing a query",
  "tool-render_chart": "Preparing a chart",
  "tool-propose_meal": "Reading the meal",
};

const RUNNING: Record<string, string> = {
  "tool-query_metrics": "Querying your data",
  "tool-render_chart": "Drawing the chart",
  "tool-propose_meal": "Matching against your foods",
};

interface MessageLike {
  role: string;
  parts: unknown[];
}

/**
 * Returns null once text starts arriving — the words are their own progress
 * indicator, and leaving a "thinking" row underneath them is noise.
 */
export function activityLabel(
  messages: MessageLike[],
  status: string,
): string | null {
  if (status === "submitted") return "Thinking";
  if (status !== "streaming") return null;

  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return "Thinking";

  // Walk backwards: the most recent tool part is the one still in flight.
  for (let i = last.parts.length - 1; i >= 0; i--) {
    const p = last.parts[i] as ToolUIPart;
    if (typeof p.type !== "string" || !p.type.startsWith("tool-")) continue;
    if (p.state === "input-streaming") return WRITING[p.type] ?? "Preparing";
    if (p.state === "input-available") {
      // The model already wrote a human-readable purpose for the query; using
      // it beats a generic label, and it is the same string shown on the
      // collapsed tool row afterwards.
      const purpose = (p.input as { purpose?: string } | undefined)?.purpose;
      return purpose ?? RUNNING[p.type] ?? "Working";
    }
    break;
  }

  const streamingText = last.parts.some(
    (p) =>
      (p as { type: string }).type === "text" &&
      ((p as { text?: string }).text?.length ?? 0) > 0,
  );
  return streamingText ? null : "Thinking";
}
