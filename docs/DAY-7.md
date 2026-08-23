# Day 7: Nutrition and body composition

Photograph a plate or describe it in a sentence, correct the portion, save it.
Weight and goal phases as dated state. The claim being tested: **log the same
dish twice and the numbers are identical, because the arithmetic lives in the
database and not in the model.**

---

## 1. The one architectural idea

A language model is good at *what is on this plate* and unreliable at *how much
of it there is*, and it is not a calculator at all. Day 7 is built entirely
around splitting those three jobs apart:

| Job | Who does it | Why |
|---|---|---|
| Identify the food | model | there is no other way to read a photograph |
| Estimate the portion | model, then the athlete corrects it | a proposal, never a fact |
| Estimate a *new* food's composition | model, **once**, then it's stored | no database has "my mother's biryani" |
| Multiply grams by composition | **SQL** | the model must never state a total |
| Write the row | **an HTTP route the model cannot call** | confirmation has to be structural |

The interesting line is the third. Composition has to come from somewhere, and
for home cooking an estimate is the only option that exists. But an estimate
made **once and stored** is a fact you can correct; an estimate made fresh on
every question is a number that quietly drifts. So the first sighting of a food
writes a row, and every later sighting reads it.

---

## 2. Reproducibility is enforced, not requested

The obvious implementation is to tell the model in the prompt: *check the foods
table first and reuse what's there.* That works most of the time, which is the
worst property a correctness guarantee can have.

Instead the lookup happens **inside the `propose_meal` tool**, after the model
has spoken. Whatever composition it supplies for a food the athlete has logged
before is discarded and the stored row substituted. The model cannot skip a
step it never performs.

**This was verified, and the substitution turned out to be load-bearing.** The
same dish, logged twice, in different words:

```
first : model PROPOSED 'Chicken biryani' kcal/100g=165 protein=9 carbs=18 fat=6
second: model PROPOSED 'Chicken biryani' kcal/100g=165 protein=9 carbs=19 fat=5.5
```

The model **drifted**, carbs 18 → 19, fat 6 → 5.5, while typing "CHICKEN
BIRYANI" in caps produced `known=True` and the stored composition, unchanged,
in the draft the athlete would have confirmed. Without the substitution the same
plate would have produced a different macro split every time, and nothing on
screen would have hinted at it.

Food identity is normalized to a `key` (lowercased, whitespace-collapsed) with a
unique index, so *"Chicken Biryani"*, *"chicken biryani "* and *"CHICKEN
BIRYANI"* are one food. It stops there deliberately: no stemming, because
*grilled* chicken is not *fried* chicken.

---

## 3. The model cannot write to the database

`propose_meal` produces a draft and returns it. Saving is `POST /api/meals`,
an ordinary route with **no tool binding at all**. There is no `save_meal` tool,
and a test asserts there never quietly becomes one.

This matters more than the prompt rules around it. If saving were a tool, then
"don't save without confirming" would be a policy the model is asked to respect,
and every misread photo, every confused turn, every prompt injection is a chance
for it not to. Making the write a different transport means the confirmation
step cannot be argued around, the same reasoning as Day 6's `READ ONLY`
transaction, applied to writes.

The route re-validates its body with Zod even though the client just built it
from a tool result, because *"the client is ours"* stops being true the moment
anything else learns the URL.

### The friction the plan warned about

The plan flagged confirm-before-save as *"right for accuracy and wrong for
friction, and friction is the only thing that decides whether food logging
survives past week two."* So the card records `edited` per item, whether the
athlete actually changed the proposed grams. That's the measurement that decides
whether this step is earning its cost. **If it isn't, the retreat is
save-immediately-edit-later, not dropping the correction.**

---

## 4. Phases: one column instead of two

`goal_phases` stores a start date and **no end date**. A phase runs until the
next one begins, and `lead(started_on) over (order by started_on)` derives the
closed span whenever a query wants one.

Two columns describing one boundary is two chances to disagree. With an
`ended_on`, a gap or an overlap becomes representable, and then some query has
to decide what an athlete who is simultaneously bulking and cutting means. One
column cannot contradict itself.

This exists because of a constraint the athlete stated directly: goals change,
so **a weight trend is only meaningful inside a phase.** A regression through a
bulk and the cut that follows it produces a slope describing neither, and it
looks perfectly reasonable. So:

- `currentPhaseTrend()` fits only within the current phase, and reuses the
  analysis engine's own `slope()` rather than carrying a second least-squares
  implementation that could drift out of agreement with it.
- The weight chart **breaks the line at every boundary**, colours each segment
  by phase, and marks the change with a rule.
- The schema doc handed to the chat model says, in capitals, never to fit across
  a boundary.

### `phase_drift`, a rule that reports and stops

A new capability-gated rule: weight moving against the declared goal. It states
*"losing 0.3 kg/week during a bulk that began 2026-08-01, 6 weigh-ins over 21
days"* and says nothing else. **No calorie target, no suggestion to eat more.**
The system holds no target, the athlete explicitly didn't want one, and
inventing one to advise against would be dietary advice it has no standing to
give.

