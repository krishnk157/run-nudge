# Day 1: Ingestion Foundation

**Date:** 2026-08-05
**Plan reference:** [PLAN.md](PLAN.md) §5, Day 1
**Stated outcome:** *"entire Strava history in your own DB, tokens refreshing properly"*
**Result:** Achieved. 28 activities (14 runs) for athlete 202185551, spanning 2026-01-24 → 2026-07-26, in Neon Postgres. Token refresh plumbing verified, with one caveat documented in §9.

---

## 1. Why Day 1 is ingestion and nothing else

The plan's core claim (§1) is that this system *initiates* rather than answers. Everything that makes that true, trend computation, anomaly detection, the LLM significance judgment, is downstream of one thing: **owning the data**.

That's not a formality. A chat session with a Strava MCP can fetch your last 10 activities on demand. It cannot compute a 4-week rolling baseline, because it has no memory between sessions and no place to put derived state. The database *is* the differentiator. Day 1 builds the pipe that fills it.

So the day has exactly one job: get every activity out of Strava and into Postgres, in a form the analysis engine can query, through a path that will keep working unattended for months.

That last clause is what makes it more than a `fetch` loop.

---

## 2. What was built

```
Browser                Next.js                    Strava API           Neon Postgres
   │                      │                            │                     │
   │  /authorize?token=   │                            │                     │
   ├─────────────────────►│                            │                     │
   │                      │ verify ADMIN_TOKEN         │                     │
   │                      │ set CSRF state cookie      │                     │
   │  302 → strava.com    │                            │                     │
   │◄─────────────────────┤                            │                     │
   │                                                   │                     │
   │  user grants scopes                               │                     │
   ├──────────────────────────────────────────────────►│                     │
   │                                                   │                     │
   │  302 → /callback?code=…&state=…                   │                     │
   │◄──────────────────────────────────────────────────┤                     │
   ├─────────────────────►│                            │                     │
   │                      │ verify state, verify scope │                     │
   │                      │ POST /oauth/token (code)   │                     │
   │                      ├───────────────────────────►│                     │
   │                      │◄───── access + refresh ────┤                     │
   │                      ├──────── upsert tokens ─────────────────────────► │
   │                      │                            │                     │

scripts/backfill.ts   (run locally, not serverless)
   │  getAccessToken() ──── refresh if near expiry ────►│
   │  GET /athlete/activities?after=…&page=N ──────────►│
   │◄──────────────── 100 activities ──────────────────┤
   │  normalize → upsert (idempotent) ────────────────────────────────────► │
   │  checkpoint cursor ──────────────────────────────────────────────────► │
   └─ repeat until short page
```

**Files:**

| File | Responsibility |
|---|---|
| [src/db/schema.ts](../src/db/schema.ts) | `activities`, `strava_tokens`, `sync_state` |
| [src/db/client.ts](../src/db/client.ts) | Lazily-connected Drizzle handle |
| [src/lib/env.ts](../src/lib/env.ts) | Zod-validated environment, lazily |
| [src/lib/strava/types.ts](../src/lib/strava/types.ts) | Zod schemas for Strava payloads |
| [src/lib/strava/oauth.ts](../src/lib/strava/oauth.ts) | Code exchange, refresh, token persistence |
| [src/lib/strava/client.ts](../src/lib/strava/client.ts) | API client with rate-limit handling |
| [src/lib/strava/normalize.ts](../src/lib/strava/normalize.ts) | `SummaryActivity` → DB row |
| [src/lib/ingest/activities.ts](../src/lib/ingest/activities.ts) | Idempotent upsert, sync checkpoints |
| [src/app/api/strava/authorize/route.ts](../src/app/api/strava/authorize/route.ts) | OAuth entrypoint |
| [src/app/api/strava/callback/route.ts](../src/app/api/strava/callback/route.ts) | OAuth callback |
| [scripts/backfill.ts](../scripts/backfill.ts) | Resumable history backfill |

---

## 3. OAuth 2.0, the authorization code flow

### The concept

OAuth exists to solve one problem: *let an application act on a user's behalf without the user handing over their password.* The authorization code flow does this in two hops, and understanding **why it's two hops** is the whole point.

