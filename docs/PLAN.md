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

## 1a. Training context and goals

> **▸ Added after Day 2 (2026-08-09).** The plan was written as a *running* insights system.
> The actual training it has to serve is mostly not running, which changes what the analysis
> engine computes — though not the architecture.

**The athlete's training and goals, as stated:**

- 4–5 gym sessions per week (strength), tracked in Garmin's free strength-training mode
- Occasional weekend 5k runs
- **Goals:** improve VO2max and running pace
- Willing to log weight and calories

**What the data said when checked against that:**

| Fact | Consequence |
|---|---|
| Gym: **12.0 h** in 3 weeks vs running **9.3 h across 6 months** | Mileage-based load ignores most of the training |
| Running ≈ **1 × 5k per week** | ACWR over running alone is dominated by single sessions — this is how Garmin produced 4.8 VERY_HIGH from one 10k |
| VO2max **40.3 → 38.1** (May → Jul) | Trending *against* the stated goal; nothing in the original plan would have surfaced it |
| Runs average **183 bpm at ~7:20/km** | High cardiac cost for the pace — the quantity that maps to the goal is aerobic efficiency, not raw pace |

**Decisions taken (2026-08-09):**

1. **The system is modality-agnostic**, not running-specific. Load is computed across all
   activity types from heart rate / effort, not from distance. Running becomes one input.
2. **Body and nutrition data are logged in this app itself**, writing straight to Postgres —
   no dependency on another product's sync path. Height is captured once; weight is logged
   periodically; **meals are logged conversationally, by photo or text**.
3. **Progress photos are out of scope; food photos are in.** The distinction is whether the
   model is asked something it can actually do. Judging body composition from a physique photo
   is unreliable and would claim a precision the method lacks. Identifying "two rotis, dal,
   curd" from a plate is ordinary recognition, and — critically — its output is *checked by
   the user before it is saved*.
4. **No calorie target, and no dietary advice.** The system logs intake and shows it beside the
   weight trend. It does not compute a goal number, prescribe a deficit, or comment on what was
   eaten. This keeps §4's "no coaching plans, no medical advice" exclusion intact rather than
   quietly eroding it.
5. **Goal phases are dated state, not a setting.** The athlete alternates between bulking,
   cutting and maintaining, with **high protein constant across all of them** (stated
   2026-08-09). A `goal_phases` table records each phase with a start date; phases are appended,
   never overwritten.

> **▸ Why phases are the same problem as intermittent wear.**
> A bodyweight trend spanning a bulk and a cut is meaningless as a single slope — it averages
> two opposite intentions into a number describing neither. That is precisely the resting-HR
> confound again: **a series is only interpretable within one regime.** So weight is read
> against the phase in force at the time, and phase boundaries are drawn on the chart rather
> than smoothed over.
>
> This also makes the same observation mean different things without the system giving advice:
> gaining 1 kg during a declared bulk is on plan; gaining 1 kg during a declared cut is worth
> mentioning. The phase supplies the interpretation, so the system reports rather than
> prescribes.
>
> **Protein is phase-independent**, so it is a first-class tracked metric with its own readout
> — the one dietary quantity constant across every phase.

> **On the name.** "RunNudge" is now slightly inaccurate — it's a training system, not a
> running one. Cosmetic, and per §3a the rule here is that descriptions must be honest, so the
> README should say "training" even while the repo keeps its name.

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

> **▸ Revised after §1a — insight types, restated for the actual training mix.**
> "load spikes, pace/HR anomalies" assumed a runner. The set that serves the stated goals:
>
> - **Cross-modal load** — weekly training load across gym *and* runs, from HR/effort rather
>   than distance. At ~5 km/week, mileage is not a load measure.
> - **Aerobic efficiency trend** — pace at a given heart rate over months. This is the
>   quantity that actually tracks "improve VO2max and pace"; raw pace confounds effort with
>   fitness, and Garmin's VO2max estimate updates only after qualifying runs (5 values in
>   3 months).
> - **Strength progression** — volume (sets × reps × weight) and per-lift bests, from Garmin's
>   exercise-set data. Strava records only a duration for these sessions.
> - **Bodyweight trend** — from the app's own log, on a monthly rather than per-session cadence.
> - **Consistency and streaks** — already in the list, and the most actionable signal for
>   someone whose gym block stopped on 5 June.
>
> **Timescale note:** these goals resolve over *months*, but the proactive pipeline reacts per
> activity. Per-run reactions cannot report a VO2max trend without becoming noise. So the
> monthly cadence is a first-class reporting tier alongside the weekly digest — not an
> afterthought.

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

