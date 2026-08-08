# RunNudge — Proactive Training Insights System

**Project plan (v2)** · *revised in place after Days 1–2 — see the ▸ notes*

> **How to read this document.** Original wording is preserved; revisions are marked
> `▸ Revised after Day N` and say what was assumed, what the data showed, and what changed.
> The assumptions that turned out wrong are as much a part of the story as the ones that held —
> a plan that looks correct in hindsight usually means nobody checked it against reality.
> Per-day detail lives in [DAY-1.md](DAY-1.md) and [DAY-2.md](DAY-2.md).

A proactive training-insights system over your own Strava + Garmin running data. The core feature: the system reacts to your runs as they happen — ingesting, analyzing, and notifying you with meaningful insights — something a chat session with Strava/Garmin MCPs connected to Claude structurally cannot do, because a chat session only acts when you open it and ask.

Secondary layer: a chat interface with tool-calling for on-demand questions, plus a dashboard.

---

## 1. The Core Idea (and why it beats "just connect the MCP to Claude")

Claude with Strava/Garmin MCPs answers questions when asked. This project inverts that: **the system initiates.** You finish a run, and within minutes you get a message like:

> "Weekly load is up 38% vs your 4-week average — third week of increases. Your last two easy runs also ran 10 bpm hotter than usual. Consider a down week."

No chat session can do this — it requires event-driven ingestion, persistent history, derived-state computation (training load, trends), and an outbound notification channel. That's the honest answer to "couldn't you just use the MCP?": a chat can retrieve; it cannot watch, accumulate, and initiate.

## 2. What It Does

**Proactive (core):**

- New run logged on Strava → webhook fires → system ingests, computes updated trends/load, and decides (via LLM) whether something is worth telling you
- Insight notifications: load spikes, pace/HR anomalies, streaks and milestones, week-over-week trend shifts, recovery flags (Garmin sleep/HRV context)
- Weekly summary message regardless of anomalies — a short LLM-written digest of the week's training

> **▸ Revised after Day 2 — insights are capability-gated.**
> This list assumed every insight type always has the data it needs. Measured over 85 days:
> sleep and HRV exist on 13% of them, all inside one four-week window, and Garmin's
> `hrv_status` is `NONE` throughout because the baseline was never established.
> Wearable use here is intermittent *by nature* — there will be tracking phases and
> non-tracking phases indefinitely.
>
> So each insight type carries a **data-sufficiency precondition**, and the engine runs only
> the rules currently eligible. Gated rather than cut, deliberately: a gated rule self-enables
> when wear resumes, with no code change. A third state is added alongside notify / stay-quiet —
> **"insufficient data"** — because silence that means *we don't know* must never be
> indistinguishable from silence that means *you're fine*. See [DAY-2.md](DAY-2.md) §7, §11.

**On-demand (secondary):**

- Chat with tool-calling: `query_metrics` (SQL), `render_chart` — Claude orchestrates which tools a question needs
- Dashboard: metric cards, trend charts, sync status

## 3. Key Architecture Decisions

| Decision            | Choice                                                                                             | Why                                                                                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core differentiator | Proactive event-driven analysis + notifications                                                    | The one capability chat-plus-MCP structurally lacks; makes the project's existence defensible in one sentence                                                                                                                              |
| RAG / vector store  | Dropped entirely                                                                                   | No text corpus (no run notes), and RAG is already demonstrated on the portfolio site. No Voyage, no pgvector.                                                                                                                              |
| Ingestion           | Direct Strava REST API (OAuth) + webhooks                                                          | Ingestion is deterministic system-to-system fetching with no LLM in the loop — MCP's value (LLM deciding when to use a tool) doesn't apply here. MCP servers are built to be called by an LLM in a chat client, not by a webhook receiver. |
| Garmin data         | Unofficial API (community library), daily metrics only                                             | Sleep, HRV, VO2max, training load enable recovery-aware insights. Flaky; fallback = Strava-only v1.                                                                                                                                        |
| LLM's role          | Two jobs: (1) decide if an event warrants a notification + write it; (2) orchestrate tools in chat | Deterministic code computes the numbers (load, trends, anomaly checks); the LLM judges significance and communicates. Numbers are never left to the LLM to calculate.                                                                      |
| Storage             | Postgres (Neon)                                                                                    | Persistent history + derived state is what enables proactivity; plain relational, no vector extension needed                                                                                                                               |
| Generation          | Claude (Anthropic API) via Vercel AI SDK                                                           | Existing credits; strong tool-calling; distinctive stack                                                                                                                                                                                   |
| Notifications       | Email first (simplest), Telegram bot as upgrade                                                    | WhatsApp API has approval friction; Telegram is free and instant; email works day one                                                                                                                                                      |

