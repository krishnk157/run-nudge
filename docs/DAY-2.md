# Day 2 — Garmin Daily Metrics + Activity Provenance

**Date:** 2026-08-09
**Plan reference:** [PLAN.md](PLAN.md) §5, Day 2
**Stated outcome:** *"merged dataset; dual-logged run appears once"*
**Result:** Achieved, but not as designed — the dedup problem the plan budgeted the day for **does not exist in this data**, and the recovery metrics it wanted are **13% covered**. Both findings changed the plan more than the code did.

The plan flagged this as the likeliest day to slip. It didn't slip on the risk it named (the unofficial API breaking). It slipped on two assumptions nobody had checked.

---

## 1. The day in one paragraph

Started by verifying which wearable actually recorded the runs, found a bug in Day 1's data retention while doing it, fixed that, and discovered the fix had already answered the day's hardest question. Rejected the in-stack Garmin library on data coverage, built an isolated Python sidecar instead, synced 85 days, found three mapping errors by reading the raw payloads, and finished with hard numbers showing the plan's recovery-insight feature isn't supported by the data that exists.

---

## 2. The bug that reframed the day

### What happened

Day 1 claimed `activities.raw` held "the untouched Strava payload," giving schema-evolution insurance: add a column later, backfill from local data, never re-fetch.

Probing for device provenance, the payload had 25 keys — exactly the fields already promoted to columns. No `external_id`, no `map`, no `device_name`.

The cause is one line:

```ts
export const summaryActivitySchema = z.object({ ... });   // strips unknown keys
```

```ts
raw: a as unknown as Record<string, unknown>,             // `a` is the PARSED object
```

**zod's `z.object()` strips unknown keys by default.** Since the parsed value was what got persisted, `raw` could only ever contain fields the schema already named. The column existed solely as insurance against schema change and provided exactly none.

### The fix

```ts
export const summaryActivitySchema = z.looseObject({ ... });
```

25 fields → 58. Re-ran the backfill; still 28 rows (idempotency holding up).

### Why this one is worth remembering

It's a **silent** correctness bug in a feature whose whole purpose is insurance. Nothing errored. Every test passed. The column existed, was `NOT NULL`, contained plausible JSON. It would have been discovered on Day 3 or later, at exactly the moment it was needed and could no longer help — the failure mode of insurance is that you find out when you claim.

The general shape: **a validation layer sitting between a source and its archive will silently narrow the archive to whatever the validator knows about.** Validate and archive from *different* values, or make the validator lossless. I chose lossless and left a comment saying so, because the natural instinct on seeing `looseObject` is to "tighten" it.

### Two Day 1 claims it invalidated

Both corrected in place in [DAY-1.md](DAY-1.md):

1. *"raw keeps the untouched JSON"* — described an intent the code didn't implement.
2. *"`device_name` is null because Strava only returns it on the detail endpoint"* — **wrong**. It's on the summary endpoint. It read null because zod discarded it.