> **▸ Added after §1a — three more decisions.**
>
> | Decision | Choice | Why |
> | --- | --- | --- |
> | Load metric | Heart-rate / effort based, cross-modal | Distance measures one modality out of several. 12 h of gym vs 9.3 h of running makes a mileage-based load actively misleading, not merely incomplete. |
> | Body metrics | Manual entry in this app's own UI → Postgres | Garmin can store weigh-ins and nutrition, but only if food is logged in a third app that syncs. Owning the entry path removes a dependency whose failure mode is silent gaps. |
> | Progress photos | Out of scope | An LLM judging body composition from photos is unreliable. Shipping it would mean claiming a precision the method doesn't have — the same error as reporting confounded resting HR as a measurement. |
> | Meal logging | Conversational — photo or text, in the chat layer | The lowest-friction entry path that exists, and friction is the only thing that determines whether food logging survives past week two. |

> **▸ Added after §1a — the LLM's role, restated precisely.**
> §3 above says *"numbers are never left to the LLM to calculate."* Meal logging looks like a
> violation. It isn't, once the two halves are separated:
>
> | Step | Who does it | Why |
> | --- | --- | --- |
> | *What food is this, roughly what portion?* | **LLM (vision or text)** | Perception, not arithmetic. Nothing else can do it. |
> | *kcal and macros for that portion* | **`foods` table lookup** | Deterministic. Same input, same answer, every time. |
> | *Daily and weekly totals* | **SQL** | Arithmetic stays in the database. |
>
> So the model emits `{ item: "roti", count: 2, grams_each: 40 }` and never multiplies anything.
> The original principle is not weakened — it is stated more precisely: **the LLM may perceive
> and judge; it may not compute.**
>
> **The `foods` table learns.** The first time a food appears, the model estimates its per-100g
> values once, the user confirms, and it is stored. Subsequent meals are lookups. This matters
> for two reasons: re-asking a model the same question yields a different answer each time, so
> repeat meals would drift; and public nutrition databases (USDA, Open Food Facts) are thin on
> Indian food, which is most of what will be logged here.
>
> **Two honesty constraints.** Portion estimates from photos carry large error bars, so every
> quantity is **editable before saving** and the UI leads with the **weekly average** — the trend
> survives estimation noise, a single day does not. And an unconfirmed estimate is never counted.

## 3a. Naming and terminology (deliberate)

The project is **not** described as an "AI agent." The proactive pipeline is event-driven automation with a single LLM judgment step, not an autonomous multi-step loop. The chat layer's tool-calling is genuinely agentic in the modest sense, but that doesn't make the whole system an agent.

Accurate framings to use in the README and on a resume:

- "Proactive training insights system" / "event-driven training analysis"
- "LLM tool-calling and orchestration" (for the chat layer specifically)

Avoid: "AI agent," "AI coach" — the latter is also the crowded genre this project deliberately differs from (see §1).

If the LLM later gets genuine multi-step autonomy in the proactive path (deciding what to investigate, calling `query_metrics` repeatedly, then concluding), the "agent" label becomes honest — until then, it isn't.

## 4. Scope

### In scope (v1, ~~~1 week~~ 8 days)

- Strava OAuth + full-history backfill into `activities` table ✅ *Day 1*
- Garmin daily metrics into `daily_metrics` table; ~~dedup/reconciliation for dual-logged activities~~ ✅ *Day 2*
- Derived-state computation (deterministic code, not LLM): ~~weekly mileage~~ cross-modal load, acute:chronic load ratio, ~~rolling pace/HR baselines~~ regime-aware baselines, anomaly checks ✅ *Day 3*

> **▸ Revised after Day 2 — dedup struck; data-quality work added.**
> Dual-logged activities **do not occur** in this data, so there is nothing to reconcile
> (see the §3 addendum). Replaced by provenance columns and, in its place, work the plan
> didn't anticipate: **regime-aware baselines**. Resting HR averages 58.8 bpm on nights the
> watch was worn and 68.5 when it wasn't — present, numeric, and wrong in a way no null check
> catches. A baseline spanning both regimes would read a return to consistent wear as a
> ~10 bpm fitness gain that is purely a measurement artifact.