> **▸ Revised after Day 2 — two decisions restated, one added.**
>
> | Decision | Choice | Why |
> | --- | --- | --- |
> | Garmin data *(supersedes the row above)* | Python sidecar around `garminconnect`, isolated behind Postgres | The Node library was rejected on **data coverage, not auth**: it exposes sleep/HR/steps and no HRV, VO2max or training load — one of the four metric families this row depends on. Python's exposes all of them. |
> | Polyglot boundary *(new)* | Sidecar writes `daily_metrics`; the app never imports it, it never imports the app | A second language is justified only when isolated behind a durable interface and confined off the request path. The test: removing it must not require touching the app. Here it doesn't. |
> | Dedup strategy *(new)* | Exact provenance from Strava's `external_id`, not heuristic matching | The watch auto-pushes to Strava, so one run yields one activity carrying `garmin_ping_<garminActivityId>`. There are no duplicates to reconcile. |
>
> Also worth recording: `activities.raw` is a **lossless** archive (`z.looseObject`, not `z.object`).
> A validating parser between a source and its archive silently narrows the archive to whatever
> the validator already knows about — which defeats the entire purpose of keeping raw payloads.
> See [DAY-2.md](DAY-2.md) §2, §4.

## 3a. Naming and terminology (deliberate)

The project is **not** described as an "AI agent." The proactive pipeline is event-driven automation with a single LLM judgment step, not an autonomous multi-step loop. The chat layer's tool-calling is genuinely agentic in the modest sense, but that doesn't make the whole system an agent.

Accurate framings to use in the README and on a resume:

- "Proactive training insights system" / "event-driven training analysis"
- "LLM tool-calling and orchestration" (for the chat layer specifically)

Avoid: "AI agent," "AI coach" — the latter is also the crowded genre this project deliberately differs from (see §1).

If the LLM later gets genuine multi-step autonomy in the proactive path (deciding what to investigate, calling `query_metrics` repeatedly, then concluding), the "agent" label becomes honest — until then, it isn't.

## 4. Scope

### In scope (v1, ~1 week)

- Strava OAuth + full-history backfill into `activities` table ✅ *Day 1*
- Garmin daily metrics into `daily_metrics` table; ~~dedup/reconciliation for dual-logged activities~~ ✅ *Day 2*
- Derived-state computation (deterministic code, not LLM): weekly mileage, acute:chronic load ratio, rolling pace/HR baselines, anomaly checks

> **▸ Revised after Day 2 — dedup struck; data-quality work added.**
> Dual-logged activities **do not occur** in this data, so there is nothing to reconcile
> (see the §3 addendum). Replaced by provenance columns and, in its place, work the plan
> didn't anticipate: **regime-aware baselines**. Resting HR averages 58.8 bpm on nights the
> watch was worn and 68.5 when it wasn't — present, numeric, and wrong in a way no null check
> catches. A baseline spanning both regimes would read a return to consistent wear as a
> ~10 bpm fitness gain that is purely a measurement artifact.
- Webhook receiver → async pipeline: ingest → recompute → LLM significance judgment → notification
- Notification channel (email or Telegram) with LLM-written insight messages
- Weekly digest (scheduled job)
- Chat with tool-calling (`query_metrics`, `render_chart`) + dashboard
- Deployed on Vercel, live webhook registered

### Stretch

- Telegram two-way: reply to a notification with a question, answered by the same tool-calling layer
- Multimodal route-image queries
- Small eval set for notification quality (does it flag real anomalies, stay quiet otherwise)

### Out of scope

- Multi-user product, coaching plans, medical advice, monetization
- RAG / embeddings / vector search — deliberately

## 5. Day-Wise Plan

### Day 1 — Ingestion foundation

- Strava developer app + OAuth flow (authorize → callback → token exchange → refresh handling)
- Neon Postgres; `activities` table (+ raw JSON column); normalization layer
- Backfill script: full run history into DB
- **Outcome:** entire Strava history in your own DB, tokens refreshing properly