1. **Front channel (browser).** We redirect the user to Strava. Strava authenticates them (we never see credentials) and shows a consent screen. Strava redirects back to us with a short-lived, single-use `code`.
2. **Back channel (server-to-server).** Our server POSTs that `code` *plus our client secret* to Strava's token endpoint, and gets back an access token.

The split matters because the front channel is visible, the `code` travels through the user's browser, through redirects, into history and logs. It's therefore treated as public and near-worthless on its own: it expires in seconds, works once, and is useless without the client secret, which never leaves our server.

**Interview framing:** *"The code is exchanged server-side because the front channel is untrusted. The code alone can't get a token, it must be presented with the client secret, which only the server holds."*

### The token on Strava's settings page

Strava's API settings page displays "Your Access Token" and "Your Refresh Token", which looks like it should let you skip all of this. It doesn't, and understanding why is a scope lesson.

That token is minted with `read` scope only. `read` covers your public profile and public segments. **It cannot list activities at all.** Using it, the backfill would return empty or 401.

We need `activity:read_all`, and a token carrying that scope can only be produced by a user explicitly consenting to it, which is exactly what the authorization flow is *for*. There is no shortcut, by design: the consent screen is the mechanism by which a scope becomes legitimate.

### Scopes requested

```ts
export const REQUIRED_SCOPES = "read,activity:read_all,profile:read_all";
```

`activity:read_all` (rather than `activity:read`) is the one that matters, without it, **private activities are silently omitted**. Not an error, not a warning: they simply aren't in the response. A backfill would appear to succeed and quietly under-report training load, and you'd only discover it weeks later when the numbers looked wrong.

That silence is why [callback/route.ts](../src/app/api/strava/callback/route.ts) rejects a partial grant:

```ts
const granted = (params.get("scope") ?? "").split(",").filter(Boolean);
const missing = REQUIRED_SCOPES.split(",").filter((s) => !granted.includes(s));
if (missing.length > 0) { /* 400 */ }
```

Strava's consent screen lets the user untick individual permissions. Failing loudly at connect time is far cheaper than debugging a data gap in month three.

**Generalizable principle:** *when a failure mode is silent, convert it into a loud one at the earliest boundary you control.*

### CSRF protection via `state`

The `state` parameter defends against a login-CSRF attack: an attacker completes an authorization flow with *their own* Strava account, captures the resulting callback URL, and tricks you into visiting it, silently connecting your RunNudge to their Strava data (or, in the reverse framing, their account to your session).

The defense is a nonce the attacker can't produce:

```ts
const state = randomBytes(16).toString("hex");
res.cookies.set(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: "lax", maxAge: 600 });
```

The callback requires the `state` Strava echoes back to equal the value in the `httpOnly` cookie. An attacker can forge the URL parameter but cannot set a cookie on your browser for our origin. Both must match, so both must have come from a flow *you* started.

Note `httpOnly`, it keeps the nonce out of reach of any JavaScript on the page, so an XSS bug can't read it and reconstruct a valid callback.

### Gating the entrypoint

This is a single-user system on a public URL, so `/api/strava/authorize` is protected by a shared secret compared in constant time:

```ts
function safeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
```

`timingSafeEqual` rather than `===` because a naive string comparison short-circuits on the first differing byte. The time it takes to fail therefore leaks how many leading characters were correct, and an attacker can recover the secret one byte at a time. The mitigation costs one line.

Worth being precise about the threat model: without the gate, a stranger hitting the URL would begin an OAuth flow and, if they completed it with their own Strava account, overwrite the stored tokens. Not catastrophic here, but it's a free defense on an endpoint that has no business being public.

---

## 4. Token lifecycle

Strava access tokens expire every 6 hours. A system meant to run unattended for months must refresh them without human involvement, and must never present a stale one.

### One chokepoint

Every caller obtains tokens through exactly one function:

```ts
export async function getAccessToken(athleteId?: number): Promise<{...}> {
  const stored = /* read from DB */;
  const expiresSoon = stored.expiresAt.getTime() - Date.now() < REFRESH_SKEW_MS;
  if (!expiresSoon) return { athleteId, accessToken: stored.accessToken };
  const refreshed = await postToken({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
  await persistTokens(stored.athleteId, refreshed);
  return { athleteId: stored.athleteId, accessToken: refreshed.access_token };
}
```