The second is the more instructive error. I saw a null column and reached for an explanation that fit (Strava's API docs do distinguish summary and detail representations), then wrote it down as fact. A null has at least two causes — *the source didn't send it*, or *something dropped it in transit* — and I tested neither. One extra API call would have settled it.

---

## 3. The dedup problem that wasn't

The plan budgeted Day 2 for reconciliation:

> Dedup: timestamp + distance matching; per-field source-of-truth (Garmin wins HR, Strava wins activity record)

With `raw` fixed, `external_id` became visible:

```
garmin_ping_604003275089        <- watch auto-pushed to Strava
5b8ce5a4-…-activity.fit         <- uploaded as a file
```

**The Garmin watch pushes directly to Strava.** One run produces *one* Strava activity, carrying its own Garmin activity id. There is no second copy. Nothing to reconcile, no fuzzy matching, no per-field source-of-truth arbitration.

Fuzzy matching on timestamp + distance would have been real work — tolerance windows, ties, GPS drift between sources — and every line of it unnecessary. It was replaced by a regex:

```ts
const garmin = externalId.match(/^garmin_(?:ping|push)_(\d+)$/);
```

| upload_source | device_name | n | garmin id | has HR |
|---|---|---|---:|---:|
| garmin | Garmin Forerunner 265 | 17 | 17 | 17 |
| file_upload | Strava App | 10 | 0 | 0 |
| file_upload | Samsung Galaxy Watch4 | 1 | 0 | 1 |

### The naming mistake in that table

The column was first called `recording_source`. That last row proves it wrong: a **Samsung Galaxy Watch4 recording arrives as a file upload, and it does have heart-rate data.** Upload path and recording device are different questions, and `recording_source` conflated them. Had Day 3 used it as a proxy for "was this a real wearable," that row would have been misclassified.

Renamed to `upload_source`, with `device_name` kept as the separate answer to "what recorded it."

**The lesson is about naming as a correctness concern.** `recording_source` wasn't a bad label for a right thing — it was a label that described something the column didn't contain, and the difference was invisible until a single row happened to disagree. With 27 of 28 rows, the two questions have the same answer.

---

## 4. Choosing the Garmin client

### Why Garmin needs a library at all

Strava has a documented REST API with OAuth. Garmin has no official consumer API — the official Health API requires a commercial partnership. So every hobbyist integration reverse-engineers the Garmin Connect web app, and those break whenever Garmin changes something.

### Rejecting the in-stack option

The obvious choice was Node's `garmin-connect`, keeping one language. Two facts against it:

1. **Last published January 2024** — ~2.5 years stale against an API with no stability guarantee.
2. **Decisive one:** its method surface is `getSleepData`, `getHeartRate`, `getSteps`, `getActivities`. No HRV. No VO2max. No training status or load.

PLAN §Day 2 asks for "sleep, HRV, VO2max, training load." The library covers one of four. Python's `garminconnect` exposes 151 methods including all of them.

I had predicted the Node library would fail on *authentication*. It was rejected on *data coverage* — a reason that made the auth question irrelevant. Worth noting because the prediction was confident and about the wrong thing.

### The isolation argument

Adding a second language needs justification. The one that holds:

**The Garmin pull is a batch job, not a request path.** It runs on a schedule, writes to a table, and returns. It touches no webhook, no chat route, no user request. So the sidecar can be isolated behind the one interface both sides already speak — Postgres:

```
scripts/garmin_sync.py  ──writes──►  daily_metrics  ◄──reads──  src/ (TypeScript)
```

The app never imports Python; the sidecar never imports the app. If that boundary is ever violated — if Garmin data is needed synchronously inside a request — the design has gone wrong and the sidecar should be replaced, not extended.

**Interview framing:** *"A second language is justified when it's isolated behind a durable interface and confined to work that's off the request path. The test I'd apply is whether removing it requires touching the app — here it doesn't."*

---

## 5. Auth, and one bug in my own code

`garminconnect` 0.3.9 authenticates over `curl_cffi`, which impersonates a browser's TLS fingerprint — Garmin blocks clients whose TLS handshake looks like a script. (Worth correcting: I'd said it uses `garth`. It dropped that dependency.)

Two things the sidecar gets right:

**Token caching is a safety measure, not an optimization.** Repeated password logins are the fastest way to get a Garmin account rate-limited — the first run hit `429: IP rate limited` on two transports before succeeding. `login(tokenstore)` both loads cached tokens and dumps fresh ones, so there's one call path rather than a cache branch and a login branch that can drift.

**The login-verification bug.** My first version:

```python
client.login(TOKEN_STORE)
print("authenticated")        # unconditional
```

`login()` **returns** `("needs_mfa", None)` rather than raising. So an incomplete login printed "authenticated" and the run continued to write 3 days of empty rows. Fixed:

```python
result = client.login(TOKEN_STORE)
if isinstance(result, tuple) and result[0]:
    sys.exit(f"Garmin login incomplete: {result[0]}. ...")

profile = client.get_user_profile() or {}
if not profile.get("id"):
    sys.exit("Garmin session did not return a profile — treating login as failed.")
```

