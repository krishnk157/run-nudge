# Day 6 — Chat + Dashboard

**Date:** 2026-08-20
**Plan reference:** [PLAN.md](PLAN.md) §5, Day 6 (as revised after Days 2 and §1a)
**Stated outcome:** *"on-demand questions answered with text + charts, alongside the proactive layer"*
**Result:** Achieved. Questions are answered from live SQL with the query shown, charts render from data already fetched, and the dashboard surfaces the proactive layer's own reasoning — including the notifications it decided *not* to send.

---

## 1. The shape of the thing

```
Dashboard (RSC)                     Chat (⌘K slide-over)
  getDashboardData()                  useChat → /api/chat
  ├ freshness                           └ streamText
  ├ state strip                            ├ query_metrics → READ ONLY txn
  ├ coverage panel  ◀── findings           └ render_chart  → pure, UI draws
  ├ notification feed (incl. withheld)
  └ trends (SVG, gap-aware)
```

**Files:** [queryMetrics.ts](../src/lib/chat/queryMetrics.ts) · [aiTools.ts](../src/lib/chat/aiTools.ts) · [prompt.ts](../src/lib/chat/prompt.ts) · [chat route](../src/app/api/chat/route.ts) · [ChatPanel.tsx](../src/components/ChatPanel.tsx) · [dashboard/data.ts](../src/lib/dashboard/data.ts) · [Charts.tsx](../src/components/Charts.tsx) · [Coverage.tsx](../src/components/Coverage.tsx)

---

## 2. Letting a model write SQL against your database

`query_metrics` is the only place in the system where model output reaches Postgres, so the guard is layered — and the **ordering matters more than the layers**:

1. **A `READ ONLY` transaction.** This is the real protection. Anything that defeats every string check still cannot write.
2. **A statement timeout**, so a cartesian join can't pin the connection.
3. **A row cap**, so a runaway result can't blow the context window.
4. **Shape checks** — single statement, must begin `SELECT`/`WITH`, no forbidden verbs.

The checks exist to give the *model* a fast, specific error. The transaction exists to be *correct*. When the two disagree, the transaction is what's keeping the data safe.

That distinction is testable, and worth testing. `select nextval('notifications_id_seq')` mutates a sequence — a genuine write — and contains no forbidden keyword:

```
keyword check says: PASSES (no forbidden word)
blocked by Postgres: cannot execute nextval() in a read-only transaction
```

A keyword blocklist alone would have let that through. Also pinned: `created_at` must not trip the `create` check, and `updated_at` must not trip `update` — a naive substring match rejects both and makes the tool useless.

**The guardrails live in `queryMetrics`, not in the tool definition.** That looked like ordinary hygiene when written; it paid off the same day when the entire tool layer was rewritten for a different SDK and the safety came along untouched.

---

## 3. Rewriting on the AI SDK — and why

The first version used the Anthropic SDK directly with a hand-rolled NDJSON stream and a custom chat panel: consistent with Days 4–5, and about 200 lines I owned.

Then the requirement changed — the Vercel AI SDK and AI Elements are skills to demonstrate, not incidental plumbing. That is a legitimate reason to choose a dependency, and the plan had specified the AI SDK from the start; the first version was the deviation.

What the swap actually bought:

| | Hand-rolled | AI SDK + AI Elements |
|---|---|---|
| Tool loop | Manual `while` over `stop_reason` | `streamText` + `stopWhen: stepCountIs(6)` |
| Transport | Custom NDJSON, hand-parsed | `DefaultChatTransport`, typed message parts |
| Client state | `useState` juggling partial turns | `useChat` |
| Tool UI | Bespoke `<div>`s | `Tool` / `ToolHeader` / `ToolInput` / `ToolOutput` |
| Tool schema | Hand-written JSON Schema | `tool()` + Zod, inferred types |

The genuine win is **typed tool parts**. `part.type === "tool-render_chart"` is narrowed by the SDK from the tool definition, so rendering a chart from a tool result is type-safe end to end rather than a cast.