> **▸ Added after §1a — three items now in scope for v1.**
>
> - **Strength session detail** — pull Garmin's per-set data (`get_activity_exercise_sets`)
>   into a `strength_sets` table. Strava stores only a duration for a gym session, so without
>   this, 4–5 of 5–6 weekly sessions are opaque to the analysis engine.
> - **Body metrics** — `profile` (height, captured once), `body_log` (weight over time) and
>   `goal_phases` (bulk / cut / maintain, with start dates), entered through the dashboard.
> - **Conversational meal logging** — `foods`, `meals` and `meal_items` tables, plus a
>   multimodal path in the chat layer: photo or text → identified items → confirm → save.
>   Together with weight, the only user-input write paths in the system; everything else is
>   ingested.
> - **Monthly trend reporting** — a longer cadence than the weekly digest, because VO2max,
>   aerobic efficiency and bodyweight only become legible over months.
>
> **Explicitly out:** progress photos and any body-composition assessment from images; calorie
> targets; anything resembling dietary advice.
>
> **Multimodal is back, for a better reason.** The stretch item "multimodal route-image queries"
> is retired — it served no stated goal. Food photos replace it: the same capability, pointed at
> something the user will actually do daily.
>
> **Scope honesty:** nutrition is nearer a second product than a feature — three tables, a
> vision pipeline, a confirmation flow. It gets **its own day (§5, Day 7)** rather than being
> absorbed into Day 6, and deploy moves to Day 8. Approved 2026-08-09.
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

> **▸ Revised again after §1a — what Day 3 actually computes.**
> "Weekly mileage aggregates" and "rolling pace/HR baselines per run type" describe a running
> system. Replaced by:
>
> 1. **Cross-modal weekly load** from HR/effort across every activity type — the primary load
>    series, with mileage demoted to a running-specific detail.
> 2. **Aerobic efficiency** — pace at a reference heart rate per run, trended. The headline
>    metric for the stated goals, and computable on all 5 HR-bearing runs today.
> 3. **Strength volume and per-lift bests** from `strength_sets`.
> 4. **Consistency tracking** across modalities — sessions per week vs a trailing baseline.
>    The 5 June gym stop and the Mar–May running layoff are both in the historical data and
>    make good test cases.
>
> Note the sanity-check step matters more here than it did for running: cross-modal load
> means choosing how a 90-minute gym session at 127 bpm compares to a 37-minute run at 183 bpm.
> That weighting is a judgment call, and Garmin's own acute load on the same days is the
> reference to calibrate it against.

> **▸ Day 3 — done (2026-08-12).** `computeInsights(activityId)` returns structured findings
> from five capability-gated rules. Detail in [DAY-3.md](DAY-3.md).
>
> **Validated:** acute:chronic ratio against Garmin's own on 72 days, **r = 0.967**. We decline
> on 51 of them because Garmin reports a ratio even when its own chronic load has collapsed to
> zero — which is why the 5 Jul run reads *"first session in 28 days"* here rather than Garmin's
> **4.8 VERY_HIGH, readiness 1/100**. That contrast is the clearest single demonstration of what
> the engine is for.
>
> **Load is heart-rate based, as §1a required.** Strava's `suffer_score` was the obvious
> fallback for activities without HR and turned out to be present on exactly the 18 activities
> that already have HR — zero added coverage. The fallback is instead calibrated from the
> athlete's own measured sessions per sport, and every load carries the method used so rules
> never silently compare estimated against measured.
>
> **Three guards on ACWR, two of them unplanned.** Only the layoff guard was designed in
> advance. Replaying real history exposed the other two: at 4 sessions/28 days the engine
> emitted "ratio 1.86" then "0.33" on consecutive weekly runs, and a count-only rule let four
> sessions in five days score 4.0. *A count is not a distribution.*
>
> **Two additions the plan didn't ask for, both prompted by "how do we know these are valid?":**
>
> - **Threshold sensitivity sweep** (`npm run sensitivity`) — every threshold now lives in
>   `AnalysisConfig` labelled METHOD (a fact about the metric) or PREFERENCE (how quiet you want
>   the system), and is swept across both trigger paths. Verdict: **5 plateau, 5 cliff, 0 inert**.
>   `minChronicSessions = 8` is a genuine plateau across 7–10. The rest govern between 3 and 17
>   decisions each, so the sweep is largely reporting sample size — they are choices *made
>   explicit*, not choices justified, and should be re-swept as data accumulates.
> - **42 invariant tests** (`npm test`) — pinning the properties that must hold whatever the
>   thresholds are, including all three ACWR guards. Verified by sabotage: each fixed bug was
>   deliberately reintroduced to confirm the suite catches it. One test didn't, and was rewritten.
>
> **Deferred:** `strength_sets` ingestion. All 10 historical gym sessions return 404 for
> exercise sets — they predate the switch to strength mode. Garmin retains set data, so this can
> backfill once sessions exist; the rule ships correctly dormant until then.

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