**The principle: don't infer success from the absence of an exception.** A function that signals failure by return value will be silently misread by code that only handles exceptions. The stronger version, applied here, is to *prove* the session by making it do something.

That bug nearly cost real diagnostic time: the first run printed "authenticated" and stored three days of nothing, which looks exactly like an auth failure. What disambiguated it was the raw payloads — they contained a real `userProfileId`, so the session was genuinely working and the days were genuinely empty. **Storing raw payloads paid for itself within hours of being fixed.**

---

## 6. Three mapping errors, found by reading raw payloads

Garmin's response shapes are undocumented, deeply nested, and keyed by device id. Every one of these was found by dumping what was actually stored:

**1. Acute training load, wrong subtree.** I read `mostRecentTrainingLoadBalance` — which holds *monthly* aerobic/anaerobic splits and no daily figure. The daily numbers live in `latestTrainingStatusData[<deviceId>].acuteTrainingLoadDTO`:

```json
{ "acwrStatus": "OPTIMAL", "dailyTrainingLoadAcute": 306,
  "dailyTrainingLoadChronic": 206, "dailyAcuteChronicWorkloadRatio": 1.4 }
```

Finding this was the day's most valuable accident — see §8.

**2. `body_battery_high` / `low` were misnamed.** Garmin's fields are `charged` and `drained`: *amounts gained and spent across the day*, not high and low readings. `charged: 0, drained: 31` under the old names reads as "battery ranged from 0 to 31," which is a different and wrong statement. Renamed to `body_battery_charged` / `body_battery_drained`.

**3. Silent nulls in the progress output.** The first version printed only 6 hand-picked fields, so `training_status` looked absent when it was stored correctly. Now it prints `16/28 fields` with the full list — a progress line that under-reports is worse than none, because it invents problems.

None of these threw. All three produced plausible values or plausible absences.

---

## 7. What the data actually says

This is the part that matters more than the code.

### Coverage over 85 days (2026-05-17 → 2026-08-09)

| Metric | Days | Coverage |
|---|---:|---:|
| acute training load | 85 | **100%** |
| training readiness | 80 | **94%** |
| Garmin ACWR | 72 | **85%** |
| steps | 59 | 69% |
| resting HR | 55 | 65% |
| **sleep** | **11** | **13%** |
| **HRV** | **11** | **13%** |
| VO2max | 5 | 6% |

### Finding 1 — the recovery layer the plan wants doesn't have data

PLAN §2 lists "recovery flags (Garmin sleep/HRV context)" as a core insight type, and §Day 2 names sleep and HRV first.

Sleep and HRV exist on **11 of 85 days, all between 18 May and 14 June.** Overnight wear stopped entirely after 14 June — confirmed independently by you ("wearing my Garmin very rarely these days").

Worse for the feature: `hrv_status` is `NONE` on all 12 days that have it. Garmin's HRV *status* — the interpretable signal, the one that says BALANCED or UNBALANCED relative to your personal baseline — requires roughly three weeks of consistent overnight wear to establish a baseline. **That baseline was never established.** So the useful HRV signal doesn't exist at all; only raw millisecond values with nothing to compare them against.

**Consequence:** recovery-aware insights cannot be built on sleep or HRV *today*. Not "will be sparse" — cannot, against 13% coverage and no baseline.

> **Decision (revised after discussion).** My first recommendation was to cut the feature. That was wrong in kind. Wear is intermittent *by nature here* — there will be tracking phases and non-tracking phases indefinitely — so the feature should be **gated on data sufficiency, not removed**.
>
> The difference matters: a gated rule self-enables. Wear the watch consistently for ~3 weeks, Garmin establishes the HRV baseline that is currently `NONE`, the rule's precondition starts passing, and the insight starts firing — no code change and nothing to remember to switch on. A cut feature stays cut.
>
> This generalizes past Garmin: **data availability is a first-class input to the analysis engine, not an assumption it gets to make.** See §11.