> **▸ Day 1 — done (2026-08-05).** 28 activities, 14 runs, 2026-01-24 → 2026-07-26.
> Idempotency verified on real data. Token refresh is **partially** verified: the mechanism
> works end to end, but Strava returned the same token because only the stored expiry had been
> tampered with, so the rotation branch remains unexercised. Two claims in that day's write-up
> were later found wrong — see [DAY-1.md](DAY-1.md) §6, §11 and [DAY-2.md](DAY-2.md) §2.

### Day 2 — Garmin + dedup

- Garmin unofficial API via community library; `daily_metrics` table (sleep, HRV, VO2max, training load)
- Dedup: timestamp + distance matching; per-field source-of-truth (Garmin wins HR, Strava wins activity record)
- **Outcome:** merged dataset; dual-logged run appears once
- **Risk:** likeliest day to slip. If >1 day, ship Strava-only and continue.

> **▸ Day 2 — done (2026-08-09), but not as designed.**
> The day was flagged as likeliest to slip, and it did — **on neither of the risks it named.**
> The unofficial API worked. What slipped were two unchecked assumptions:
>
> 1. **Dedup was unnecessary.** No dual-logging occurs. The planned timestamp+distance matcher —
>    tolerance windows, tie-breaking, GPS drift between sources — was replaced by one regex over
>    `external_id`. The stated outcome ("dual-logged run appears once") is unreachable because
>    the condition never arises.
> 2. **The recovery metrics are 13% covered.** 85 days synced; sleep and HRV on 11 of them,
>    none after 14 June, `hrv_status` `NONE` throughout.
>
> **Unplanned gain:** Garmin computes acute:chronic workload itself, retained on 72 days as a
> *reference implementation* to validate Day 3's own computation against. It also independently
> confirmed a Day 1 prediction: after the Mar–May layoff, the 5 July 10 km run scored
> **ACWR 4.8 / VERY_HIGH** with chronic load collapsed to 131 and readiness at **1/100**.

### Day 3 — Analysis engine (the brain, no LLM yet)

- Deterministic computations: weekly mileage aggregates, acute:chronic workload ratio, rolling 30-day pace/HR baselines per run type, personal records
- Anomaly rules: load jump thresholds, HR-above-baseline-at-same-pace, streak/milestone detection
- Run it over your historical data; sanity-check outputs against what you know about your own training
- **Outcome:** a `compute_insights(activity_id)` function returning structured findings (e.g., `{load_ratio: 1.38, hr_anomaly: true, ...}`) — correct on real history

> **▸ Revised after Day 2 — four additions before this day starts.**
>
> 1. **Rules declare their data requirements.** A rule is a computation *plus a precondition*
>    (HR-anomaly needs ≥N runs with HR in the window; sleep-debt needs ≥N valid nights). The
>    engine evaluates eligibility and runs only eligible rules, so findings must distinguish
>    *not triggered* from *not evaluated*.
> 2. **Baselines are regime-aware.** Filter resting HR to `valid_sleep = true`, or reset when
>    the regime changes; warm up again after a gap rather than letting the first day back set
>    the reference.
> 3. **ACWR needs a layoff rule** — a chronic-load floor, or suppression until the chronic
>    window is populated. Garmin's 4.8 on 5 July is the concrete case to design against, not a
>    hypothetical.
> 4. **Validate our ACWR against `garmin_acwr`** on the 72 days holding both. This is a
>    cross-check, not ground truth — Garmin's exact formula is undocumented and unverified.
>
> Also carried forward: only **5 of 14 runs have heart-rate data**, so HR-based rules stay
> gated for now regardless of Garmin wear.

### Day 4 — Event pipeline + LLM judgment

- Strava webhook subscription; receiver route with validation; async processing (fetch → normalize → ~~dedup~~ → recompute)
- LLM significance layer: findings JSON → Claude decides notify-or-not and writes the message (system prompt tuned for "quiet unless it matters" — notification fatigue kills the product)

> **▸ Revised after Day 2.** The `dedup` step is struck — ingestion is a single idempotent
> upsert on Strava's activity id, which is what makes at-least-once webhook delivery safe.
>
> The significance prompt gets a second obligation beyond "quiet unless it matters": it must be
> told **which rules were ineligible and why**, so it never phrases an absent signal as a
> reassuring one. "Nothing unusual in your recovery data" is a false statement when there is no
> recovery data — and it's the same error as the resting-HR confound, one layer up.
>
> Note the webhook handler must **not** wait out a rate limit (the API client makes waiting
> opt-in per caller for exactly this reason): Strava expects a fast response and retries, and a
> serverless function that sleeps is billed until the platform kills it.
- Local testing via tunnel (ngrok-style)
- **Outcome:** simulated webhook event produces a sensible notification decision + drafted message end-to-end