> **▸ Added after §1a — the dashboard gains write paths, and chat gains a job.**
>
> **Weight** gets a small form: defaults to today, one tap to submit, trend shown immediately so
> the entry visibly earns its keep. Design for the failure mode that actually kills manual
> logging — forgetting — not for data richness.
>
> **Meals are logged in the chat layer**, not a form. Photo or text in, identified items back,
> edit the portions, save. This makes the chat surface load-bearing rather than secondary, which
> is a change from §2's original framing: chat is now the primary *input* path for nutrition
> while remaining secondary for questions.
>
> Charts follow the §1a metrics: cross-modal weekly load, aerobic efficiency, strength volume,
> bodyweight, and intake as a **weekly average** rather than daily totals.

### Day 7 — Nutrition + body composition

> **▸ Added 2026-08-09.** New day, not a squeeze into Day 6. It sits here because meal logging
> is conversational and therefore depends on Day 6's chat layer already existing.

- `profile` (height, once), `body_log` (weight over time), `goal_phases` (bulk / cut / maintain,
  append-only with start dates)
- `foods`, `meals`, `meal_items`; the `foods` table is written once per new food and read
  thereafter
- Multimodal logging in the chat route: photo or text → structured items → **confirm and edit**
  → save. The model emits `{item, count, grams}`; kcal and macros come from `foods` via SQL
- Weight form on the dashboard; protein and intake panels; phase boundaries drawn on the weight
  chart rather than smoothed across
- **Outcome:** photograph a plate, correct a portion, save it — and the weekly protein average
  moves. The same dish logged a week later produces the identical number, proving the
  arithmetic lives in the database and not in the model.
- **Risk:** confirm-before-save is right for accuracy and wrong for friction, and friction is
  the only thing that decides whether food logging survives past week two. If it lapses, the
  retreat is save-immediately-edit-later — not abandoning the feature.

### Day 8 — Deploy + polish

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
- **Multimodal structured extraction:** food photo → typed items → deterministic nutrition lookup, with a human confirmation step before anything is persisted
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

> **▸ Added after §1a — criteria tied to the stated goals.**
>
> - **Cross-modal load is not runnable-only** — a week of 4 gym sessions and no run produces a
>   non-trivial load figure. Under the original mileage-based design it would have read zero.
> - **Aerobic efficiency is computed and trended** on every HR-bearing run, and the VO2max
>   decline from 40.3 to 38.1 is visible in the system rather than something I found by hand.
> - **Strength volume tracked per session and per lift**, from Garmin's exercise sets.
> - **Manual logging survives a missed day** — a gap in weight entries degrades the trend
>   without breaking it, and is shown as a gap rather than interpolated.
> - **A meal photo becomes a saved, checked record** — items identified, portions edited,
>   totals computed by SQL from the `foods` table rather than asserted by the model.
> - **Repeat meals give repeat numbers** — the same dish logged twice a week apart produces
>   identical kcal, proving the `foods` table is doing the arithmetic and not the model.
> - **Nothing unconfirmed is ever counted** toward a daily or weekly total.

## 9. Risks

- **Garmin unofficial API** — undocumented, breaks periodically; fallback manual CSV or Strava-only v1
- **Webhook testing needs public URL** — tunnel locally (Day 4), deploy re-registration (Day ~~7~~ 8)
- **Notification tuning is subjective** — expect iteration on the significance prompt after living with it for a week; that iteration itself is a good story

> **▸ Added after Day 3 — the risk the register still doesn't name.**
> **Most thresholds cannot be validated at this data volume.** The sensitivity sweep found
> 5 of 10 sit on cliffs, not because they were chosen badly but because each governs only
> 3–17 decisions across 28 activities and 11 worn nights. That is a statement about sample
> size, not about the numbers.
>
> The mitigation is disclosure rather than confidence: thresholds are labelled METHOD or
> PREFERENCE, the sweep runs on demand, and `docs/DAY-3.md` records which single threshold is
> actually validated. **Being able to say which numbers are load-bearing and which are
> unverified assumptions is the deliverable** — a system whose arbitrary choices are labelled
> is defensible in a way that one whose choices are merely confident is not.
>
> Re-run `npm run sensitivity` as history accumulates. Cliffs flattening into plateaus is
> itself the evidence, and that transition is worth capturing when it happens.
- **Vercel serverless limits** — long backfills may need chunking or a one-off local script rather than a serverless function

> **▸ Revised after Days 1–2 — how these actually played out, plus what wasn't on the list.**
>
> **Retired.** *Vercel serverless limits* — resolved by design: the backfill is a local script,
> checkpointed per page. *Garmin API breaking* — didn't happen; the risk that materialized was
> the **wrong library**, chosen on language convenience rather than measured API surface.
>
> **Still open.** Webhook public URL (Day 4/8). Notification tuning — now harder than stated,
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
