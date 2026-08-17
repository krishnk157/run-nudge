# Day 5 — Notifications + Weekly Digest

**Date:** 2026-08-17
**Plan reference:** [PLAN.md](PLAN.md) §5, Day 5
**Stated outcome:** *"real notification arrives on your phone/inbox from a real or simulated run event"*
**Result:** Achieved. A stored activity went through the full pipeline and a message landed on the phone — `judged: notify · sent`. The weekly digest sent too, on an empty week, and refused to pretend otherwise.

This is the day the system stopped talking to a database and started talking to a person.

---

## 1. The shape of the thing

```
webhook / simulate ──▶ processEvent ──▶ judge ──▶ notifications(drafted)
                                                        │
                                                        ├─ inline send ──▶ Telegram
                                                        │   (fails → send_failed)
                                                        ▼
cron /api/cron/deliver (hourly)  ── requeue + sweep ────┘

cron /api/cron/digest (weekly) ──▶ weekStats (SQL) + findings ──▶ LLM ──▶ Telegram
```

**Files:** [types.ts](../src/lib/notify/types.ts) · [telegram.ts](../src/lib/notify/telegram.ts) · [deliver.ts](../src/lib/notify/deliver.ts) · [digest.ts](../src/lib/llm/digest.ts) · [cron/auth.ts](../src/lib/cron/auth.ts) · [deliver route](../src/app/api/cron/deliver/route.ts) · [digest route](../src/app/api/cron/digest/route.ts) · [scripts/notify.ts](../scripts/notify.ts)

---

## 2. Telegram over email, and why the plan's default changed

PLAN §3 picked "email first (simplest), Telegram bot as upgrade". We inverted that, and the reason is the stated outcome itself: *a notification arrives on your phone*. Email arrives in an inbox you check; Telegram arrives as a push you don't. For a product whose entire claim is **push not pull**, the demo and the design should agree.

The practical case is just as strong: no domain verification, no sending reputation, no billing, and setup is two minutes in an app you already have. Email's "simplest" reputation assumes you skip the deliverability work — and skipping it is exactly how a notification silently lands in spam, which for this system is indistinguishable from the judge deciding to stay quiet.

Delivery still sits behind a `Notifier` interface, so this is a config choice rather than an architectural one. Adding Resend for the digest later is one more implementation, not a pipeline change.

---

## 3. Judgment and delivery are separate on purpose

The pipeline writes a `notifications` row *first*, then tries to send. That ordering is deliberate and carries three properties:

- **A send failure never re-judges.** Re-running the LLM on a Telegram outage would burn credits and could produce a different message for the same event.
- **A judgment is recorded even with no channel configured.** Before the bot existed, every judgment still landed in the table. The system's reasoning is never contingent on its mouth working.
- **Retry is bounded by age.** `requeueFailed(24)` resurrects failed sends for a day, then stops — a notification about last week's run is no longer worth delivering, and retrying forever would eventually push something stale and confusing.

**Notify rows send inline from the webhook**, not on the next cron tick. The plan's promise is a message minutes after the run; an hourly sweep would make it "sometime this hour". The sweep exists for the unhealthy cases only — Telegram down, deploy mid-flight, credentials missing — which is why on a healthy day it correctly reports doing nothing.

---

## 4. The digest degrades in the opposite direction to alerts

Day 4 established: every judge failure collapses to **silence**, because a missed notification costs little and a wrong one costs trust.

The digest inverts that. It is scheduled and expected, so silence looks like a broken cron. When the model refuses or returns unparseable output, `fallbackBody()` emits a deterministic summary from the SQL numbers — deliberately dull, but the cadence never stops.

Same failure surface, opposite correct answer, because the cost asymmetry is reversed. Worth stating explicitly, since "degrade to silence" would have been the easy consistency to reach for.

The digest also gets the honesty constraint, and it held unprompted on the first live run — an empty week:

> *"No sessions were recorded between 10 and 17 August, matching the prior week, which was also empty. It has now been 22 days since your last session on 26 July… **Most of the other checks stayed dormant this week for lack of data rather than because they came back clear.**"*

That last sentence is the whole architecture in one line, written by the model without being asked for it specifically.