### Day 5 — Notifications + weekly digest

- Email (Resend/similar) or Telegram bot delivery
- Scheduled weekly digest job (Vercel cron): week's stats → LLM-written summary → send
- Notification log table (what was sent, when, triggered by what — also your debugging trail)
- **Outcome:** real notification arrives on your phone/inbox from a real or simulated run event

### Day 6 — Chat + dashboard

- Vercel AI SDK chat route; tools: `query_metrics`, `render_chart`; citation of specific runs (date + id)
- Dashboard: metric cards, Recharts trends (pace, weekly mileage, HR drift), sync status panel
- **Outcome:** on-demand questions answered with text + charts, alongside the proactive layer

> **▸ Revised after Day 2 — the dashboard must surface rule eligibility.**
> A **data coverage panel** showing which insights are currently active and which are dormant
> for want of data. Without it, "no recovery flags this week" is ambiguous between *you're fine*
> and *the watch wasn't worn* — and the dashboard is where that ambiguity is cheapest to resolve.
> It doubles as the feedback loop that makes wearing the watch worthwhile: you can see what
> switches on.
>
> Charts must also not interpolate across gaps. A pace line that draws straight through a
> two-month layoff is asserting training that didn't happen.

### Day 7 — Deploy + polish

- Vercel deploy; re-register webhook against public URL; cron live
- Error/empty states; README with architecture diagram telling the "chat can't do this" story
- Test set: 8–10 chat questions + 3–4 simulated events with expected notification behavior
- **Outcome:** live system that messages you after your next real run — that moment is your demo

## 6. How We'll Build

Deliberately, in VS Code + Claude — every layer understood and owned, not generated wholesale:

- One scoped task per session; architecture and debugging discussion in chat, edits in the editor
- Each day ends with a working, tested slice
- The bar: able to defend every design decision in an interview

## 7. What This Achieves

### As a personal tool

- A training system that watches so you don't have to — insights arrive, you never have to remember to check
- Overtraining/anomaly flags grounded in your real baselines, not generic thresholds
- Weekly digest replacing manual Strava scrolling
- On-demand answers with exact aggregation (SQL, not LLM arithmetic)

### For your resume (honestly claimable once built)

- **Event-driven architecture:** webhook receiver → validation → async pipeline → downstream actions
- **LLM system design:** LLM as judgment layer over deterministic computation — deciding significance and communicating, never calculating; a defensible answer to "where should the LLM be in the loop?"
- **LLM tool-calling / orchestration:** multi-tool chat layer (SQL + chart tools), Vercel AI SDK
- **API integration:** OAuth token lifecycle, rate-limit-aware backfill, ~~two-source reconciliation/dedup~~ provenance-based deduplication
- **Scheduled + reactive workloads:** cron digests + webhook-triggered processing on serverless
- **Product judgment:** notification-fatigue tuning — knowing when an AI system should stay quiet

> **▸ Revised after Days 1–2 — what's actually claimable now.**
> "Two-source reconciliation" describes work that didn't happen, because the duplicates it
> targeted don't exist. What replaced it is stronger, because it's the part of the job that
> only shows up against real data:
>
> - **Data-quality engineering** — identified a measurement confound (resting HR varying ~10 bpm
>   with wear habits rather than fitness) and added explicit quality columns so downstream logic
>   can tell *absent* from *valid*.
> - **Capability-gated analysis** — insight rules with declared data preconditions and
>   regime-aware baselines, so the system degrades honestly through sensor gaps and recovers
>   automatically when data returns.
> - **Polyglot service boundaries** — a second language isolated behind a database table,
>   confined off the request path, with an explicit test for when that boundary is violated.
> - **Reverse-engineering undocumented APIs** — mapped nested, device-keyed payloads by
>   inspecting stored responses; corrected three mappings that produced plausible-but-wrong
>   values without ever raising.
> - **Validation against a reference implementation** — our acute:chronic ratio checked against
>   Garmin's on 72 overlapping days.
> - **Evidence-based dependency selection** — rejected the in-stack library on measured API
>   surface (1 of 4 required metric families) rather than convenience.
>
> The interview-grade framing for any of these is the **trade-off**, not the feature.
> "I kept the raw payloads" is a fact. "I kept them because I expected the schema to be wrong
> by Day 3, and re-fetching from a rate-limited API costs far more than disk — then the bug
> that broke that guarantee cost me an hour on Day 2" is an answer.

