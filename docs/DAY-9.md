# Day 9 — What a new habit exposed

The athlete added eleven minutes on an elliptical after each lift. Two sessions
of it were enough to surface a counting bug that had been wrong since Day 3 and
a hole in the rule set that nobody had noticed because it was covered by
accident.

---

## 1. The load model needed nothing

Worth saying first, because it is the part that worked. Calibration placed
Elliptical at **2.786 load per minute**, between Run (3.393) and WeightTraining
(0.871), and scored an eleven-minute session at **31** — about half a lift.

No code changed. Day 3's decision to build load from heart rate rather than from
sport type meant a modality the system had never seen was priced correctly the
first time it appeared. A design pays for itself when a change you did not plan
for costs nothing.

---

## 2. The bug: a session was a row, not a day

`consistency` counted activities. Garmin records the finisher as its own
activity — 21:09 lifting, 22:10 elliptical — so one evening in the gym became
two sessions:

```
counted as activities:    4 sessions in 7 days,  weekly baseline 1.17
counted as training days: 2 sessions in 7 days,  weekly baseline 1.00
```

The judge quotes that number in messages. Worse, the weekly baseline feeds what
counts as a gap and what counts as normal, so left alone it would have drifted
toward double its true value while the training behind it never changed.

Two details make this a better bug than it first looks.

**It was already inconsistent with itself.** `longestGapDays`, in the same
function, always counted `distinct` dates. Half the function had the right idea.

**The fix stops at frequency.** The load model still sums both activities,
deliberately: two efforts in one evening are two doses of work. *How often* and
*how much* are different questions and are now counted differently on purpose,
which is the sort of thing that reads as an inconsistency until you say why.

Four days in the existing history already had multiple activities. The habit did
not create the bug; it made it systematic enough to notice.

---

## 3. The hole: nothing measured the dose of the work the goal needs

The stated goals are VO2max and pace. Every rule measured strain (ACWR),
frequency (consistency) or a *response* to training (efficiency, resting HR).
None measured the aerobic work itself.

That went unnoticed because the aerobic work used to be runs, and the efficiency
rule happened to cover runs. It stopped being covered the moment the aerobic work
moved to a machine: the efficiency rule needs pace, and a machine reports none.
So eleven minutes at 90% of max heart rate — precisely the stimulus the goal
calls for — was invisible.

**`aerobic_dose`** counts weekly minutes above 75% of observed max HR, across
every modality. Heart rate rather than sport type is the discriminator for the
same reason the load model uses it: it is the only quantity every modality
shares, and it is the only way a hard badminton game counts while an easy jog
does not. Against this athlete's observed max of 195 the threshold lands at
146 bpm, which separates their cardio (174–186) from their lifting (128–134),
badminton (127) and walks without a single sport-type rule.

Three preconditions, each for a different failure:

| Gate | Stops |
|---|---|
| max HR must be **observed**, never assumed | measuring a fraction of a guess and calling it a dose |
| ≥60% of recent sessions must carry HR | counting an unworn watch as an easy session, which would report a training block as a lay-off |
| ≥3 complete weeks | calling one week a trend |

It reports minutes and their direction, with the modalities that produced them,
and stops. There is no aerobic target here because the system holds none, and
inventing one to measure against would be training advice.

---

## 4. The first version was true and misleading

It fired with:

> *"Aerobic minutes down 66%"*

on the exact day the athlete had started building them back up. Both facts were
real: the three complete weeks behind it were the tail of a stopped running
block, and the 22 minutes already banked that week sat outside the comparison
window — excluded on purpose, because a partly-lived week always looks like a
collapse against a finished one.

Excluding the current week from the *comparison* was right. Excluding it from
the *sentence* was not:

> *"Aerobic minutes down 66%: 12.3 min/week over the last 3 complete weeks
> against 36.7 before, above 146 bpm, from Run. This week so far: 22 min from
> Elliptical, which is new — Elliptical does not appear in the weeks above."*

Day 3's contract says a `statement` must be safe to show without an LLM. A
statement that is accurate and leaves the reader with the wrong impression does
not meet that bar.

---

## 5. What the judge did with it

Unprompted, it merged the two fired rules into one explanation rather than
listing them:

> *"Your load ratio is 1.61 … Part of that is the baseline itself: aerobic
> minutes above 146 bpm averaged 12.3 min/week over the last 3 complete weeks
> versus 36.7 before, so the chronic side has decayed and current work registers
> as a bigger jump. This week's 22 min came from Elliptical, which is new."*

This matters because of what was *not* built. A separate change was considered —
attaching a per-modality breakdown to the ACWR finding so the judge could tell
"you ramped up hard" apart from "you added a small daily finisher". It was not
built, and the aerobic rule's data supplied the attribution anyway. **Two rules
that each report honestly gave the judge enough to explain a third thing neither
of them measures.**

---

## 6. Verified

Elliptical priced by the existing load model with no code change · consistency
now counts training days, and matches the gap query it always disagreed with ·
`aerobic_dose` threshold separates this athlete's cardio from their lifting on
real data · rule went `error`, not `ineligible`, when its SQL was broken — a
defect refusing to disguise itself as a data condition · judge produced a
correct, attributed message · **114 tests**, lint, types, build clean

## 7. Not verified

- **The `quiet` path.** Every run so far has fired, because the running block
  ending is a genuine 66% drop. What a normal week looks like is unobserved.
- The coverage gate rejecting a real week — needs sessions without HR
- Whether 30% is the right dead band. Aerobic minutes swing hard week to week;
  this is a preference and `npm run sensitivity` has not been re-run over it
- Whether the elliptical stays a habit, which is what decides if any of this
  measures anything
