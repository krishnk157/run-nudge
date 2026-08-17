import Anthropic from "@anthropic-ai/sdk";

import type { Finding, InsightReport } from "@/lib/analysis/types";

/**
 * The LLM significance layer — the one place a model sits in the proactive
 * pipeline, doing exactly the two jobs the plan assigns it: decide whether
 * the findings warrant interrupting a person, and write the message if so.
 *
 * Everything numeric was computed upstream by deterministic code. The judge
 * quotes numbers; it never derives them. And it sees the *ineligible*
 * findings too, so it cannot phrase missing data as reassurance — "nothing
 * unusual in your recovery data" is a false statement on a day with no
 * recovery data.
 */

export const JUDGE_MODEL = "claude-opus-5";

export interface Judgment {
  notify: boolean;
  severity: "info" | "notable" | "warning" | null;
  subject: string | null;
  message: string | null;
  rationale: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Set when the model declined or the output was unusable — treated as skip. */
  degraded?: string;
}

/**
 * Stable system prompt (cacheable prefix); the per-event findings go in the
 * user turn. "Quiet unless it matters" is the product: every unnecessary
 * notification trains the athlete to ignore the next one.
 */
export const JUDGE_SYSTEM = `You decide whether a training-analysis finding is worth sending as a push notification to one athlete, and you write that notification when it is.

You are the judgment layer of a personal training monitor. Deterministic code has already analyzed the athlete's training history and produced structured findings. Your input is that findings report. You never compute, estimate, or adjust numbers — every figure in your message must appear verbatim in the findings. If a number you want isn't there, write the message without it.

# The bar for notifying

Notification fatigue kills this product. Every message that wasn't worth sending teaches the athlete to ignore the one that is. Default to silence.

Notify when a finding would change what a reasonable athlete does or pays attention to this week: a genuine load spike, a return after a long gap, a meaningful trend shift, a milestone. Stay quiet for: normal training, small fluctuations, findings the athlete already plainly knows (they know they ran today), or anything you would caveat into meaninglessness.

Rules with status "quiet" evaluated normally and found nothing remarkable. That is the system working, not a reason to write something anyway.

# Ineligible rules — the honesty constraint

Findings with status "ineligible" could NOT be evaluated — the data isn't there. Never present an ineligible rule as if it were checked and fine. Never write "recovery looks good" or "nothing unusual in your heart rate" when those rules were ineligible; that converts absence of data into false reassurance. You may mention what would unlock a dormant rule when it's genuinely useful (e.g. the athlete just restarted training and wearing the watch overnight would enable recovery insights), but at most one such line, and never as the main content.

Findings with status "error" are system defects, not insights. Never mention them to the athlete; note them in your rationale instead.

# Writing the message

- 2 to 4 sentences. Plain, direct, specific — a knowledgeable training partner, not a coach and not a cheerleader.
- Lead with the fact, then why it matters. No greetings, no emoji, no exclamation marks, no "keep it up".
- Quote numbers exactly as given, with their units. Round nothing.
- No medical advice and no training prescriptions. You may state what a number means ("chronic load has decayed, so this session registers as a spike"); you may not tell the athlete what to do about it beyond neutral framing like "worth knowing as you ramp back up".
- The subject line is at most 8 words, factual, no clickbait.

# Output

Respond with JSON only, matching the provided schema. When notify is false, set severity, subject, and message to null and explain the silence in rationale. The rationale is an internal debugging note, never shown to the athlete — be candid in it.`;

/** Compact serialization of the report — pure so tests can pin it. */
export function buildJudgeInput(
  report: InsightReport,
  trigger: string,
): string {
  const compact = {
    trigger,
    asOf: report.asOf,
    activityId: report.activityId,
    anchors: report.anchors,
    counts: report.counts,
    findings: report.findings.map((f: Finding) => ({
      rule: f.rule,
      status: f.status,
      severity: f.severity,
      statement: f.statement,
      data: f.data,
      ...(f.eligibility.eligible
        ? {}
        : {
            ineligible_reason: f.eligibility.reason,
            have: f.eligibility.have,
            need: f.eligibility.need,
          }),
    })),
  };
  return JSON.stringify(compact, null, 1);
}

const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    notify: { type: "boolean" as const },
    severity: {
      // Nullable enum: the API rejects null inside an enum whose type is
      // ["string","null"] — the union has to be expressed via anyOf.
      anyOf: [
        { type: "string" as const, enum: ["info", "notable", "warning"] },
        { type: "null" as const },
      ],
    },
    subject: { type: ["string", "null"] as const },
    message: { type: ["string", "null"] as const },
    rationale: { type: "string" as const },
  },
  required: ["notify", "severity", "subject", "message", "rationale"],
  additionalProperties: false,
};

let _client: Anthropic | null = null;
function client(): Anthropic {
  // Lazy so importing this module never demands the key (next build imports
  // every route). The SDK reads ANTHROPIC_API_KEY from the environment.
  _client ??= new Anthropic();
  return _client;
}

export async function judgeInsights(
  report: InsightReport,
  trigger: string,
): Promise<Judgment> {
  const response = await client().messages.create({
    model: JUDGE_MODEL,
    max_tokens: 8000, // thinking (on by default) + a small JSON object
    system: [
      {
        type: "text",
        text: JUDGE_SYSTEM,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: buildJudgeInput(report, trigger) }],
    output_config: {
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA,
      },
    },
  });

  const usage = {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };

  // Safety classifiers can decline with a 200 + stop_reason "refusal".
  // For a notification system the safe degradation is silence, logged as such.
  if (response.stop_reason === "refusal") {
    return {
      notify: false,
      severity: null,
      subject: null,
      message: null,
      rationale: "model declined the request (stop_reason: refusal)",
      degraded: "refusal",
      ...usage,
    };
  }

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(text) as Omit<
      Judgment,
      "model" | "inputTokens" | "outputTokens"
    >;
    // Belt and braces: a notify without a message is unusable — treat as skip.
    if (parsed.notify && (!parsed.message || !parsed.subject)) {
      return {
        ...parsed,
        notify: false,
        degraded: "notify_without_message",
        ...usage,
      };
    }
    return { ...parsed, ...usage };
  } catch {
    return {
      notify: false,
      severity: null,
      subject: null,
      message: null,
      rationale: `unparseable model output: ${text.slice(0, 200)}`,
      degraded: "parse_error",
      ...usage,
    };
  }
}