Nothing else reads `strava_tokens`. This is a deliberate structural choice: if three call sites each read the table and decide independently whether to refresh, then sooner or later one of them forgets, and you get an intermittent 401 that only appears six hours into a session. Centralizing makes the correct behavior the *only* available behavior.

**Interview framing:** *"Token freshness is an invariant, so I enforced it at a single chokepoint rather than trusting every caller to check."*

### The 5-minute skew

```ts
const REFRESH_SKEW_MS = 5 * 60 * 1000;
```

We refresh when the token is *about* to expire, not when it has. Without the skew there's a race: you check at T−1s, the check passes, then network latency and request queuing push actual use past expiry, and you get a 401 for a token you just validated. The skew converts a timing race into a non-event.

### Refresh tokens rotate

```ts
// Strava returns refresh_token on refresh too, and it can change.
```

Strava may return a **new** refresh token on each refresh. If you keep reusing the original, it eventually stops working and the integration dies silently until someone re-authorizes by hand. `persistTokens()` therefore always writes back whatever came in the response.

One subtlety in the upsert:

```ts
...(row.scope ? { scope: row.scope } : {}),
```

Strava omits `scope` on refresh responses. A blind overwrite would null out a column we rely on to know what access we hold. Conditional write preserves it.

---

## 5. Rate limiting

Strava's default quota: **200 requests per 15 minutes, 2000 per day.** Exceeding it returns 429.

Every response carries the current state:

```
X-RateLimit-Limit: 200,2000
X-RateLimit-Usage: 13,412
```

The client parses these on every response, so quota is observed rather than guessed:

```ts
const [shortTermLimit, dailyLimit] = limit.split(",").map(Number);
const [shortTermUsage, dailyUsage] = usage.split(",").map(Number);
```

### The window is absolute, not rolling

This is the non-obvious part. Strava's 15-minute window is aligned to the wall clock, it resets at :00, :15, :30, :45, **not** 15 minutes after your first request. So the correct backoff is "sleep until the next quarter hour", not "sleep 15 minutes":

```ts
function msUntilWindowReset(now = new Date()): number {
  const next = new Date(now);
  next.setMinutes(Math.floor(now.getMinutes() / 15) * 15 + 15, 0, 0);
  return next.getTime() - now.getTime();
}
```

If you hit the limit at 10:14, the naive approach sleeps until 10:29, wasting 14 minutes of a window that opened at 10:15.

### Waiting is opt-in

```ts
waitOnRateLimit?: boolean;  // backfill wants this; a webhook does not
```

Different callers want different behavior, and conflating them is a real bug source. A backfill is a long batch job: sleeping 8 minutes is fine. A **webhook handler must never sleep**, Strava expects a response within seconds and will retry if you stall, and on serverless you'd be paying for a held-open function that's about to be killed by the platform timeout anyway. Same client, explicit per-caller policy.

**Interview framing:** *"Retry policy is a property of the caller's latency budget, not of the API client. So I made it a parameter."*

---

## 6. Data modeling

### Normalized columns *and* raw JSON

> **Correction (Day 2).** As written on Day 1 this described an intent the code did not implement. `normalizeActivity` persisted the *zod-parsed* object, and `z.object()` strips unknown keys, so `raw` held only the ~25 fields that already had columns, and had none of the schema-evolution insurance described below. Fixed in `efa66bb` by switching to `z.looseObject()`; `raw` now carries 58 fields. See [DAY-2.md](DAY-2.md) §2.

Every activity is stored twice: parsed into typed columns, and as the untouched Strava payload.

The reasoning is about the cost of being wrong. Analysis queries need typed, indexed columns, you cannot efficiently compute a rolling average over JSON extraction. But the schema *will* be wrong: on Day 3 the analysis engine will want a field nobody anticipated. With `raw`, that's `ALTER TABLE` plus a backfill from data already local. Without it, it's re-fetching your entire history from a rate-limited API.

The storage cost is trivial. The optionality is not.

### Units in column names

```ts
distanceM, movingTimeS, averageSpeedMps, totalElevationGainM
```

`distance` is ambiguous, metres, kilometres, miles? `distanceM` is not. This is cheap insurance against the class of bug where you divide a distance in miles by a time in seconds three files away and get a plausible-looking wrong number. Strava returns SI, so the columns are SI, and the names say so.

### Natural primary key

```ts
id: bigint("id", { mode: "number" }).primaryKey(),  // Strava's activity id
```