**One deliberate thing was kept.** Charts stay hand-rolled SVG. The property they must guarantee — *never draw across a gap in a way that implies training happened* — is exactly what a charting library does by default, and it's easier to get right in 40 lines than to configure a library out of.

---

## 4. Five integration bugs, all found by running it

**`shadcn init --defaults` picked the wrong style.** It chose `base-nova`, which is built on Base UI; AI Elements is built against the Radix-based styles. Eight type errors in `prompt-input.tsx` — `openDelay` not existing, `BaseUIEvent` mismatches — and `next build` failed outright. Switching to `new-york` and reinstalling cleared all but one, which was a genuine version skew in vendored code and is now pinned with a comment.

The lesson isn't "read the docs": it's that `--defaults` made a consequential architectural choice silently, and the failure surfaced three layers away as type errors in someone else's component.

**Tool results must be plain JSON.** `queryMetrics` returned raw postgres.js rows containing `Date` objects. The first tool call succeeded; step two of the loop died with `Invalid prompt: The messages do not match the ModelMessage[] schema` and the answer truncated mid-sentence — *"I'll check your strength sessions over the last two weeks."*

The tool had worked perfectly. Serialising its result **back into the prompt** was what broke, and the symptom appeared one step later than the cause. `toJsonSafe` now converts `Date` → ISO string, `bigint` → string, and round-trips nested objects.

**`backdrop-filter` on an ancestor traps `position: fixed`.** The panel opened as a clipped stub in the top-right corner: no messages visible, composer jammed under the header, the scrim dimming nothing. The CSS for `.sheet` was correct — `inset` pinned to all four edges, full-height flex column — and it was being applied.

The cause was three files away. `<ChatPanel />` renders inside `<header className="top">`, and `.top` carries `backdrop-filter: blur(10px)` for the frosted sticky bar. A `backdrop-filter` (like `transform` and `filter`) makes an element a **containing block for fixed-position descendants**. So `top: 0; bottom: 0` resolved against a 64px header rather than the viewport, and the scrim's `inset: 0` covered only the header.

The overlay is now portalled to `<body>`, which is the fix that survives whatever styling the header grows later. Hydration is guarded with `useSyncExternalStore`, not a `setState` in an effect.

This one is worth remembering because **every individual rule was right**. There was nothing to find by re-reading the panel's CSS — the bug was a property on an unrelated element changing what a keyword *means* two subtrees down.

**Styling the wrong element in a three-div component.** `<Conversation>` looks like one element and renders three: an outer box, a scroller with an inline `height: 100%`, and the content div that the library measures to decide whether you're at the bottom. My `overflow-y: auto` landed on the content div, so it scrolled inside itself while the element `StickToBottom` actually watches never moved. The panel scrolled; auto-scroll-on-stream silently did not. Fixed by passing `scrollClassName` and styling all three layers deliberately.

**A design system installed but never wired up.** With the layout fixed, the panel rendered unreadable: near-black body text and a bright white user bubble on a dark ground. Nothing was overriding anything — AI Elements is styled entirely through shadcn's token names, and shadcn puts its *light* palette on `:root` with dark gated behind a `.dark` class this app never sets. The dashboard themes itself off `prefers-color-scheme`. Two theming mechanisms, neither aware of the other, so the components were correctly rendering the light theme onto a dark page.

The fix is a **token bridge**: map shadcn's vocabulary onto the instrument-panel palette once, in `dashboard.css`. Because the tokens it maps *from* already switch with the media query, the bridge needs no theme of its own — and any AI Elements component installed later is themed on arrival rather than patched afterwards.

The two vocabularies collided on exactly one name: shadcn's `--accent` is a hover surface, ours was the teal brand colour. Ours yielded and became `--brand`, on the reasoning that the shadcn names are fixed by third-party components and ours are not.

Seven of these nine bugs had their symptom somewhere other than their cause. That's the pattern of the project, and both of today's layout bugs are the extreme case: the code at the symptom was correct.

---

## 5. The dashboard is the proactive layer made inspectable

Built from the mockup approved on Day 2, now against real data. The governing rule carried over intact: **absence is drawn, never omitted.**

