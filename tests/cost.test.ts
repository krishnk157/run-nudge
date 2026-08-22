import { describe, expect, it } from "vitest";

import { costOf, isCacheable, MODELS } from "@/lib/llm/models";

/**
 * Cost arithmetic.
 *
 * This exists because the first version was wrong in a way that flattered the
 * result: it treated the AI SDK's `inputTokens` as the *uncached* count and
 * added the cache tokens on top, reporting a cached call as costing roughly
 * twice what it did. A measurement that is itself unmeasured is just a more
 * confident guess.
 */

describe("costOf", () => {
  it("does not double-count cached tokens", () => {
    // A real recorded call: 9,347 total input, of which 4,359 written and
    // 4,359 read back, leaving 629 uncached.
    const cost = costOf({
      model: "claude-sonnet-5",
      inputTokens: 9347,
      outputTokens: 417,
      cacheWriteTokens: 4359,
      cacheReadTokens: 4359,
    });
    const expected =
      (629 / 1e6) * 3 + (4359 / 1e6) * 3 * 1.25 + (4359 / 1e6) * 3 * 0.1 + (417 / 1e6) * 15;
    expect(cost).toBeCloseTo(expected, 8);
    // The bug produced ~2x. Pin the ceiling so it cannot come back.
    expect(cost).toBeLessThan(0.03);
  });

  it("prices an uncached call at the plain input rate", () => {
    expect(costOf({ model: "claude-sonnet-5", inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(3);
    expect(costOf({ model: "claude-opus-5", inputTokens: 0, outputTokens: 1e6 })).toBeCloseTo(25);
  });

  it("makes the first cached call dearer, not cheaper", () => {
    // Caching is a bet that the prefix gets reused. If it never does, it costs
    // 25% extra — which is why the judge does not set a breakpoint.
    const plain = costOf({ model: "claude-sonnet-5", inputTokens: 4000, outputTokens: 0 });
    const written = costOf({
      model: "claude-sonnet-5",
      inputTokens: 4000,
      outputTokens: 0,
      cacheWriteTokens: 4000,
    });
    expect(written).toBeGreaterThan(plain);
    expect(written / plain).toBeCloseTo(1.25, 4);
  });

  it("returns zero for a model it has no price for", () => {
    // Better a visible zero than a confident wrong number after a model swap.
    expect(costOf({ model: "gemini-3-flash", inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });
});

describe("cache minimums", () => {
  it("knows the chat prefix is cacheable on the chat model", () => {
    // Measured at 3,568 tokens. Sonnet's minimum is 1,024.
    expect(isCacheable(MODELS.chat, 3568)).toBe(true);
  });

  it("knows Haiku would silently not cache it", () => {
    // 4,096 minimum, and no error is raised when a prompt falls under it —
    // which is the reason chat is not on the cheapest model.
    expect(isCacheable("claude-haiku-4-5", 3568)).toBe(false);
  });

  it("would cache the judge prompt, which is exactly why it is not marked", () => {
    // 896 tokens clears Opus 5's 512 minimum, so `cache_control` here would be
    // honoured — and still never pay, because activities arrive hours apart
    // and an ephemeral cache lives five minutes. Cacheable is not the same
    // question as worth caching.
    expect(isCacheable(MODELS.judge, 896)).toBe(true);
  });

  it("keeps the judge on a model whose caveats survived the swap", () => {
    // Replaying a real stored report: Haiku kept the decision and dropped the
    // dormant-rule caveat; Sonnet kept a caveat and cost more than Opus.
    expect(MODELS.judge).toBe("claude-opus-5");
  });
});
