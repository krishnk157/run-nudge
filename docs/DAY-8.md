# Day 8 — Deploy, and what deploying exposed

The system is live at `https://training-monitor-iota.vercel.app`, the Strava
webhook is registered against it, and a real activity has been through the whole
pipeline in production. Three things broke on the way, and the most important
one had been true since Day 1 without ever being visible.

---

## 1. The bug that only existed once it was deployed

For eight days this ran on localhost, and localhost is authentication. The first
production deploy removed it, and what was left was:

- a dashboard showing one person's training history, bodyweight and meals
- three write routes (`/api/meals`, `/api/body`, `/api/phases`)
- **`/api/chat` — a language model with read access to the entire database,
  billed to the athlete's API key**

all reachable by anyone who guessed the URL. Verified, not assumed:

```
/api/chat (no auth) -> 200
```

The cron routes were the exception, because `CRON_SECRET` had been designed to
fail closed on Day 5. Nothing else had been designed at all, because nothing
else had ever faced the internet.

The fix is a single-user answer to a single-user problem: one shared secret,
one `HttpOnly` cookie set by visiting `/api/auth?token=…` once per device, and
middleware in front of everything. No accounts table, no login form — inventing
either would be solving a problem this system does not have.

Three paths stay open, each because **something other than a cookie
authenticates it**:

| Path | What authenticates it |
|---|---|
| `/api/strava/webhook` | Strava cannot present a cookie. The GET handshake checks the verify token; the POST carries an activity id that is re-fetched from Strava before anything is written, so a forged event produces a failed lookup rather than a false notification |
| `/api/strava/callback` | Reached from Strava's domain with a code only Strava could have issued |
| `/api/cron/*` | `CRON_SECRET`, timing-safe, failing closed when unset |

After:

```
dashboard 401 · /api/chat 401 · /api/meals 401 · /api/body 401 · cron 401
webhook GET wrong token 403 · webhook GET right token {"hub.challenge":"…"}
dashboard with cookie 200
```

**The lesson worth keeping is about when the bug appeared.** It was not
introduced on Day 8. It was introduced the moment `/api/chat` was written on
Day 6 and was invisible for two days because the only client was a browser on
the same machine. A threat model that says "there is one user" is not a threat
model until you say who else can reach it.

---

## 2. A platform limit that changed a design, not a schedule

`vercel deploy` refused outright:

> Hobby accounts are limited to daily cron jobs. This cron expression
> `(0 * * * *)` would run more than once per day.

The hourly job is the delivery sweep — the backstop that retries a notification
Telegram refused. Moving it to daily is a one-character edit and leaves a failed
send sitting for up to 24 hours, which quietly changes what the system promises.

So the compensation went where the traffic is: the webhook path now calls
`requeueFailed()` **before** it delivers. This athlete trains four or five times
a week, so in practice the next activity heals a failed send and the daily cron
is genuinely the backstop it was always described as, rather than the mechanism
being relied on.

A constraint you cannot change is still a design input. It just isn't yours.

---

## 3. The regression set, and the bug it found on its first run

The plan asked for "8–10 chat questions with expected behaviour". `npm run eval`
is that, and it takes a target URL so the same set runs against localhost or
production.

Every property worth having here is a property of what the system *refuses* to
say, and none of it is enforced by types. A prompt edit or a model swap can undo
all of it without a single test going red. So the checks are of two kinds, and
they are labelled:

- **STRUCTURAL** — derived from the stream itself: which tools ran, in what
  order, with what arguments. Deterministic. A failure is unambiguous, and only
  these fail the run.
- **HEURISTIC** — phrase matching over prose. A model can express a caveat in
  words the script does not recognise, so a miss is a prompt to read the
  transcript, not a verdict.

**First run, first case: a real regression.** *"What was my fastest 5k"* spent
all six tool-loop steps querying and returned **no text at all** — a blank reply,
no error, nothing on screen to explain it. That came from the Sonnet switch made
while cutting costs: Sonnet issues more queries than Opus for the same question,
and six steps was tuned for Opus.

The fix is not just a bigger number. The ceiling went to 10, *and* `prepareStep`
now tells the model when it has two steps left, so it answers from the rows it
already has instead of firing a query it will never get to read. **A budget the
model can see is one it can plan against.**

Two other failures were the *checks* being wrong, not the system: it declined
dietary advice with "I'm not able to give dietary advice" and the pattern only
knew "can't" and "don't". Both are widened, with the transcript that disproved
them recorded in the comment — which is the honest way to maintain a heuristic.

---

## 4. The webhook callback, and an error message that pointed nowhere

Registering the subscription failed with Strava's:

> `GET to callback URL does not return 200`

The endpoint returned 200 to a manual `curl` at that exact moment. The cause was
that `npm run webhook -- create <url>` passes its argument to Strava verbatim,
and a bare origin registers `/` as the callback — which had returned 200 all
through development and now returns **401 behind the gate built an hour
earlier**. Two correct changes, an hour apart, producing an error message about
neither.

The script now normalises an origin to `/api/strava/webhook` and prints what it
registered.

---

## 5. Real Strava delivery, in production

Deferred since Day 4 on the grounds that testing it against a tunnel would prove
nothing. Subscription `367816`, and a manual activity created in the Strava app:

```
create  → processed in 14.5s   (cold start + Strava fetch + engine + judge)
update  → processed in 1.5s    (rename)
delete  → processed in 806ms   (activity row removed)
```

All three aspect types, from real Strava infrastructure, on the first attempt.
The delete also exercised something no test had: a notification whose activity
no longer exists. The feed `left join`s activities rather than inner-joining, so
the judgment survives with a null date instead of vanishing — the record of what
the system decided is not the athlete's to delete by editing Strava. That was a
Day 6 choice that had never been exercised until now.

The judge chose silence, and the recorded rationale is the reason this layer
exists at all:

> *"The acute:chronic ratio is suppressed as ineligible precisely because the
> 28-day window is too bunched to baseline against (suppressedRatio 1.65 is not
> a validated figure and must not be surfaced) … Correct move is silence; if the
> recent training block continues, ACR and aerobic efficiency should become
> eligible within a couple of weeks and can carry a real message then."*

It had a number that would have made an interesting notification, and refused to
use it because the engine had marked it unvalidated. That constraint was written
on Day 4, has now survived a model change and a platform move, and is the single
behaviour this whole system is built to protect.

---

## 6. Verified

Production dashboard renders real data · every private route 401s without the
cookie and 200s with it · webhook GET handshake passes with the real token and
403s without · **real Strava create, update and delete delivered to
production and processed end to end** · `after()` works on Vercel · judge ran in production and
chose silence with a defensible rationale · **eval 10/10 structural against
production** · 106 unit tests, lint, types, build clean

## 7. Not verified

- **A real, non-manual activity.** Every event so far has been a manual entry,
  which skips the upload and file-processing path Strava runs for a watch sync
- **The daily cron actually firing.** Vercel schedules it; nothing has watched
  one run yet
- **The digest on a live schedule** — next Monday 12:00
- A notification actually arriving on Telegram *from production* (the last real
  send was from localhost on Day 5)
- Mobile layout on a real phone
- Behaviour when Strava rate-limits, or when the Anthropic key runs out of credit