Using Strava's ID rather than a generated surrogate makes deduplication *structural*. `ON CONFLICT (id)` requires no lookup, no matching heuristic, and no application logic. The database enforces "one row per Strava activity" as an invariant rather than as a convention.

This will matter on Day 4: webhook delivery is at-least-once, so duplicates are guaranteed, and the correct handling has to be free.

### Indexes chosen from query shape

```ts
index("activities_athlete_started_idx").on(t.athleteId, t.startedAt),
index("activities_sport_type_idx").on(t.sportType),
```

Every analytical query Day 3 will run has the shape *"this athlete's activities in a time window."* The composite index matches that access pattern, in that column order, `athleteId` first because it's the equality predicate, `startedAt` second because it's the range scan. Reversing them would make the index far less useful.

---

## 7. The timezone trap

This one is worth internalizing, because it's the kind of bug that survives to production and corrupts analysis silently.

Strava returns two timestamps:

```json
"start_date":       "2026-03-10T01:32:11Z",
"start_date_local": "2026-03-10T07:02:11Z"
```

**`start_date_local` is lying.** That trailing `Z` means UTC. The digits are *local wall-clock time* (07:02 in Asia/Kolkata). The field is local time wearing a UTC costume.

Parse it naively with `new Date()` and you get an instant 5½ hours off. Every "what time of day do you run?" query, every day-of-week bucket, every weekly aggregation near a week boundary silently shifts.

The fix has two halves, parsing, and *where you put it*:

```ts
function parseLocalWallClock(startDateLocal: string): Date {
  const naive = startDateLocal.replace(/Z$/, "");
  return new Date(`${naive}Z`);
}
```

```ts
startedAt:      timestamp("started_at", { withTimezone: true }),       // real instant
startedAtLocal: timestamp("started_at_local", { withTimezone: false }), // wall clock
```

Two columns for two genuinely different questions:

- **"How long ago was this?"** → `startedAt`, an absolute instant, timezone-aware.
- **"Was this a Tuesday morning run?"** → `startedAtLocal`, wall clock, timezone-*naive on purpose*.

`timestamptz` is right for the first and wrong for the second. If you store wall-clock time in a `timestamptz`, Postgres will helpfully convert it on the way out according to the session timezone, and a run you did at 7am while travelling becomes a 1:30am run in your stats.

**Verified:** the fixture test confirmed `01:32:11Z` and local `07:02:11` both survived the round trip intact.

Strava's `timezone` field also arrives as `"(GMT+05:30) Asia/Kolkata"`; [normalize.ts](../src/lib/strava/normalize.ts) strips the display prefix and keeps the IANA identifier, which is the part that's actually usable for date arithmetic.

---

## 8. Idempotent ingestion & resumable backfill

### One upsert, two callers

```ts
await db.insert(activities).values(rows).onConflictDoUpdate({
  target: activities.id,
  set: { name: raw`excluded.name`, /* …every mutable column… */ },
});
```

`excluded` is the Postgres pseudo-table holding the row that *would* have been inserted. `ON CONFLICT DO UPDATE SET x = excluded.x` means "if it exists, overwrite with the new values."

Both the backfill and (from Day 4) the webhook go through this one function. That gives three properties for free:

- Re-running the backfill is safe.
- Duplicate webhook deliveries are safe.
- Editing an activity in Strava (rename, changed type, corrected distance) propagates on the next sync instead of leaving a stale row.

**Verified on real data:** ran `npm run backfill -- --restart`, which re-fetched all 28 activities from scratch. Row count stayed 28. The fixture test additionally confirmed a re-upsert with a changed name updates in place rather than inserting.

### Checkpointing

```ts
cursor.after = newest;
await setSyncState(CURSOR_KEY, cursor);   // after every page
```

Progress is persisted to `sync_state` after **every page**, not at the end. A rate limit, a dropped connection, or a `Ctrl-C` costs one page of work, not the whole run.

This pairs with a deliberate parameter choice: passing `after` makes Strava return activities in **ascending** start-date order. That's what makes a single scalar cursor sufficient, "everything before this timestamp is done" is only a coherent statement if you're walking forward in time. With the default descending order you'd need to track a page number, which breaks the moment new activities are added mid-backfill and shift the pagination.

### Why the backfill is a local script

