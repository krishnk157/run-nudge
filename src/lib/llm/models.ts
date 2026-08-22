/**
 * Which model does which job, and what it costs.
 *
 * Three roles, three shapes of work, and until now all three ran on the most
 * expensive model available — which was a default rather than a decision.
 *
 * The obvious move was to tier everything down. Measuring first said otherwise
 * for two of the three, so what follows is what the numbers actually showed
 * rather than what seemed likely beforehand.
 *
 *   judge   ~20 calls a month, one per activity. At Opus that is about
 *           $0.02 a call — roughly $0.40 a month, which is not a cost problem
 *           and never was. Replaying a real stored report through the cheaper
 *           models showed what tiering would have bought:
 *
 *             opus-5    $0.0195  quoted the numbers, explained *why* the ratio
 *                                was elevated, and volunteered the dormant
 *                                rule — "resting HR drift can't be assessed
 *                                yet: 8 recent worn nights but only 1 in the
 *                                baseline period"
 *             sonnet-5  $0.0280  correct, kept a baseline caveat, dropped the
 *                                dormant rule — and cost MORE than Opus, on
 *                                more output tokens
 *             haiku-4.5 $0.0028  correct decision and correct figures, no
 *                                caveat at all, and drifted toward advice
 *                                ("worth monitoring as you continue to build")
 *
 *           Saving $0.35 a month by dropping the one behaviour the whole
 *           system is built around is a bad trade. The judge stays on Opus.
 *
 *   digest  Four calls a month. Same argument, more so.
 *
 *   chat    The only role with real volume, and the only one where the saving
 *           is worth having: a 3,568-token static prefix re-sent on every step
 *           of a 3-6 step tool loop. Sonnet with that prefix cached runs about
 *           $0.026 a question against Opus's $0.057, and the honesty
 *           constraint was re-checked on Sonnet before the switch.
 *
 * Every value is overridable by environment variable, so trying a different
 * model on the deployed system is a config change and not a release.
 */

export type Role = "judge" | "digest" | "chat";

/**
 * Minimum prompt length before Anthropic will cache at all, per model. Below
 * it, `cache_control` is silently ignored — no error, no caching, and no way
 * to tell from the response that nothing happened.
 *
 * This is why chat is not on Haiku: at 4,096 the 3,568-token prefix falls
 * under the line, and the cheaper model would cost more per question than the
 * dearer one with its prefix cached.
 */
export const CACHE_MINIMUM_TOKENS: Record<string, number> = {
  "claude-opus-5": 512,
  "claude-sonnet-5": 1024,
  "claude-haiku-4-5": 4096,
};

/** List price, US dollars per million tokens. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const MODELS: Record<Role, string> = {
  // Not tiered down, on the evidence above: cheaper models kept the decision
  // and lost the caveat, which is the part worth paying for.
  judge: process.env.JUDGE_MODEL ?? "claude-opus-5",
  // Weekly. Four calls a month is not where the money is.
  digest: process.env.DIGEST_MODEL ?? "claude-opus-5",
  // Interactive, multi-step, and the surface that reads photographs. The one
  // role where volume makes the price worth optimising.
  chat: process.env.CHAT_MODEL ?? "claude-sonnet-5",
};

/**
 * Whether a prompt of this size can be cached on this model.
 *
 * Used to decide whether to *ask* for caching rather than asking always: a
 * cache write costs 1.25x base input, so marking a prompt that will never be
 * read back is a small permanent surcharge for nothing.
 */
export function isCacheable(model: string, promptTokens: number): boolean {
  const key = Object.keys(CACHE_MINIMUM_TOKENS).find((k) => model.startsWith(k));
  return key ? promptTokens >= CACHE_MINIMUM_TOKENS[key] : false;
}

export function priceFor(model: string) {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : null;
}

/**
 * Dollar cost of one call.
 *
 * Cache writes bill at 1.25x input and cache reads at 0.1x, so a cached call
 * is not simply "cheaper" — the first one is dearer. Anything claiming caching
 * paid for itself has to account for both.
 *
 * `inputTokens` is the AI SDK's **total**, which already includes the cached
 * tokens (the provider computes it as `noCache + cacheWrite + cacheRead`). The
 * first version of this function added the cache tokens on top of it and
 * reported a cached call as costing almost exactly twice what it did — a
 * measurement bug in the code whose entire job was to stop cost being guessed
 * at. The subtraction below is the fix; the test pins it.
 */
export function costOf(u: {
  model: string;
  /** Total input tokens, cached portions included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number {
  const p = priceFor(u.model);
  if (!p) return 0;
  const read = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, u.inputTokens - read - write);
  return (
    (uncached / 1e6) * p.input +
    (write / 1e6) * p.input * 1.25 +
    (read / 1e6) * p.input * 0.1 +
    (u.outputTokens / 1e6) * p.output
  );
}