### Finding 2 — resting HR is confounded by wear, and it looks fine

| Watch worn overnight | days | min | avg | max |
|---|---:|---:|---:|---:|
| yes | 11 | 54 | **58.8** | 65 |
| no | 44 | 51 | **68.5** | **115** |

A ~10 bpm shift in the mean and a maximum of 115, which is not a resting heart rate by any definition. When the watch isn't worn overnight, Garmin reports the day's lowest observed HR — a daytime minimum, sometimes captured minutes after a run.

**This is the dangerous one**, because unlike sleep it isn't missing. It's present, numeric, and wrong in a way no null check catches. A rolling RHR baseline built across both regimes would drift by ~10 bpm for reasons that have nothing to do with fitness, and any "your resting HR is elevated" insight would be reporting wear habits.

Hence `valid_sleep` and `stress_sample_count` as explicit quality columns: **Day 3 must be able to distinguish "not measured" from "measured and fine."** A null says the first. A number without context implies the second.

### Finding 3 — Garmin computes ACWR, and it confirms Day 1's prediction

Day 1 §11 predicted the Mar–May layoff would make acute:chronic ratio explode on the return, because chronic load decays toward zero. Garmin's own numbers on the five Garmin-recorded runs:

| Run date | km | Garmin ACWR | Status | Acute | Chronic | Readiness |
|---|---:|---:|---|---:|---:|---:|
| 2026-05-17 | 5.0 | — | NONE | 547 | 461 | — |
| 2026-05-30 | 5.0 | 0.7 | LOW | 387 | 512 | 27 |
| **2026-07-05** | **10.2** | **4.8** | **VERY_HIGH** | 634 | **131** | **1** |
| 2026-07-19 | 5.0 | 1.6 | HIGH | 331 | 197 | 6 |
| 2026-07-26 | 5.0 | 1.4 | OPTIMAL | 306 | 206 | 26 |

The 5 July run: chronic load collapsed to **131** after the gap, so a 10 km run scored **4.8** — nearly five times "normal" load — and training readiness bottomed at **1/100**.

That's the predicted failure mode, reproduced by a commercial implementation. It confirms Day 3 needs an explicit rule (a chronic-load floor, or suppressing ACWR until the chronic window is populated) or the system's first real notification will be a false alarm.

**And it's a gift for Day 3:** `garmin_acwr` on 85% of days is a *reference implementation* to check our own computation against. That converts "I computed acute:chronic workload ratio" into "I computed it and validated it against Garmin's, and can account for where they differ" — a materially stronger claim.

---

## 8. Migration discipline

Two things worth recording.

**drizzle-kit needs a TTY.** When it can't tell a rename from a drop-and-add, it prompts — and crashes outright under a piped shell:

```
Error: Interactive prompts require a TTY terminal
```

**Squashing unshipped migrations.** Rather than shipping `0002_rename_recording_source_to_upload_source`, I rolled back `0001`, deleted its file and snapshot, removed its journal entry, and regenerated it correctly. Twice.

The reasoning is about what a migration file is *for*: replaying state transitions that other environments have already applied. A migration that has never left one dev database has no such obligation, so a rename that exists only to correct a mistake made an hour earlier is noise in a permanent log. **Once a migration has been applied anywhere else, this stops being legitimate** and the rename is the correct move. The line is "has it shipped," not "is it convenient."

This is only cheap because the data is re-derivable: `daily_metrics` re-syncs from Garmin, `activities` re-backfills from Strava. That's a property of ingestion pipelines worth noticing — the database is a cache of somebody else's system of record.

---

## 9. What was verified

