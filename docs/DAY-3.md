# Day 3 — Analysis Engine

**Date:** 2026-08-10
**Plan reference:** [PLAN.md](PLAN.md) §5, Day 3 (as revised after Day 2)
**Stated outcome:** *"a `compute_insights(activity_id)` function returning structured findings — correct on real history"*
**Result:** Achieved. Five rules, each with a declared data precondition; validated against Garmin's own acute:chronic ratio at **r = 0.967**; replayed over all 28 activities with no rule errors.

The first day with no external API to fight. The difficulty moved from *getting data* to *deciding what a number is allowed to mean*.

---

## 1. The shape of the thing

```
                    ┌─────────────────────────────────────────────┐
                    │  compute_insights(activityId)               │
                    └─────────────────────────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
      ┌───────────────┐       ┌────────────────┐       ┌────────────────┐
      │   anchors     │       │  load model    │       │   rules[]      │
      │ max HR 195    │──────▶│ TRIMP per      │──────▶│ computation    │
      │ rest HR 58.8  │       │ activity, with │       │      +         │
      │ (worn nights) │       │ method tagged  │       │ precondition   │
      └───────────────┘       └────────────────┘       └────────────────┘
                                                               │
                                                               ▼
                                              ┌──────────────────────────────┐
                                              │ Finding[]                    │
                                              │  fired / quiet /             │
                                              │  ineligible / error          │
                                              └──────────────────────────────┘
```

Everything here is deterministic. Day 4's LLM reads the findings to decide whether to speak and how to phrase it; it never recomputes a number, and it is handed the *ineligible* findings too so it cannot describe missing data as reassuring.

**Files:** [athlete.ts](../src/lib/analysis/athlete.ts) · [load.ts](../src/lib/analysis/load.ts) · [metrics.ts](../src/lib/analysis/metrics.ts) · [rules.ts](../src/lib/analysis/rules.ts) · [engine.ts](../src/lib/analysis/engine.ts) · [types.ts](../src/lib/analysis/types.ts) · [scripts/analyze.ts](../scripts/analyze.ts)

---

## 2. A rule is a computation *plus* a precondition

This is the day's central idea, and it comes directly from a correction made during planning: wear is intermittent by nature here, so a rule that assumes its inputs exist will either fire on nothing or go quiet in a way indistinguishable from "all clear".

```ts
export type Rule = (ctx: RuleContext) => Promise<Finding>;

// every rule returns eligibility alongside its result
eligibility: needs(
  "needs more runs recorded with heart rate before a trend means anything",
  pts.length,   // have: 5
  MIN_RUNS,     // need: 8
)
```

Two properties follow, and both matter more than they look:

**It self-heals.** Nothing switches these rules on. Record eight HR-bearing runs and the efficiency rule's precondition simply starts passing. Wear the watch overnight for three weeks and Garmin establishes the HRV baseline that is currently `NONE`, and the recovery rules follow. There is no feature flag, no migration, nothing to remember.

**Silence becomes legible.** The engine reports `3 fired, 1 quiet, 4 ineligible` rather than a bare "no alerts". The dashboard can then say *why* four rules were dormant, which is the difference between "you're fine" and "we couldn't tell".

---

## 3. Load, when mileage is the wrong unit

The plan originally specified "weekly mileage aggregates". Day 2's data killed that: **12.0 hours of gym against 9.3 hours of running**. A distance-based load model scores four gym sessions as zero — not incomplete, *actively wrong*.

Heart rate is the only quantity every modality shares, so load is Banister TRIMP:

```
TRIMP = minutes × HRR × 0.64 × e^(1.92 × HRR)
        where HRR = (avgHR − restHR) / (maxHR − restHR)
```

The exponential is the point: a hard 30 minutes should outweigh an easy 60, not merely match it.

### Anchors from the athlete, not the population

```
max HR      195   (observed, not 220−age — we don't hold an age, and an
                   observed maximum beats an estimate even if it under-reads)
resting HR  58.8  (11 nights the watch was worn; 68.5 across all days)
```

That second line is Day 2's confound turned into code. Filtering to `valid_sleep` nights is what stops a return to consistent wear reading as a 10 bpm fitness gain.

### The fallback, and why `suffer_score` isn't it

Ten activities have no heart rate at all. Strava's `suffer_score` looked like the obvious substitute — until the data said it exists on exactly the 18 activities that have HR and none of the 10 that don't. **Zero added coverage.** It is itself HR-derived, which in hindsight is obvious and was worth five minutes of checking rather than an afternoon of building on it.

So the fallback is calibrated from the athlete's own measured sessions: per sport type, the mean TRIMP-per-minute across HR-bearing sessions, applied to sessions without. It stays personal rather than importing a MET table, and every load carries its `method`:

```ts
method: "trimp" | "calibrated-duration"
```

That tag exists so rules can decline to compare measured against estimated. It's the same regime-awareness principle as resting HR, applied one layer down.