---

## 5. Cron routes fail closed

Cron endpoints are public URLs that spend money — each digest is a model call. `authorizeCron` compares a Bearer token against `CRON_SECRET` in constant time, and **rejects everything when the secret is unset**.

Failing closed is the right default here: a cron that never fires is a visible problem someone notices, while an open endpoint that anyone can hammer to burn API credits is invisible until the bill arrives.

Verified locally: no header → 401, wrong secret → 401, correct secret → 200 with an honest `"telegram is not configured"` before the bot existed.

Schedule ([vercel.json](../vercel.json)): digest Mondays 12:00 UTC, delivery sweep hourly.

---

## 6. MarkdownV2 escaping is the thing that actually breaks Telegram

Telegram's MarkdownV2 reserves `_*[]()~`>#+-=|{}.!\` — and an unescaped one **400s the entire send**. Look at what this system's messages actually contain:

> *"Your load ratio is 1.51 — acute load 44.5 against a chronic baseline of 29.4."*

Three dots and a hyphen in one sentence. Every notification this product sends is full of reserved characters as a matter of course, so escaping isn't an edge case here — it's the common path. Pinned by test.

**And the first version of that test was decoration.** It asserted that `-` was escaped, but the fixture used an em dash (—), which isn't reserved — so `indexOf("-")` returned −1 and the assertion never ran the check it claimed to. Caught only because the assertion failed on the *lookup*, not the escaping. Same lesson as Day 3's mutation testing: a test that can't fail proves nothing, and here the failure was a single character wide.

---

## 7. What was verified

| Check | Result |
|---|---|
| Live Telegram send | ✓ message_id 4, reserved characters rendered correctly |
| Full pipeline → phone | ✓ 1 Jun spike: `judged: notify · sent` |
| Verbatim-numbers rule held on delivery | ✓ 1.51 / 44.5 / 29.4 quoted, none derived |
| Weekly digest, live | ✓ empty week reported plainly, honesty constraint held |
| Deterministic fallback | ✓ `--dry` path, no model call |
| Cron auth | ✓ 401 unset / 401 wrong / 200 correct |
| Unconfigured channel | ✓ reports "not configured", doesn't throw |
| Telegram API error + network failure | ✓ surfaced as delivery failure, not a crash |
| Tests | 57 passing (7 new) |

**Not verified:**

- **Vercel Cron actually firing.** The routes and schedule are correct by spec; nothing has run on Vercel because nothing is deployed. Day 8.
- **Retry-after-outage in the wild.** `requeueFailed` is unit-shaped logic exercised by an empty queue, not by a real Telegram outage.
- **Digest quality across varied weeks.** n=1, and that one was empty. The interesting case — a busy week with a real trend — hasn't happened yet because training stopped on 26 July.

That last one is worth stating plainly: the digest has never summarized an actual training week. It handled the empty case well, which is the harder case for honesty but the easier one for prose.

---

## 8. Resume-defensible claims from Day 5

**Reactive + scheduled workloads on one pipeline** — inline delivery for immediacy, cron sweep for resilience, weekly cron for cadence; all writing to one audit table.

**Failure-mode design with asymmetric costs** — alerts degrade to silence, digests degrade to deterministic output. The same failure, two opposite correct answers, each argued from what the failure costs.

**Fail-closed authentication on money-spending endpoints** — constant-time comparison, unset secret rejects rather than opens.

**Channel abstraction** — delivery behind an interface so the product decision (Telegram vs email) doesn't reach into the pipeline.

**Honest-uncertainty prompting, generalized** — the constraint written for per-event alerts transferred to the digest and held on the first live run without additional prompting.

---

## 9. What Day 6 inherits

- `notifications` now carries `channel`, `external_id`, `sent_at` — the dashboard's notification feed reads directly from it, including the withheld rows.
- The digest's `weekStats()` is already the shape a dashboard's "this week" panel wants; reuse it rather than re-querying.
- Day 6's chat layer and this day's judge share a model client and a system-prompt style — the "quote numbers, never compute" rule should carry over to `query_metrics` verbatim.

**Commit:** `6889544` on `day5-notifications`.
