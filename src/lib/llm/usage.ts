import { sql } from "@/db/client";
import type { Role } from "./models";

export interface CallUsage {
  role: Role;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  steps?: number;
  ms?: number;
}

/**
 * Record one model call.
 *
 * Deliberately swallows its own errors. This is bookkeeping: a failure to
 * write a usage row must never take down a notification the athlete was
 * supposed to receive, or a question they were waiting on an answer to.
 */
export async function recordCall(u: CallUsage): Promise<void> {
  try {
    await sql`
      insert into llm_calls
        (role, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, steps, ms)
      values
        (${u.role}, ${u.model}, ${u.inputTokens}, ${u.outputTokens},
         ${u.cacheReadTokens ?? 0}, ${u.cacheWriteTokens ?? 0},
         ${u.steps ?? null}, ${u.ms ?? null})`;
  } catch {
    // Intentionally silent.
  }
}