### Prior art to differentiate against

A common version of this project already exists publicly: Garmin data pulled into a dashboard with Claude answering "should I train today?" — one such build was done by a non-developer in ~90 minutes with Claude Code. That genre is **ask-based**: you open it and query.

Table stakes (don't lead with these): dashboard, chat over training data, load-ratio insight.

The differentiators here: push not pull (unprompted notifications), deterministic computation with the LLM restricted to judgment and phrasing, and the event-driven infrastructure (webhooks, async pipeline, ~~two-source dedup~~ provenance tracking, cron digests, notification tuning) that takes days rather than 90 minutes.

> **▸ Revised after Day 2 — a differentiator the plan didn't anticipate.**
> Handling **intermittent sensor availability** honestly. The 90-minute-build genre assumes the
> data is there; against real wear habits it either goes quiet without saying why, or reports
> confounded numbers as if they were measurements. Capability gating and regime-aware baselines
> are unglamorous and only surface once a system has run against messy real data — which is
> exactly why they're worth leading with.

### The one-line interview answer

"Claude with a Strava MCP can answer questions when you ask. My system watches every run as it happens, maintains derived training state, and tells me when something matters — retrieval versus initiative. I built the layer that turns tool access into a product."

## 8. Success Criteria

- A real run triggers ingestion + a correct notification decision within minutes, unattended
- Notification precision: flags genuine anomalies on historical replay, stays quiet on normal runs
- Chat answers aggregation questions exactly (verified against SQL by hand)
- ~~Dedup verified on dual-logged activities~~
- Live deployed URL + a notification screenshot for the README

> **▸ Revised after Day 2 — one criterion struck, three added.**
> "Dedup verified on dual-logged activities" is unmeasurable: no dual-logged activities exist.
> Replaced by criteria that test what the system actually has to get right:
>
> - **Provenance verified** — every Garmin-uploaded activity carries its parsed Garmin id
>   (currently 17/17), and one idempotent upsert serves both backfill and webhook paths.
> - **Graceful degradation** — replayed across the 14 June wear boundary, the engine reports
>   *insufficient data* for gated rules rather than firing on absent inputs or silently implying
>   normality.
> - **Baseline integrity** — a resting-HR baseline computed across the wear boundary does not
>   shift materially, proving it tracks the athlete rather than the measurement regime.
> - **ACWR agreement** — our computed ratio is compared against `garmin_acwr` on the 72
>   overlapping days, with disagreements explained rather than averaged away.

## 9. Risks

- **Garmin unofficial API** — undocumented, breaks periodically; fallback manual CSV or Strava-only v1
- **Webhook testing needs public URL** — tunnel locally (Day 4), deploy re-registration (Day 7)
- **Notification tuning is subjective** — expect iteration on the significance prompt after living with it for a week; that iteration itself is a good story
- **Vercel serverless limits** — long backfills may need chunking or a one-off local script rather than a serverless function

> **▸ Revised after Days 1–2 — how these actually played out, plus what wasn't on the list.**
>
> **Retired.** *Vercel serverless limits* — resolved by design: the backfill is a local script,
> checkpointed per page. *Garmin API breaking* — didn't happen; the risk that materialized was
> the **wrong library**, chosen on language convenience rather than measured API surface.
>
> **Still open.** Webhook public URL (Day 4/7). Notification tuning — now harder than stated,
> because the prompt must also handle "insufficient data" without making absence sound
> reassuring.
>
> **New, from actual experience:**
>
> - **Sparse data undermines personalized baselines.** 5 of 14 runs have HR; sleep and HRV cover
>   13% of days. Mitigated by gating, not by lowering thresholds until something fires.
> - **Silent correctness bugs.** Three separate ones so far — an archive column that quietly
>   stored a fifth of what it claimed, a login that reported success without completing, and a
>   metric read from the wrong subtree. **None raised. All produced plausible values.** The
>   recurring lesson: verify by inspecting stored data, not by the absence of an exception.
> - **The single-user assumption is load-bearing.** `daily_metrics` is keyed by date alone, and
>   the OAuth entrypoint is gated by one shared secret. Fine as scoped (§4 excludes multi-user)
>   — but it is an assumption, not an oversight, and worth naming as such in an interview.
> - **Garmin credentials sit in a local `.env` as a plaintext password**, because the unofficial
>   API has no OAuth. Acceptable for a single-user local tool; it would not be for anything
>   deployed multi-user, and that's the honest boundary of this design.