The plan (§9) flagged this as a risk, and it's real. A multi-year history is hundreds of sequential API calls, potentially with multi-minute rate-limit waits. Vercel functions have a hard execution ceiling. Running it as `npm run backfill` on your own machine sidesteps the constraint entirely for a one-time operation.

**The general lesson:** serverless is excellent for short reactive work (webhooks, Day 4) and poor for long batch work. Recognizing which one you have is a design decision, not an implementation detail.

---

## 9. What was verified, and what wasn't

Being precise here matters more than sounding finished, an overclaimed doc is worse than no doc when you're preparing to defend this.

### Verified against the real system

| Check | Result |
|---|---|
| Migration applied to Neon | 3 tables, both indexes present |
| `sync_state` round-trip | Value written and read back |
| Normalization | Fixture → correct typed columns |
| Local wall clock preserved | `07:02:11` local / `01:32:11Z` UTC both intact |
| Timezone parsing | `(GMT+05:30) Asia/Kolkata` → `Asia/Kolkata` |
| `workout_type: 1` → `isRace` | `true` |
| `raw` JSONB round-trip | Payload readable |
| Upsert idempotency | Re-upsert with new name → 1 row, updated |
| Auth gate | Missing token 401, wrong token 401 |
| Authorize redirect | Correct `client_id`, all 3 scopes, CSRF cookie set |
| Callback rejects bad `state` | 400 |
| Callback rejects denied grant | 400 |
| Real OAuth flow | 200, all 3 scopes granted |
| Full backfill | 28 activities, 14 runs |
| Idempotency on real data | `--restart` re-fetch → still 28 rows |
| Drizzle type mapping | `bigint` → `number`, timestamps → `Date` |

### Partially verified, token refresh

The stored expiry was forced into the past, `getAccessToken()` was called, and a subsequent API call succeeded. So the mechanism works end to end: expiry detected, refresh request sent, response persisted, resulting token usable.

**But Strava returned the same access token with the expiry advanced by one second**, because from Strava's side the token had not genuinely expired; only our stored copy of the expiry had been tampered with. So the **rotation branch is untested**: we have not observed Strava issuing a new access token, nor a rotated refresh token, nor confirmed our persistence handles that correctly.

That path will exercise itself naturally within ~6 hours of real elapsed time. Until then it's code that looks right and is unproven, and it should be described that way.

### Not attempted on Day 1

Webhooks (Day 4), Garmin (Day 2), any analysis (Day 3), deployment (Day 7).

---

## 10. Bugs hit today

Real ones, with their causes, these tend to be the most interview-useful part of a day.

### The build failed on a database connection

`next build` failed with `DATABASE_URL is not set`. The cause: [client.ts](../src/db/client.ts) created its Postgres connection at **module evaluation time**, and `next build` imports every route module to collect page metadata. The build machine has no database credentials and no business having them.

The fix was to defer connection to first use, behind a `Proxy` so call sites keep reading as plain objects:

```ts
export const db: Db = lazy(getDb);
```

**The lesson generalizes well beyond this bug:** module-level side effects run at import time, and import time is not always request time. Build tools, test runners, and type generators all import your modules without intending to *run* your application.

### The lazy proxy broke a callable

First version used `new Proxy({} as T, ...)`. That works for `db` (a plain object) but silently breaks `sql`, because postgres.js's `sql` is a **function** used as a tagged template: `` sql`select 1` ``. A Proxy can only trap `apply` if its target is callable.

```ts
const callableStub = function () {} as unknown as T;
return new Proxy(callableStub, { get, has, apply });
```

Caught by reasoning about the type rather than by a test, worth noting as a gap, since nothing in the suite would have failed until the first tagged-template call.

### Two bugs in my own verification code

Both in throwaway scripts, but instructive:

1. Asserted `row.started_at_local.toISOString()` on a result from raw `sql`. postgres.js returns timestamps as strings there; **Drizzle** is what maps them to `Date`. Re-checked through Drizzle: `startedAtLocal instanceof Date` → `true`.
2. Formatted a run's `moving_time` as `MI:SS`, which silently truncates the hours, a 1:15:11 run displayed as "15:11". The data was correct; the query was wrong.