| Check | Result |
|---|---|
| `raw` retains full payload | 25 → 58 keys |
| Idempotency after schema changes | 3 full re-backfills, 28 rows each time |
| Provenance parsing | 17/17 Garmin ids extracted |
| upload_source ≠ device_name | Samsung watch: file_upload **with** HR |
| Garmin auth | profile 146268317 returned |
| Token cache | second run: no 429, "cached tokens" |
| MFA path | **not exercised** — account appears not to require it |
| Daily metrics sync | 85 days written |
| Mapping fixes | 4 → 16 of 28 fields on a known-good day |
| Idempotent upsert (`daily_metrics`) | re-synced 2026-07-26 twice, 1 row |
| RHR confound | quantified: 58.8 vs 68.5 avg |

**Not verified:** the MFA branch (never triggered), and whether Garmin's ACWR uses the same formula as the one Day 3 will implement — it's a cross-check, not ground truth, and I haven't confirmed its definition.

---

## 10. Resume-defensible claims from Day 2

**Data-source evaluation on evidence, not availability** — rejected the in-stack library on measured API surface (1 of 4 required metric families) rather than convenience, and documented the trade-off.

**Polyglot service boundaries** — a second language isolated behind a database table, confined to off-request-path batch work, with an explicit test for when that boundary would be violated.

**Reverse-engineering undocumented APIs** — mapped deeply nested, device-keyed payloads by inspecting stored responses; corrected three mappings that produced plausible-but-wrong values without raising.

**Data-quality engineering** — identified a measurement confound (RHR varying ~10 bpm with wear habits, not fitness) and added explicit quality columns so downstream logic can distinguish absent from valid.

**Provenance-based deduplication** — replaced planned heuristic matching with an exact key extracted from upstream metadata, after establishing the duplicates the heuristic targeted don't occur.

**Validating computation against a reference implementation** — Garmin's ACWR retained specifically to check Day 3's own against.

**Honest scope revision** — established with numbers that a planned feature (recovery insights from sleep/HRV) is unsupported by available data, rather than shipping it against 13% coverage.

---

## 11. What this means for Day 3

The plan's Day 3 is the analysis engine. Today's findings change its inputs, and one architectural requirement now precedes all of them.

### Capability gating (the architectural consequence)

Intermittent wear is permanent, so the engine cannot assume its inputs exist. Three requirements follow:

**1. Every rule declares its data requirements.** A rule is a computation *plus a precondition* — "HR-above-baseline-at-same-pace" needs ≥N runs with HR in the trailing window; a sleep-debt flag needs ≥N valid nights. The engine evaluates which rules are *eligible* for a given day and runs only those. Eligibility is data-driven, so rules switch themselves on when wear resumes.

**2. Baselines are regime-aware.** The sharpest edge in today's data: resting HR is 58.8 worn / 68.5 unworn. A baseline averaging across both would read a return to consistent wear as a ~10 bpm *fitness improvement* that is purely a measurement artifact. Baselines must filter to a single regime (`valid_sleep = true`) or reset when the regime changes — and warm up again after any gap, or the first day back sets a bogus reference.

**3. Silence needs two distinct meanings.** PLAN §Day 4's bar is "quiet unless it matters." Intermittent data adds a second reason for silence: *we don't know*. Conflating them is the RHR confound one layer up — absence of signal presented as evidence of normality. Notifications and dashboard must keep "you're fine" distinguishable from "watch wasn't worn."

### Concrete inputs

1. **Gate recovery insights** rather than cutting them. Sleep/HRV: 13%, no baseline, none after 14 June.
2. **Gate resting HR on `valid_sleep`.** Otherwise the baseline tracks wear habits.
3. **HR-based pace anomalies stay thin** — 5 runs with HR (Day 1 §11), unchanged.
4. **ACWR needs a layoff rule.** Garmin's 4.8 / VERY_HIGH / readiness 1 on 5 July is the concrete failure case to design against.
5. **Validate our ACWR against `garmin_acwr`** on the 72 days that have both.

The honest summary: **Garmin contributed less recovery context than the plan assumed, and more validation data than it expected — and forced a better architecture than the plan specified.**

**Commits:** `efa66bb` (raw fix), `7c26da2` (sidecar + provenance), `53cc0be` (metrics live + mapping fixes) on `day1-ingestion-foundation`.
