import { anthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";

import { chatTools } from "@/lib/chat/aiTools";
import { chatSystem } from "@/lib/chat/prompt";
import { athleteToday } from "@/lib/time";
import { MODELS } from "@/lib/llm/models";
import { recordCall } from "@/lib/llm/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Chat over the athlete's own data, on the AI SDK.
 *
 * `streamText` runs the tool loop and streams typed message parts to the
 * client, so the browser can render a tool call while it is still running
 * rather than waiting for a final answer. That matters here: the SQL being
 * run *is* the explanation, and an answer you can't check is one you have to
 * take on trust.
 *
 * `stopWhen: stepCountIs(6)` bounds the loop. A model that keeps querying
 * without concluding should stop and say so, not spend credits in a circle.
 */
export async function POST(req: Request) {
  let messages: UIMessage[];
  try {
    ({ messages } = (await req.json()) as { messages: UIMessage[] });
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  /*
   * The system prompt and tool definitions come to 3,568 tokens, and a single
   * question re-sends all of it on every step of the tool loop — write the
   * query, read the rows, then answer. Three to six identical prefixes,
   * seconds apart, is the exact shape prompt caching exists for: the first
   * step pays 1.25x to write it, every later step pays 0.1x to read it.
   *
   * The breakpoint goes on the system message, the boundary between what never
   * changes and what changes every turn. Putting it any later would cache the
   * conversation too, and the conversation is different each time.
   *
   * Worth stating what this does *not* do: chat is bursty, so a question asked
   * an hour after the last one still pays the write. This helps within a
   * question, not across a day.
   */
  const startedAt = Date.now();
  const result = streamText({
    model: anthropic(MODELS.chat),
    // The object form of `instructions` rather than a bare string, which is
    // what carries the cache breakpoint. (v7 renamed `system` to
    // `instructions` and now rejects system messages inside `messages`
    // outright — sending one is a prompt-injection surface, since anything
    // that reaches the messages array came in over the wire.)
    instructions: {
      role: "system",
      // Per request, and on the athlete's clock: a module-level UTC date got
      // a meal filed to the wrong day twice over.
      content: chatSystem(await athleteToday()),
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    messages: await convertToModelMessages(messages),
    tools: chatTools,
    stopWhen: stepCountIs(6),
    onFinish: ({ usage, steps }) => {
      void recordCall({
        role: "chat",
        model: MODELS.chat,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        steps: steps.length,
        ms: Date.now() - startedAt,
      });
    },
  });

  // Surfacing the error text matters more than hiding it: a failed query the
  // model can read is one it can correct, and a silent failure just produces
  // a confident answer built on nothing.
  return result.toUIMessageStreamResponse({
    onError: (error) =>
      error instanceof Error ? error.message : String(error),
  });
}
