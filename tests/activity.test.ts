import { describe, expect, it } from "vitest";

import { activityLabel } from "@/lib/chat/activity";

/**
 * The chat's "what is it doing" indicator.
 *
 * This is a small state machine over streamed message parts, which is exactly
 * the kind of thing that silently stops working when the SDK changes a part
 * shape — the UI keeps rendering, it just never says anything again.
 */

const assistant = (...parts: unknown[]) => [{ role: "assistant", parts }];
const tool = (type: string, state: string, input?: unknown) => ({
  type,
  state,
  input,
});

describe("activityLabel", () => {
  it("says something the moment a question is sent", () => {
    // The gap between submit and the first streamed byte is the longest
    // stretch with nothing on screen, and the one most likely to read as a
    // hang.
    expect(activityLabel([{ role: "user", parts: [] }], "submitted")).toBe(
      "Thinking",
    );
  });

  it("is silent when nothing is in flight", () => {
    expect(activityLabel(assistant({ type: "text", text: "done" }), "ready")).toBeNull();
    expect(activityLabel([], "error")).toBeNull();
  });

  it("names the tool being prepared", () => {
    expect(
      activityLabel(assistant(tool("tool-query_metrics", "input-streaming")), "streaming"),
    ).toBe("Writing a query");
    expect(
      activityLabel(assistant(tool("tool-propose_meal", "input-streaming")), "streaming"),
    ).toBe("Reading the meal");
  });

  it("prefers the model's own stated purpose while a query runs", () => {
    expect(
      activityLabel(
        assistant(
          tool("tool-query_metrics", "input-available", {
            purpose: "Finding your fastest 5k",
          }),
        ),
        "streaming",
      ),
    ).toBe("Finding your fastest 5k");
  });

  it("falls back to a generic label when there is no purpose", () => {
    expect(
      activityLabel(assistant(tool("tool-render_chart", "input-available", {})), "streaming"),
    ).toBe("Drawing the chart");
  });

  it("gets out of the way once words are arriving", () => {
    // Streaming prose is its own progress indicator; a spinner under it is
    // noise.
    expect(
      activityLabel(
        assistant(
          tool("tool-query_metrics", "output-available", {}),
          { type: "text", text: "Your fastest 5k was" },
        ),
        "streaming",
      ),
    ).toBeNull();
  });

  it("keeps talking between a finished tool call and the first word", () => {
    // The pause after rows come back but before the model starts writing is
    // real, and it used to be blank.
    expect(
      activityLabel(
        assistant(tool("tool-query_metrics", "output-available", {}), {
          type: "text",
          text: "",
        }),
        "streaming",
      ),
    ).toBe("Thinking");
  });

  it("tracks the latest tool when several have run", () => {
    expect(
      activityLabel(
        assistant(
          tool("tool-query_metrics", "output-available", {}),
          tool("tool-render_chart", "input-streaming"),
        ),
        "streaming",
      ),
    ).toBe("Preparing a chart");
  });

  it("does not report an unknown tool as idle", () => {
    // A tool added later must degrade to a generic label, not to silence.
    expect(
      activityLabel(assistant(tool("tool-something_new", "input-available", {})), "streaming"),
    ).toBe("Working");
  });
});