**Honest limitation:** the 0.64 / 1.92 coefficients are the male-referenced form of TRIMP. We don't hold the athlete's sex, and the choice shifts how sharply hard work is weighted against easy. Absolute values here are not comparable to anyone else's — only this athlete against themselves, which is all the rules use.

---

## 4. Three guards on one ratio

Acute:chronic workload ratio took three attempts. Each guard was added because replaying real history showed the previous one was insufficient — which is the argument for replaying against real history rather than reasoning about it.

### Guard 1 — the layoff (planned)

Day 2 established the target: Garmin scored the 5 July run **ACWR 4.8, VERY_HIGH**, not because a 10 km run is extreme but because seven weeks off had decayed chronic load to 131. A ratio whose denominator is near-zero measures the layoff, not the session.

### Guard 2 — density (found by replay)

With a minimum of 4 sessions in the chronic window, the replay produced this on consecutive weekly runs:

```
2026-02-07  Load ratio 1.86 — well above your 4-week baseline
2026-02-14  Load ratio 0.73 — well below your 4-week baseline
2026-02-21  Load ratio 0.33 — well below your 4-week baseline
```

All arithmetically correct. All meaningless — at one session a week, each session is a quarter of the entire chronic baseline, so the ratio tracks whether a run happened to be 2 km or 5 km. Three notifications like that and the product is dead; this is precisely the notification fatigue PLAN §Day 4 warns about.

ACWR comes from a literature about athletes training most days. Applying it to one session a week is **using the instrument outside its range**. Threshold raised to 8 sessions per 28 days — which the athlete's stated plan (4–5 gym plus a weekend run) clears comfortably.

### Guard 3 — spread (found by replay)

A count alone still let this through:

```
2026-05-21  Load ratio 4 — well above your 4-week baseline
```

Four sessions, all inside the preceding five days. The "chronic" load was really a second acute load. Sessions have to be *distributed*, so the rule now also requires training in **3 of the 4 chronic weeks**.

That is the same layoff artifact wearing different clothes, and the lesson generalizes: *a count is not a distribution*. Any threshold on "enough data" should ask where the data sits, not only how much there is.

### What the guards cost, and why that's right

Across 28 activities, ACWR now reports on **2**. Everything else declines. That looks severe until you notice the alternative was three false alarms in February and a 4.0 in May. The rule is doing what PLAN §Day 4 asks: staying quiet unless it matters.

---

## 5. Validating against a reference implementation

`daily_metrics.garmin_acwr` covers 72 days — a commercial implementation of the same concept to check against. This is the single most useful thing Day 2 produced, and it converts "I computed acute:chronic load" into "I computed it and checked it".

### First pass — flat rolling windows

```
r = 0.956    direction agreement 15/21 (71%)

2026-05-31   ours 1.68   garmin 0.60   direction differs
2026-06-01   ours 1.58   garmin 0.70   direction differs
2026-06-03   ours 1.49   garmin 0.70   direction differs
```

Shape matched closely; values ran systematically **high through the June build-up**. The cause is structural, not a coefficient: a flat 28-day window treats a session 27 days ago as fully current and one 29 days ago as irrelevant, and when training resumes after a layoff the window fills with the layoff.

### Second pass — exponentially weighted

Exponentially weighted ACWR is the method the literature prefers (Williams et al., 2017) for exactly this reason, and it is what Garmin appears to approximate:

```
acute_t   = load_t · λ₇  + acute_{t−1} · (1 − λ₇)      λ = 2/(n+1)
chronic_t = load_t · λ₂₈ + chronic_{t−1} · (1 − λ₂₈)
```

Every calendar day contributes, rest days included — a zero-load day is information, and skipping it is what makes a layoff invisible to the average.

```
r = 0.967    direction agreement 16/21 (76%)
2026-05-31   ours 1.38 (was 1.68)   garmin 0.60
```

### Where I stopped, and why

Ours still runs higher than Garmin during ramp-ups. The remaining difference is explainable — Garmin likely uses a longer chronic horizon, and its load unit is its own — and I stopped rather than tuning further.

**Tuning until the numbers matched would be fitting to a black box, not validating against one.** Garmin's formula is undocumented; treating it as ground truth would import its judgment calls, including the one we deliberately reject. Correlation of 0.967 says our load model tracks a commercial implementation; it does not say Garmin is right.

The clearest evidence of that: **we decline on 51 of the 72 days.** Garmin reports a ratio even when its own chronic load has collapsed to `0.00` — on 5 August it reported an ACWR with no training behind it at all. Those refusals are the intended difference, not a coverage gap.

---

## 6. Two bugs, and one that matters more

### `gapBefore` threw invalid SQL

`cur.started_at_local` in a correlated subquery with `max()` — needs a lateral join. Ordinary mistake, fixed in a minute.

### The error handler was the real defect

