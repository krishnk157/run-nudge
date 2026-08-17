# Day 4 — Event Pipeline + LLM Judgment

**Date:** 2026-08-17
**Plan reference:** [PLAN.md](PLAN.md) §5, Day 4 (as revised after Days 2–3)
**Stated outcome:** *"simulated webhook event produces a sensible notification decision + drafted message end-to-end"*
**Result:** Achieved. Three curated events from real history produced the three expected behaviors — spike → notify, quiet day → skip, comeback → notify with the honest framing. And the judge's rationale on its very first batch **found a real bug in the deterministic layer**.

This is the day the plan's core claim became executable: a run finishes, and the system — not the athlete — decides whether it's worth saying something.

---

## 1. The shape of the thing

```
Strava ──POST──▶ /api/strava/webhook ──200 within 2s──▶ (response sent)
                        │
                        └─ after() ──▶ processEvent()
                                          │ log raw event        → webhook_events
                                          │ fetch activity       (no rate-limit waiting)
                                          │ upsert               (same path as backfill)
                                          │ computeInsights()    (Day 3, deterministic)
                                          │ judgeInsights()      (claude-opus-5)
                                          └ record decision      → notifications
```

**Files:** [webhook route](../src/app/api/strava/webhook/route.ts) · [processEvent.ts](../src/lib/pipeline/processEvent.ts) · [judge.ts](../src/lib/llm/judge.ts) · [scripts/simulate.ts](../scripts/simulate.ts) · [scripts/webhook.ts](../scripts/webhook.ts)

---

## 2. The receiver: two timing rules shape everything

Strava's webhook contract imposes two constraints, and the entire route design falls out of them:

**The GET handshake must echo immediately.** When you subscribe, Strava GETs your callback with `hub.challenge` and expects it echoed back, gated by a shared verify token. Verified locally: correct token echoes, wrong token 403s.

**The POST must be acknowledged within 2 seconds.** Ingesting, computing insights, and calling Claude takes far longer than that. So the handler sends `200` first and runs the pipeline in Next's `after()` — a callback that executes once the response is on the wire. This is the "async processing" the plan required, without a queue: for a single-user system, deferred execution inside the same invocation is enough, and a real queue would be architecture for a scale that doesn't exist here.

**The counterintuitive choice: malformed bodies get a 200.** A 4xx tells Strava to retry — the same unparseable payload, again and again, until repeated failures disable the subscription entirely. Acknowledging garbage and logging it is the correct move when the alternative is the sender turning off the pipe.

**And a rule inherited from Day 1's design:** the pipeline calls the Strava client with rate-limit waiting *disabled*. The client's willingness to sleep out a 429 was made opt-in per caller precisely for this moment — a webhook handler that sleeps is a serverless function billed until the platform kills it.

---

## 3. Two audit tables, because the 200 already went out

Everything interesting happens *after* Strava has been told "received". If processing fails at that point, no one is waiting for the error — the only evidence is what got written down.