Gates: ≥4 weigh-ins spanning ≥14 days *inside the phase*, plus a 0.1 kg/week
dead band so noise isn't reported as a direction. `maintain` never fires, for a
maintain phase any drift is what you'd want to know, but separating meaningful
drift from ordinary fluctuation needs a variance model this doesn't have, and a
rule that fires on noise is worse than one that stays quiet.

---

## 5. The bug: one mistake, three times, found by running it

The model logged a meal to **2026-08-22** while it was already the 23rd.

**First cause.** `CHAT_SYSTEM` was a module-level constant with
`Today's date is ${new Date()...}` in the template literal, evaluated *once, at
import*. `next dev` had been running since the previous evening, so the model
was told yesterday's date. A warm serverless container does exactly the same
thing, just less often and much harder to notice.

**Second cause, under it.** Fixed to compute per request, it was still
`toISOString().slice(0, 10)`, the **UTC** date. At 00:12 IST that is still
yesterday. For a third of every day, this athlete's "today" and the server's
disagree.

**Third site.** The dashboard's intake window had the same line, so a meal
logged after midnight fell outside its own week: the panel read **"0 logged
days"** over a database that had just been written to.

The fix derives the athlete's clock from data already present rather than asking
them to configure it. Strava records every activity as both an absolute instant
and a wall-clock time; the difference between `started_at` and
`started_at_local` on the most recent activity **is** the clock they were
standing under. It came back +5.5h without anything being set.

```
athlete offset (h): 5.5   today: 2026-08-23
```

Known limitation, stated in the code: that's an *offset*, not a timezone, taken
from whenever they last trained. Fly to another continent and don't train for a
fortnight and it reports the old clock. Smaller and more visible than assuming
UTC, and the reason it is read per request rather than cached.

**Two things about this bug are worth keeping.** The model found it, asked how
much protein it had, it volunteered *"dated 2026-08-23 (stored a day ahead of
today, so likely today's meal recorded on the other side of a timezone
boundary)"*. And the same wrong line appeared in three places written hours
apart, which is what a habit looks like rather than a slip: `new Date()` reads
as "now", and `.toISOString()` silently makes it "now, in London".

**One instance was found and deliberately not fixed.** The analysis engine's
cron path also falls back to a UTC `new Date()`. Changing it would shift ACWR
window boundaries and therefore Day 3's numbers, which is not a change to make
as a side effect of a nutrition feature. Recorded here rather than quietly
altered.

---

## 6. What the dashboard says when there is nothing

Nutrition is its own section, not a row in the state strip, because it is the
only data here the athlete produces by hand. Training data arrives whether or
not they think about it; a food log exists only on the days they remembered.

The gate matters more than the average. Four logged days out of seven is not
"your protein was 1.4 g/kg", it is *your protein on the days you remembered to
log*, which skews high, because people log the meal they planned and forget the
biscuit. So `MIN_LOGGED_DAYS = 4` and the panel refuses rather than averages.

That refusal needed its own correction during verification. With one meal
logged, the intake panel read **"no meals logged in the last 7 days"**, false.
One logged day is data; it is just not a week. It now says *"1 of 7 days logged,
too few to average"*. Same family as Day 3's `ineligible` vs `error`: two
different absences that must not share a sentence.

Every total also carries `estimatedShare`, what fraction of the calories came
from compositions nobody has checked, so an estimate never quietly acquires the
authority of a measurement.

---

## 7. Verified

- Same dish logged twice → **identical stored composition**, while the model's
  own proposal drifted between the two
- Case and spacing collapse to one food; `grilled` ≠ `fried`
- Meal saved through the real route; totals came back **computed in SQL**
  (750 kcal, 41 g protein from 400 g + 150 g)
- Asked about protein, the model wrote the join itself
  (`sum(f.protein_g_per_100g * mi.grams / 100.0)`), reported the estimated
  share unprompted, and said *"That means not logged, not 'not eaten'"*
- Athlete offset derived as +5.5h from Strava data alone
- `phase_drift` reports `ineligible, no goal phase declared yet`; engine runs
  clean, 0 errors
- Dashboard renders every panel in its empty state with an unlock condition
- **89 tests**, lint, types, build clean

## 8. Not verified

- **No photograph has been through this.** The vision path is wired
  (`accept="image/*"`, 5 MB cap, files forwarded to the model) and typechecks,
  but every meal tested was text. Portion estimates from a photo are the part
  most likely to be badly wrong, and they are exactly what hasn't been tried.
- `phase_drift` firing, and the weight chart drawing a boundary, both need
  weigh-ins across a real phase change, which takes weeks, not a test fixture
- Whether confirm-before-save survives contact with a busy week
- The offset when the athlete travels
- Mobile layout

**The verification meal was deleted afterwards**, along with the two foods it
created. It was fabricated for a test, the athlete never ate it, and a food log
containing meals nobody ate is worse than an empty one.

---

## 9. Day 8 inherits

Deploy, real Strava webhook delivery, and the polish pass. The nutrition tables
are empty by design, the first real entry should be one the athlete makes.
