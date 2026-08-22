import { anthropic } from "@ai-sdk/anthropic";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";

import { chatTools } from "@/lib/chat/aiTools";
import { chatSystem } from "@/lib/chat/prompt";
import { athleteToday } from "@/lib/time";
import { JUDGE_MODEL } from "@/lib/llm/judge";

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

  const result = streamText({
    model: anthropic(JUDGE_MODEL),
    // Per request, and on the athlete's clock: a module-level UTC date got
    // a meal filed to the wrong day twice over.
    system: chatSystem(await athleteToday()),
    messages: await convertToModelMessages(messages),
    tools: chatTools,
    stopWhen: stepCountIs(6),
  });

  // Surfacing the error text matters more than hiding it: a failed query the
  // model can read is one it can correct, and a silent failure just produces
  // a confident answer built on nothing.
  return result.toUIMessageStreamResponse({
    onError: (error) =>
      error instanceof Error ? error.message : String(error),
  });
}
