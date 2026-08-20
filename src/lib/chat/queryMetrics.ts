import { sql } from "@/db/client";

/**
 * `query_metrics` — the chat layer's read-only SQL tool.
 *
 * This is the one place in the system where a model's output reaches the
 * database, so the guard is layered:
 *
 *  1. Postgres enforces read-only at the transaction level. This is the real
 *     protection — not the keyword checks. Even a query that defeats every
 *     string test below cannot write inside a READ ONLY transaction.
 *  2. A statement timeout, so a cartesian join can't pin the connection.
 *  3. A hard row cap, so a runaway result can't blow the context window.
 *  4. Shape checks (single statement, must start with SELECT/WITH) as cheap
 *     defence in depth and, more usefully, as fast feedback to the model.
 *
 * Ordering matters: the checks exist to give a good error message, and the
 * transaction exists to be correct. If the two ever disagree, the transaction
 * is what's keeping the data safe.
 */

export const MAX_ROWS = 200;
const STATEMENT_TIMEOUT_MS = 5_000;

export interface QueryResult {
  ok: boolean;
  rows?: Record<string, unknown>[];
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

/** Statements that must never appear, even inside a read-only transaction. */
const FORBIDDEN = [
  "insert", "update", "delete", "drop", "truncate", "alter", "create",
  "grant", "revoke", "copy", "vacuum", "reindex", "call", "do",
  "pg_read_file", "pg_ls_dir", "dblink", "pg_sleep",
];

export function validateQuery(query: string): string | null {
  const trimmed = query.trim().replace(/;\s*$/, "");

  if (!trimmed) return "empty query";

  // Multiple statements: the semicolon is the classic injection lever, and a
  // read-only transaction still happily runs a second SELECT that dumps
  // something unintended.
  if (trimmed.includes(";")) {
    return "only a single statement is allowed (no semicolons)";
  }

  const lower = trimmed.toLowerCase();
  if (!/^(select|with)\b/.test(lower)) {
    return "only SELECT (or WITH ... SELECT) queries are allowed";
  }

  for (const word of FORBIDDEN) {
    // Word-boundary match so a column called `created_at` doesn't trip
    // on "create", and `updated_at` doesn't trip on "update".
    if (new RegExp(`\\b${word}\\b`).test(lower)) {
      return `the keyword "${word}" is not allowed`;
    }
  }
  return null;
}

/**
 * Postgres rows arrive with live JS values — `Date` objects for timestamps,
 * and `bigint` for some counts. Tool results have to be plain JSON: the AI
 * SDK validates them against a JSON-value schema when it folds them back
 * into the conversation, and a `Date` fails that check.
 *
 * Found the hard way: the first tool call succeeded, then step two of the
 * loop died with "The messages do not match the ModelMessage[] schema" and
 * the answer truncated mid-sentence. The tool had worked; serialising it
 * back into the prompt was what broke.
 */
function toJsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (typeof v === "bigint") out[k] = v.toString();
    else if (v && typeof v === "object" && !Array.isArray(v)) {
      // jsonb columns and nested composites: round-trip to strip any
      // non-JSON values hiding inside.
      out[k] = JSON.parse(JSON.stringify(v));
    } else out[k] = v;
  }
  return out;
}

export async function queryMetrics(query: string): Promise<QueryResult> {
  const invalid = validateQuery(query);
  if (invalid) return { ok: false, error: invalid };

  const trimmed = query.trim().replace(/;\s*$/, "");

  try {
    const rows = await sql.begin(async (tx) => {
      // The load-bearing line. Postgres refuses any write in this transaction
      // regardless of what the query text managed to smuggle past the checks.
      await tx.unsafe("SET TRANSACTION READ ONLY");
      await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
      return tx.unsafe(`${trimmed} LIMIT ${MAX_ROWS + 1}`);
    });

    const list = (rows as unknown as Record<string, unknown>[]).map(toJsonSafe);
    const truncated = list.length > MAX_ROWS;

    return {
      ok: true,
      rows: truncated ? list.slice(0, MAX_ROWS) : list,
      rowCount: truncated ? MAX_ROWS : list.length,
      truncated,
    };
  } catch (e) {
    // Errors go back to the model verbatim: a syntax error or a bad column
    // name is information it can act on, and hiding it just produces a
    // confident wrong answer instead of a corrected query.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Schema shown to the model.
 *
 * Deliberately hand-written rather than generated from information_schema:
 * the column list is the easy half, and the traps are the valuable half.
 * `started_at_local` being timezone-naive on purpose, or `resting_hr` being
 * meaningless unless `valid_sleep` is true, are the things that turn a
 * syntactically fine query into a wrong answer.
 */
export const SCHEMA_DOC = `## activities — one row per Strava activity
id (bigint, Strava's id), athlete_id, name, sport_type
started_at (timestamptz, real instant), started_at_local (timestamp WITHOUT tz — wall clock; use this for "what day/time did I train")
distance_m (double), moving_time_s (int), elapsed_time_s (int), total_elevation_gain_m
average_speed_mps, max_speed_mps
has_heartrate (bool), average_heartrate, max_heartrate, average_cadence
suffer_score, kilojoules, is_trainer, is_manual, is_race, gear_id
external_id, device_name, upload_source ('garmin' | 'file_upload' | 'other'), garmin_activity_id
raw (jsonb, full Strava payload), ingested_at, updated_at

Running sport types are 'Run', 'TrailRun', 'VirtualRun'. Strength is 'WeightTraining'.
Pace: moving_time_s / (distance_m/1000) gives seconds per km.

## daily_metrics — one row per calendar day of Garmin wellness data
date (date, PK), sleep_seconds, deep/light/rem_sleep_seconds, awake_seconds, sleep_score
resting_hr, hrv_last_night_avg_ms, hrv_status, vo2max_running
training_status, training_readiness_score, recovery_time_seconds
acute_training_load, chronic_training_load, garmin_acwr, garmin_acwr_status
body_battery_charged, body_battery_drained, average_stress, steps
valid_sleep (bool), stress_sample_count, raw (jsonb), fetched_at

IMPORTANT: every column here is nullable — a day the watch wasn't worn has no data.
resting_hr is only comparable when valid_sleep is true; on other days it is a daytime
minimum roughly 10 bpm higher, and mixing the two produces a meaningless trend.
Sleep and HRV exist for only ~11 days (18 May – 14 Jun 2026).

## notifications — every judgment, sent or withheld
id, created_at, trigger ('webhook'|'cron'|'simulated'), activity_id
decision ('notify'|'skip'|'error'), severity, subject, message, rationale
findings (jsonb, the full analysis report), model, input_tokens, output_tokens
status ('drafted'|'sent'|'send_failed'), channel, external_id, sent_at, error

## webhook_events — raw Strava deliveries and their processing outcome
id, received_at, object_type, object_id, aspect_type, status, error, raw, processed_at

## strava_tokens, sync_state — plumbing; rarely useful for questions.`;