- **State strip** — zeroes render as hatched voids, not blanks. The load ratio shows its value with a `▲ last computed` badge when the engine currently refuses to compute one, rather than presenting a stale figure as current (Day 5's lesson, applied to a number instead of a row count).
- **Coverage panel** — "1 of 5 insights active — 4 dormant for want of data", each with its own unlock condition. This is the piece that makes silence legible: without it, "no recovery flags" is ambiguous between *you're fine* and *the watch wasn't worn*.
- **Notification feed** — includes the **withheld** rows and each judgment's rationale. The mockup's "Withheld · nothing worth sending" entry, now real.
- **Trends** — bars for load so a zero week is visible; the efficiency series breaks into segments with a dashed void across gaps over 21 days.

**One real bug caught here.** Weekly load initially came from `sum(suffer_score)` in SQL — which meant the dashboard could display a "load" the analysis engine had never computed, and that would contradict every notification the system had sent. It now calls the engine's own `activityLoads()`. One system, one definition of load.

---

## 6. What was verified

| Check | Result |
|---|---|
| Postgres blocks what keyword checks miss | ✓ `nextval()` rejected by the transaction |
| Keyword checks don't false-positive | ✓ `created_at` / `updated_at` pass |
| Live question end-to-end | ✓ correct answer, SQL shown, 2 queries |
| Chart tool | ✓ 14 points, `bar` chosen over `line` |
| Chart correctness | ✓ model rejected `suffer_score` as inconsistent, said so |
| Staleness honesty in chat | ✓ volunteered unprompted (below) |
| Dashboard renders real data | ✓ 200, load 69, VO₂max 38.1 ▼2.2 |
| Load agrees with the engine | ✓ after the suffer_score fix |
| Typecheck / lint / build / tests | ✓ 72 tests |

The honesty constraint transferring is the result worth keeping. Unprompted, on a question about gym sessions:

> *"the most recent sync was 17 Aug, so anything you did on 18–20 Aug wouldn't be in the database yet — that's a data gap, not necessarily rest."*

And on six empty weeks in a chart:

> *"I can only tell you there are no rows for those weeks — that could be genuine rest or simply nothing synced from Strava; the data doesn't distinguish the two."*

Neither was asked for specifically. The rule written for Day 4's judge, extended for Day 5's digest, now holds in a third context with no additional prompting.

**Not verified:**

- **The statement timeout.** Configured at 5s, but the tables are too small to trigger it — a five-way cartesian join completed instantly. Untested, not proven.
- **Chat under adversarial input.** The guardrails are tested against queries *I* wrote. Nobody has tried to talk the model into something clever.
- **The dashboard on a busy dataset.** 32 activities and 7 notifications is not a stress test of the feed or the charts.
- **Mobile layout.** Breakpoints exist; no phone has loaded it.

---

## 7. Resume-defensible claims from Day 6

**LLM tool-calling / orchestration** — Vercel AI SDK (`streamText`, typed Zod tools, `stopWhen`) with `useChat` and AI Elements; multi-step loops where the model writes SQL, reads the result, and self-corrects on error.

**Safely exposing a database to a model** — layered guards where the outermost layer is the database's own transaction semantics rather than string filtering, with a test proving the string layer alone is insufficient.

**Framework-independent safety** — guardrails placed so that replacing the LLM SDK could not weaken them; demonstrated by actually replacing it.

**Consistency between subsystems** — the dashboard computes load through the analysis engine rather than reimplementing it in SQL, so the UI cannot contradict the notifications.

**Honest data visualisation** — charts that refuse to interpolate across gaps, and a coverage panel that distinguishes *nothing to report* from *nothing measured*.

---

## 8. What Day 7 inherits

- The chat layer is the input path for meal logging (PLAN §1a) — `useChat` already carries attachments, and `PromptInput` has an attachment slot wired.
- `render_chart` proves the pattern Day 7 needs for the confirm-then-save flow: a tool result rendered as an interactive component rather than JSON.
- The dashboard has a bodyweight panel stubbed with "logging arrives on Day 7".

**Commit:** `20b04c7` on `day6-chat-dashboard`.
