# RunNudge

A proactive training-insights system over my own Strava + Garmin running data. It reacts to runs as they happen — ingesting, analyzing, and notifying — rather than waiting to be asked.

See [docs/PLAN.md](docs/PLAN.md) for the full plan and rationale.

## Status

**Day 2 — Garmin daily metrics + activity provenance.** Strava OAuth and a resumable full-history backfill (Day 1), plus a Python sidecar syncing Garmin wellness data into `daily_metrics`.

## Stack

- Next.js (App Router) + TypeScript
- Neon Postgres + Drizzle ORM
- Strava REST API v3 (OAuth 2 + webhooks)
- Python sidecar for Garmin Connect (unofficial API) — isolated; the app never imports it

## Setup

### 1. Environment

```bash
cp .env.example .env
openssl rand -hex 24   # paste as ADMIN_TOKEN
```

Fill in `DATABASE_URL` from Neon (use the **pooled** connection string — its host contains `-pooler`).

### 2. Create a Strava API application

At <https://www.strava.com/settings/api>:

- **Authorization Callback Domain:** `localhost` for local development
- Copy the Client ID and Client Secret into `.env`

The OAuth redirect URI is derived as `$APP_URL/api/strava/callback` — nothing to configure beyond the callback domain.

### 3. Migrate

```bash
npm run db:migrate
```

### 4. Connect Strava

```bash
npm run dev
```

Then visit `http://localhost:3000/api/strava/authorize?token=<ADMIN_TOKEN>` and accept **all** permissions. The callback rejects a partial grant: without `activity:read_all` the backfill silently skips private activities.

### 5. Backfill

```bash
npm run backfill                    # full history, resumable
npm run backfill -- --since 2024-01-01
npm run backfill -- --restart       # ignore the checkpoint
```

Progress is checkpointed to `sync_state` after every page, so a rate limit or a crash costs one page rather than the whole run. Strava's default quota is 200 requests per 15 minutes; the client reads the quota headers, warns near the ceiling, and waits out a 429 instead of failing.

### 6. Garmin (optional)

Garmin has no official consumer API, so this uses the community `garminconnect`
library from an isolated Python sidecar. The Next.js app never imports it — the
two sides meet only at the `daily_metrics` table.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Add your Garmin Connect login to `.env` (`GARMIN_EMAIL`, `GARMIN_PASSWORD`),
then:

```bash
.venv/bin/python scripts/garmin_sync.py --days 7
.venv/bin/python scripts/garmin_sync.py --since 2026-05-17
.venv/bin/python scripts/garmin_sync.py --date 2026-07-26
```

If the account has MFA, run it from a real terminal the first time so the code
prompt can be answered. Tokens are then cached in `.garmin-tokens/` (gitignored)
and later runs are unattended — which matters, because repeated password logins
are what gets a Garmin account rate-limited.

## Scripts

| Command                                     | Purpose                                      |
| ------------------------------------------- | -------------------------------------------- |
| `npm run dev`                               | Next.js dev server                           |
| `npm run db:generate`                       | Generate a migration from `src/db/schema.ts` |
| `npm run db:migrate`                        | Apply pending migrations                     |
| `npm run db:studio`                         | Drizzle Studio — browse the data             |
| `npm run backfill`                          | Pull Strava history into the DB              |
| `npm run typecheck`                         | `tsc --noEmit`                               |
| `.venv/bin/python scripts/garmin_sync.py`   | Pull Garmin daily metrics into the DB        |

> `db:generate` prompts interactively when it can't tell a column rename from a
> drop-and-add, so it needs a real terminal — it will crash under a piped shell.

## Layout

```
src/
  app/api/strava/
    authorize/      OAuth entrypoint (gated by ADMIN_TOKEN)
    callback/       code exchange + scope validation
  db/
    schema.ts       activities, strava_tokens, sync_state
    client.ts       Drizzle over postgres.js
  lib/
    env.ts          lazily validated environment
    strava/
      oauth.ts      token exchange, refresh, persistence
      client.ts     API client with rate-limit handling
      normalize.ts  SummaryActivity -> activities row
      types.ts      zod schemas for Strava payloads
    ingest/
      activities.ts idempotent upsert + sync checkpoints
scripts/
  backfill.ts       resumable history backfill
drizzle/            generated SQL migrations
```

## Design notes

**Tokens are read in exactly one place.** `getAccessToken()` refreshes and persists before returning, so no caller can use a stale token. Strava rotates the refresh token on refresh, so whatever comes back is always what gets stored.

**Every activity keeps its raw payload.** Normalized columns carry what the analysis engine needs; `activities.raw` keeps the untouched JSON, so adding a column later is a migration rather than a re-backfill.

**Ingestion is idempotent.** The backfill and (later) webhook delivery share one upsert keyed on Strava's activity id — a duplicate webhook or a re-run backfill can't create a second row, and a renamed activity overwrites cleanly.

**Local time is stored separately.** Strava's `start_date_local` is an ISO string with a misleading `Z`; the digits are wall-clock. It lands in a `timestamp without time zone` so "a Tuesday morning run" survives travel and server timezones.
