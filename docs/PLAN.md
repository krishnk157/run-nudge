# RunNudge — Proactive Training Insights System

**Project plan (v2)**

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

## 3a. Naming and terminology (deliberate)

The project is **not** described as an "AI agent." The proactive pipeline is event-driven automation with a single LLM judgment step, not an autonomous multi-step loop. The chat layer's tool-calling is genuinely agentic in the modest sense, but that doesn't make the whole system an agent.

Accurate framings to use in the README and on a resume:

- "Proactive training insights system" / "event-driven training analysis"
- "LLM tool-calling and orchestration" (for the chat layer specifically)

Avoid: "AI agent," "AI coach" — the latter is also the crowded genre this project deliberately differs from (see §1).

If the LLM later gets genuine multi-step autonomy in the proactive path (deciding what to investigate, calling `query_metrics` repeatedly, then concluding), the "agent" label becomes honest — until then, it isn't.

## 4. Scope

### In scope (v1, ~1 week)

- Strava OAuth + full-history backfill into `activities` table
- Garmin daily metrics into `daily_metrics` table; dedup/reconciliation for dual-logged activities
- Derived-state computation (deterministic code, not LLM): weekly mileage, acute:chronic load ratio, rolling pace/HR baselines, anomaly checks
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

### Day 2 — Garmin + dedup

- Garmin unofficial API via community library; `daily_metrics` table (sleep, HRV, VO2max, training load)
- Dedup: timestamp + distance matching; per-field source-of-truth (Garmin wins HR, Strava wins activity record)
- **Outcome:** merged dataset; dual-logged run appears once
- **Risk:** likeliest day to slip. If >1 day, ship Strava-only and continue.

### Day 3 — Analysis engine (the brain, no LLM yet)

- Deterministic computations: weekly mileage aggregates, acute:chronic workload ratio, rolling 30-day pace/HR baselines per run type, personal records
- Anomaly rules: load jump thresholds, HR-above-baseline-at-same-pace, streak/milestone detection
- Run it over your historical data; sanity-check outputs against what you know about your own training
- **Outcome:** a `compute_insights(activity_id)` function returning structured findings (e.g., `{load_ratio: 1.38, hr_anomaly: true, ...}`) — correct on real history

### Day 4 — Event pipeline + LLM judgment

- Strava webhook subscription; receiver route with validation; async processing (fetch → normalize → dedup → recompute)
- LLM significance layer: findings JSON → Claude decides notify-or-not and writes the message (system prompt tuned for "quiet unless it matters" — notification fatigue kills the product)
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
- **API integration:** OAuth token lifecycle, rate-limit-aware backfill, two-source reconciliation/dedup
- **Scheduled + reactive workloads:** cron digests + webhook-triggered processing on serverless
- **Product judgment:** notification-fatigue tuning — knowing when an AI system should stay quiet

### Prior art to differentiate against

A common version of this project already exists publicly: Garmin data pulled into a dashboard with Claude answering "should I train today?" — one such build was done by a non-developer in ~90 minutes with Claude Code. That genre is **ask-based**: you open it and query.

Table stakes (don't lead with these): dashboard, chat over training data, load-ratio insight.

The differentiators here: push not pull (unprompted notifications), deterministic computation with the LLM restricted to judgment and phrasing, and the event-driven infrastructure (webhooks, async pipeline, two-source dedup, cron digests, notification tuning) that takes days rather than 90 minutes.

### The one-line interview answer

"Claude with a Strava MCP can answer questions when you ask. My system watches every run as it happens, maintains derived training state, and tells me when something matters — retrieval versus initiative. I built the layer that turns tool access into a product."

## 8. Success Criteria

- A real run triggers ingestion + a correct notification decision within minutes, unattended
- Notification precision: flags genuine anomalies on historical replay, stays quiet on normal runs
- Chat answers aggregation questions exactly (verified against SQL by hand)
- Dedup verified on dual-logged activities
- Live deployed URL + a notification screenshot for the README

## 9. Risks

- **Garmin unofficial API** — undocumented, breaks periodically; fallback manual CSV or Strava-only v1
- **Webhook testing needs public URL** — tunnel locally (Day 4), deploy re-registration (Day 7)
- **Notification tuning is subjective** — expect iteration on the significance prompt after living with it for a week; that iteration itself is a good story
- **Vercel serverless limits** — long backfills may need chunking or a one-off local script rather than a serverless function