The engine wraps each rule so one failure can't take down the report. My first version did this:

```ts
catch (e) {
  findings.push({
    rule: "unknown",
    status: "ineligible",          // ← the bug
    data: { error: e.message },
  });
}
```

So a **crashing rule was reported as dormant for want of data.** The replay showed `0 fired, 0 quiet, 5 ineligible` across every activity and looked entirely plausible — sparse data is this project's normal condition. It was only visible because the counts shifted by one in a way I happened to notice.

This is the same category error the whole project has been about, committed one level up. Day 2's lesson was *don't let absent data read as reassurance*. Here it was *don't let a defect read as an absence* — and a defect filed under a routine status is a defect nobody will ever investigate.

The fix is a fourth status:

```ts
export type RuleStatus = "fired" | "quiet" | "ineligible" | "error";
```

`ineligible` is expected and benign. `error` is never a data condition. Rules are now registered with names so a failure can be attributed rather than reported as `unknown`, and the replay prints an error count that is zero or loud.

**Worth sitting with:** I have now written four separate warnings in these docs about silent failures, and then written one. Knowing the failure mode is not the same as noticing it. What caught it was a diff in output I couldn't explain — which is an argument for replaying over history on every change, not just at the end.

---

## 7. The gap that couldn't be seen

The replay showed the July runs firing nothing at all, which felt wrong for a run after seven weeks off.

The cause: `consistency` computed "days since your last session" — and when the engine is triggered *by* an upload, the session in hand **is** the last one. The answer was always 0.

```ts
// The quantity that carries meaning is the gap this session just ended.
export async function gapBefore(activityId: number): Promise<number | null>
```

With that, the same three activities say something true:

```
2026-05-17  First session in 63 days.
2026-07-05  First session in 28 days.
2026-07-19  First session in 14 days.
```

And note what happened to 5 July specifically. Garmin said **ACWR 4.8, VERY_HIGH, readiness 1/100**. This system declines to report a ratio and says *"first session in 28 days"* instead. Same event, same underlying data — one is an alarming number that describes an absence, the other is the absence itself, stated plainly. That contrast is the clearest single illustration of what this engine is for.

---

## 8. What was verified

| Check | Result |
|---|---|
| Replay over all activities | 28 activities, **0 rule errors** |
| ACWR vs Garmin (72 days) | **r = 0.967**, direction 16/21 |
| Days we decline where Garmin reports | 51 — including days Garmin's own chronic was 0.00 |
| Layoff guard | 5 Jul / 19 Jul / 26 Jul all decline; no 4.8 |
| Density guard | Feb weekly-runner false alarms eliminated |
| Spread guard | 21 May "ratio 4" eliminated |
| Gap detection vs known history | 63 / 28 / 14 days — matches the real calendar |
| Regime-aware anchors | resting HR 58.8 from 11 worn nights, not 68.5 |
| `suffer_score` as fallback | rejected — 0 added coverage, verified in SQL |
| Strength set availability | 0/10 sessions — rule correctly permanently ineligible |
| Typecheck / lint / build | all pass |

**Not verified:** the TRIMP coefficient choice against this athlete's actual physiology; whether Garmin's ACWR uses a comparable formula at all (it's a cross-check, not ground truth); and every threshold in §4, which is calibrated against one athlete's history and would need revisiting for anyone else.

---

## 9. Resume-defensible claims from Day 3

**Deterministic analysis with an LLM held out** — every number computed in code or SQL; the model's input is a structured findings object it cannot recalculate.

**Capability-gated rule engine** — rules pair a computation with a declared data precondition, so the system degrades honestly through sensor gaps and re-enables itself without a code change.

**Validation against a reference implementation** — a proprietary commercial metric used as a check (r = 0.967), with the residual difference explained rather than tuned away, and the deliberate divergences defended.

**Applying a metric inside its valid range** — recognizing that acute:chronic ratio assumes a training frequency this athlete didn't have, and gating on density and distribution rather than emitting technically-correct alarms.

**Measurement-regime awareness** — anchors and baselines filtered to a single measurement condition; load carries the method used to derive it so estimated and measured are never silently compared.

**Failure-mode design** — a distinct status for defects so a crashed rule can't hide behind a routine "no data" state.

The interview-grade version of any of these is the *replay that changed my mind*: the guards in §4 exist because history showed the previous version firing nonsense, not because they were designed in advance.

---

## 10. What Day 4 inherits

- `computeInsights(activityId)` returns a findings object ready to hand to Claude.
- The significance prompt must receive the **ineligible** findings, not just the fired ones — otherwise it will write "nothing unusual in your recovery data" on a day with no recovery data.
- Only **2 of 28** historical activities produce a fired ACWR. Simulated-event testing should use the June gym block; the rest of history is deliberately quiet.
- `error` findings should page, not notify — they're defects, not insights.

**Commit:** `cbd6b85` on `day3-analysis-engine`.