- **`webhook_events`** — every delivery verbatim, with `status` (processed / ignored / failed) and the error if any. At-least-once delivery means duplicates arrive; the idempotent upsert (Day 1's design, unchanged) makes them harmless, and this table makes them visible.
- **`notifications`** — every judgment, **including the withheld ones**. A `skip` row carries the model's rationale for staying silent. This is the mockup's "Withheld · nothing worth sending" entry, now real: quiet is only distinguishable from broken if silence leaves a row.

Event routing is deliberately narrow: deletes remove the local row; **updates re-ingest but are not judged** (a title edit on last month's run should not wake an LLM); athlete deauthorizations are logged and nothing more.

---

## 4. The judge: what an LLM is for in this system

PLAN §3 assigns the model exactly two jobs — decide significance, write the message — and §1a's revision sharpened the boundary: *the LLM may perceive and judge; it may not compute.* Day 4 implements that boundary as code:

**Input: the full findings report, ineligible rules included.** `buildJudgeInput()` serializes fired, quiet, ineligible, *and* error findings — with each ineligible rule's unlock condition (`have`/`need`/reason). This is the honesty constraint made mechanical. A judge that only saw fired findings would eventually write "recovery looks fine" on a day with no recovery data, because it couldn't know the difference.

**The system prompt encodes the product judgment**, not just formatting rules:

- *Quiet unless it matters* — "Every message that wasn't worth sending teaches the athlete to ignore the one that is. Default to silence."
- *The honesty rule* — never present an unevaluated rule as checked-and-fine; at most one dormant-rule unlock line, and never as the main content.
- *Numbers are quoted, never derived* — every figure must appear verbatim in the findings; if it isn't there, write the message without it.
- *No prescriptions* — it may say what a number means; it may not say what to do about it. (PLAN §4 excludes coaching, and a notification is exactly where prescription would creep in.)

**Output: structured JSON**, enforced by the API (`output_config.format` with a strict schema), not by parsing hope. `{notify, severity, subject, message, rationale}`.

**Every failure degrades to silence, and says so.** A model refusal, unparseable output, or `notify: true` without a message all produce a skip with a `degraded` marker in the log. The failure policy is a product decision: for a notification system, the safe failure is saying nothing — a missed notification costs little; a broken or hallucinated one costs trust.

The `rationale` field deserves its own note. It's never shown to the athlete — it exists purely as the tuning trail for the significance prompt (PLAN §9 expects iteration there). It earned its keep faster than expected; see §6.

---

## 5. The simulation: three cases with known right answers

`npm run simulate` pushes three real activities from history through the full pipeline. Each was chosen because Day 3's replay established what *should* happen:

| Case | Engine state | Judge's verdict |
|---|---|---|
| **1 Jun** — gym block peak | ACWR fired: ratio 1.51 | **notify** (notable) — quoted 1.51, acute 44.5 / chronic 29.4 verbatim; framed the thin 3-week baseline honestly |
| **3 Jun** — mid-block day | All eligible rules quiet | **skip** — rationale: "they trained today… mentioning [ineligible rules] would either be false reassurance or a nag with no actual finding to attach it to" |
| **5 Jul** — comeback run | ACWR *refused*; consistency fired: first session in 28 days | **notify** — and this is the case that matters |

The comeback message, verbatim:

> *"Today's session is your first in 28 days. With just 1 session in the last 28 days, there isn't enough recent training behind it to form a baseline, so the acute-to-chronic load check couldn't be evaluated at all this week — worth knowing as you ramp back up. If you wear the watch overnight, resting-HR drift becomes available again after 3 nights."*

Compare Garmin's verdict on the same run: **ACWR 4.8, VERY_HIGH, readiness 1/100**. The full chain held end-to-end: the engine declined to compute a meaningless ratio, and the judge — which could see the suppressed ratio of 4 in the debugging data — *explicitly refused to quote it*, saying in its rationale that "citing its internals would imply it was evaluated." The honesty constraint survived contact with a model that had the tempting number right in front of it.

Also honest to record: on a re-run, the comeback case notified again but at `warning` instead of `notable`. The decision is stable; the severity wobbles. That nondeterminism is worth knowing about before Day 8's eval set treats severity as a pass/fail criterion.

**Cost per judgment:** ~900 input / 250–950 output tokens — roughly 1–3 cents per event at Opus pricing. At one run a week, the judge costs less per month than a coffee.

---

## 6. The judge found a bug in the engine

The day's best moment wasn't planned. The quiet-case rationale from the first simulation batch:

> *"…resting HR drift oddly ineligible despite have=6 >= need=3 which looks like a threshold/logic quirk worth flagging internally but not to the athlete."*

It was right. The rule declines on either of two conditions — too few *recent* worn nights, or too few *baseline* nights — but the eligibility payload always reported the recent dimension. When the baseline was what failed, the finding showed `have=6, need=3`: numbers that look satisfied. A reporting bug in Day 3's code, sitting in plain sight since the two-condition guard was written.

Three things worth taking from this:

1. **It's the sixth silent bug of the project, and the same signature as the other five** — nothing threw, the output was plausible, and only a consumer that actually *read* the numbers noticed the contradiction.
2. **The LLM caught it because it was given debugging-grade input and a place to be candid.** The rationale field was designed as a tuning trail; it turned out to also be a second reviewer that reads every findings report with fresh eyes. That's an emergent property of passing rich, honest input to the judgment layer rather than a pre-digested summary.
3. **The fix keeps the correction honest**: the eligibility now reports whichever dimension failed, with a regression test pinning both directions ([rules.test.ts](../tests/rules.test.ts)) — and the judge no longer flags a contradiction on re-run.

Also fixed en route: the output schema initially expressed the nullable severity enum as `type: ["string","null"]` with `null` in the enum list — structured outputs rejects that; the union must be `anyOf`. Caught immediately because the API 400s rather than accepting it silently. A loud failure, for once.

---

## 7. What was verified, and what wasn't

**Verified:**

| Check | Result |
|---|---|
| GET handshake echoes `hub.challenge` | ✓ local |
| Wrong verify token | 403 ✓ |
| Malformed POST body | 200, logged, not retried ✓ |
| Full pipeline on 3 curated events | expected decisions, honest framing ✓ |
| Verbatim-numbers rule | figures in messages match findings exactly ✓ |
| Suppressed-ratio temptation | refused, twice ✓ |
| Failure degradation paths | exercised by the schema 400 — failures landed as logged rows, pipeline survived ✓ |
| Judge input contract + prompt clauses | 8 tests ✓ (50 total) |

**Not verified — named plainly:**

- **A real webhook from Strava.** No public URL yet; the subscription script is written but unused. The GET/POST contract is implemented from Strava's spec, and specs and reality sometimes differ. Day 8's deploy re-registers against the production URL; a tunnel test before then is optional.
- **`after()` on Vercel.** It runs correctly in local dev; production serverless semantics (does the function stay alive long enough for a multi-second pipeline?) are asserted by Next's docs, observed by us nowhere. This is Day 8's first thing to watch.
- **Judgment quality beyond n=3.** Three curated cases prove the mechanism, not the tuning. The plan's stretch eval set (does it flag real anomalies and stay quiet otherwise, across many events) remains the right instrument, and severity nondeterminism (§5) belongs in its design.

---

## 8. Resume-defensible claims from Day 4

**Event-driven architecture** — webhook receiver honoring the sender's timing contract, deferred processing after response, at-least-once delivery made safe by idempotent ingestion, and an audit trail for everything past the acknowledgment.

**LLM as judgment layer over deterministic computation** — the plan's central design claim, now running: code computes every number, the model decides significance and phrasing, and the boundary is enforced by prompt contract, structured output schema, and tests.

**Honest-uncertainty prompting** — the model is shown what *couldn't* be evaluated and constrained from converting absence into reassurance; verified against the tempting counterexample.

**Failure-mode design for user-facing AI** — every degradation path (refusal, parse failure, inconsistent output) collapses to logged silence, chosen because the cost asymmetry of a notification system favors false quiet over false noise.

**LLM-as-monitor, incidentally** — a candid machine-readable rationale channel turned the judgment layer into a second reviewer of the system's own outputs, and it caught a real defect on its first day. The interview-grade framing: *"I logged the model's reasoning for tuning purposes, and it started catching my bugs."*

---

## 9. What Day 5 inherits

- `notifications` rows with `decision='notify'` and `status='drafted'` are the delivery queue — Day 5 sends them (email/Telegram) and flips status to `sent`.
- The scheduled path (`computeInsights(null)`) is built and judged the same way; Day 5's cron wires it up for the idle-nudge and weekly digest.
- The severity wobble (§5) argues for the digest and eval work treating `notify/skip` as the contract and severity as advisory.

**Commits:** `8b182f1` (pipeline + judge), `e0ffd44` (eligibility fix found by the judge) on `day4-event-pipeline`.