**Worth sitting with:** the second one produced a *plausible* wrong number. Nothing errored. This is precisely the failure mode Day 3's analysis engine is exposed to, and the reason the plan (§Day 3) insists on sanity-checking computed output against training you actually remember. A metric that's wrong but believable is more dangerous than one that crashes.

---

## 11. What the data revealed

The backfill surfaced three facts that constrain Day 3's design. Finding them now is the payoff for loading real history early rather than developing against synthetic data.

**1. Heart-rate data begins 2026-05-17, 5 of 14 runs.** Earlier runs were recorded on the Strava mobile app with no wearable. This isn't a data-quality bug, it's a device history. But it means the plan's "HR-above-baseline-at-same-pace" rule (§Day 3) has at most 2 samples in any 30-day window. That's not a baseline. The rule needs a minimum-sample gate that keeps it silent until there's enough history, which fits the plan's "quiet unless it matters" bar rather than fighting it.

**2. There's a two-month training gap: 2026-03-15 → 2026-05-17.** This breaks acute:chronic workload ratio in a specific, predictable way. Chronic load (the 4-week baseline) decays toward zero across a layoff, so the first run back divides by nearly nothing and the ratio explodes. Untreated, the 17 May return would register as a catastrophic load spike. Day 3 needs an explicit rule, a chronic-load floor, or suppressing ACWR until the chronic window is populated.

**3. `device_name` is null on every row.** ~~Not missing data: Strava returns it on the *detail* activity endpoint, never on the *summary* endpoint the backfill uses.~~

> **Correction (Day 2): this was wrong.** `device_name` *is* present on the summary endpoint. It read null because of the `raw`-stripping bug above, zod discarded it before storage. The same bug hid `external_id`, which turned out to carry exact Garmin provenance and made Day 2's planned timestamp+distance dedup unnecessary. Every row now has a device name (`Garmin Forerunner 265`, `Strava App`, `Samsung Galaxy Watch4`). See [DAY-2.md](DAY-2.md) §3.
>
> Worth noting how the error was made: I inferred a cause ("the summary endpoint omits it") that fit the evidence, rather than checking. A null column has at least two explanations, the source didn't send it, or something dropped it in transit, and I tested neither.

---

## 12. Resume-defensible claims from Day 1

Mapped to PLAN.md §7, with the specific evidence:

**OAuth 2.0 token lifecycle management**, authorization code flow with CSRF `state`, scope validation that rejects partial grants, automatic refresh with rotation handling and expiry skew, enforced through a single chokepoint.

**Rate-limit-aware API integration**, quota headers parsed from every response, backoff aligned to the provider's absolute window boundary rather than a naive fixed sleep, retry policy parameterized by caller latency budget.

**Idempotent data ingestion**, natural-key upsert shared by batch and event-driven paths, verified by re-running a full backfill against live data.

**Resumable batch processing**, per-page checkpointing to durable storage; cursor design that depends on a deliberate ordering choice in the API call.

**Schema design for analytical workloads**, typed columns for query performance alongside raw payload retention for schema evolution; composite index ordered to the actual access pattern; correct `timestamptz` vs `timestamp` distinction driven by what each column *means*.

**Serverless constraint awareness**, long batch work deliberately kept out of a function with an execution ceiling; connection lifecycle designed for both build-time import and per-invocation pooling.

The honest framing for any of these in an interview is the *trade-off*, not the feature. "I stored the raw payload as well as normalized columns" is a fact. "I stored both because I expected the schema to be wrong by Day 3, and re-fetching from a rate-limited API is far more expensive than disk" is an answer.

---

## 13. Day 2 preview

Garmin daily metrics + dedup. The plan (§Day 2) flags it as the likeliest day to slip, unofficial API, no stability guarantees. Fallback is Strava-only, per plan.

Carrying forward:

- Dedup gets harder than Day 1's natural key: Garmin and Strava assign **different IDs to the same run**, so matching becomes a heuristic on timestamp + distance rather than a primary-key conflict.
- Per-field source-of-truth (Garmin wins HR, Strava wins the activity record) means the merge is field-level, not row-level.
- `device_name` being summary-endpoint-absent (§11) is relevant to how provenance gets decided.
- Transactions will matter for the merge, which is why postgres.js was chosen over Neon's HTTP driver, whose serverless mode can't do multi-statement transactions.

**Commit:** `fca50f1` on branch `day1-ingestion-foundation`.
