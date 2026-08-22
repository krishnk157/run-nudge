import Anthropic from "@anthropic-ai/sdk";

import { sql } from "@/db/client";
import { getAnchors } from "@/lib/analysis/athlete";
import { computeInsights } from "@/lib/analysis/engine";
import { MODELS } from "./models";
import { recordCall } from "./usage";

/**
 * The weekly digest — the plan's counterweight to the reactive path.
 *
 * A per-activity notification stays quiet unless something matters. The
 * digest goes out regardless, which makes it the one place the system can
 * say "nothing notable happened this week" without that being a failure.
 *
 * Same division of labour as the judge: SQL computes every number, the model
 * only decides what's worth mentioning and writes the sentences.
 */

export interface WeekStats {
  weekStart: string;
  weekEnd: string;
  /**
   * When activity data was last pulled from Strava, and how stale that is.
   *
   * This exists because of a real incident: the first live digest reported
   * "no sessions recorded" for a week in which four gym sessions happened.
   * The data was 8 days old — webhooks aren't registered yet, so nothing was
   * keeping it fresh — and the digest had no way to know it was blind.
   *
   * A confident falsehood is the worst thing a notification system can emit.
   * "No sessions" and "no data about sessions" must not look the same.
   */
  lastSyncedAt: string | null;
  daysSinceSync: number | null;
  sessions: number;
  hours: number;
  bySport: { sportType: string; sessions: number; hours: number }[];
  runs: {
    date: string;
    km: number;
    pacePerKm: string;
    avgHr: number | null;
  }[];
  distanceKm: number;
  priorWeekSessions: number;
  priorWeekHours: number;
  bodyweight: { date: string; kg: number }[];
}

/** Everything the digest reports, computed in SQL. */
export async function weekStats(asOf = new Date()): Promise<WeekStats> {
  const end = asOf.toISOString().slice(0, 10);

  const [totals] = await sql<
    {
      sessions: number;
      hours: number;
      distance_km: number;
      prior_sessions: number;
      prior_hours: number;
    }[]
  >`
    select
      count(*) filter (where started_at_local >= ${end}::date - 7)::int as sessions,
      coalesce(round((sum(moving_time_s) filter (where started_at_local >= ${end}::date - 7)/3600.0)::numeric,1),0)::float as hours,
      coalesce(round((sum(distance_m) filter (where started_at_local >= ${end}::date - 7)/1000.0)::numeric,1),0)::float as distance_km,
      count(*) filter (where started_at_local >= ${end}::date - 14
                         and started_at_local < ${end}::date - 7)::int as prior_sessions,
      coalesce(round((sum(moving_time_s) filter (where started_at_local >= ${end}::date - 14
                         and started_at_local < ${end}::date - 7)/3600.0)::numeric,1),0)::float as prior_hours
    from activities
    where started_at_local >= ${end}::date - 14`;

  const [fresh] = await sql<
    { last_sync: string | null; days: number | null }[]
  >`
    select to_char(max(ingested_at),'YYYY-MM-DD HH24:MI') as last_sync,
           extract(day from now() - max(ingested_at))::int as days
    from activities`;

  const bySport = await sql<
    { sport_type: string; sessions: number; hours: number }[]
  >`
    select sport_type,
           count(*)::int as sessions,
           round((sum(moving_time_s)/3600.0)::numeric,1)::float as hours
    from activities
    where started_at_local >= ${end}::date - 7
    group by 1 order by 2 desc`;

  const runs = await sql<
    { d: string; km: number; pace: string; avg_hr: number | null }[]
  >`
    select to_char(started_at_local,'Dy DD Mon') as d,
           round((distance_m/1000)::numeric,2)::float as km,
           to_char((round(moving_time_s / nullif(distance_m/1000,0))::int || ' seconds')::interval,'MI:SS') as pace,
           average_heartrate as avg_hr
    from activities
    where sport_type = any(array['Run','TrailRun','VirtualRun'])
      and started_at_local >= ${end}::date - 7
    order by started_at_local`;

  // Bodyweight arrives on Day 7; the query is harmless until the table exists.
  let bodyweight: { date: string; kg: number }[] = [];
  try {
    const rows = await sql<{ d: string; kg: number }[]>`
      select to_char(date,'YYYY-MM-DD') as d, weight_kg as kg
      from body_log where date >= ${end}::date - 7 order by date`;
    bodyweight = rows.map((r) => ({ date: r.d, kg: r.kg }));
  } catch {
    bodyweight = [];
  }

  return {
    lastSyncedAt: fresh?.last_sync ?? null,
    daysSinceSync: fresh?.days ?? null,
    weekStart: new Date(
      new Date(`${end}T00:00:00Z`).getTime() - 7 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10),
    weekEnd: end,
    sessions: totals?.sessions ?? 0,
    hours: totals?.hours ?? 0,
    distanceKm: totals?.distance_km ?? 0,
    priorWeekSessions: totals?.prior_sessions ?? 0,
    priorWeekHours: totals?.prior_hours ?? 0,
    bySport: bySport.map((r) => ({
      sportType: r.sport_type,
      sessions: r.sessions,
      hours: r.hours,
    })),
    runs: runs.map((r) => ({
      date: r.d,
      km: r.km,
      pacePerKm: r.pace,
      avgHr: r.avg_hr,
    })),
    bodyweight,
  };
}

export const DIGEST_SYSTEM = `You write a short weekly training summary for one athlete, from data that has already been computed.

You never compute, estimate, or adjust numbers. Every figure in your summary must appear verbatim in the input. If a number you want isn't there, write the summary without it.

# What this is

Unlike the per-activity alerts — which stay silent unless something matters — this digest goes out every week regardless. So a quiet week is a perfectly good digest. Say the week was quiet and stop; do not manufacture significance, and do not pad with encouragement.

# The findings report

Alongside the week's numbers you receive the analysis engine's current findings. Rules with status "ineligible" could NOT be evaluated — the data isn't there. Never present an ineligible rule as checked-and-fine. You may mention what would unlock a dormant rule at most once, and only when genuinely useful.

# Data freshness — do not state absence you can't vouch for

The input carries "lastSyncedAt" and "daysSinceSync": when activity data was last pulled from Strava. If "daysSinceSync" is 2 or more, sessions from the last few days may simply not have been ingested yet.

In that case you must NOT report zero or low session counts as fact. Say the data may be incomplete and give the last sync date. "No sessions were recorded" and "no sessions have been synced" are different claims, and only the second one is safe when the data is stale.

# Style

- 3 to 6 sentences, plain prose. No headings, no bullet lists, no emoji, no exclamation marks.
- Lead with what actually happened this week, then anything worth noticing about it.
- Compare to the prior week only when the comparison is meaningful.
- No medical advice and no training prescriptions.
- If there were zero sessions AND the data is fresh, say so plainly in one or two sentences. If the data is stale, say instead that none have been synced and give the last sync date.

# Output

Respond with JSON only, matching the schema. "subject" is at most 8 words, factual.`;

export interface Digest {
  subject: string;
  body: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  degraded?: string;
}

const SCHEMA = {
  type: "object" as const,
  properties: {
    subject: { type: "string" as const },
    body: { type: "string" as const },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic());

export async function writeDigest(asOf = new Date()): Promise<{
  digest: Digest;
  stats: WeekStats;
  findings: unknown;
}> {
  const stats = await weekStats(asOf);
  const anchors = await getAnchors();
  // Scheduled evaluation: no activity, so the consistency rule reports the
  // current gap rather than the gap a session just ended.
  const report = await computeInsights(null, asOf);

  const payload = JSON.stringify({ week: stats, anchors, findings: report.findings }, null, 1);

  const startedAt = Date.now();
  const response = await client().messages.create({
    model: MODELS.digest,
    max_tokens: 8000,
    // Four calls a month: no cache breakpoint, for the same reason as the
    // judge — a weekly job can never hit a five-minute cache.
    system: DIGEST_SYSTEM,
    messages: [{ role: "user", content: payload }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  });

  const usage = {
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  void recordCall({ role: "digest", ...usage, ms: Date.now() - startedAt });

  if (response.stop_reason === "refusal") {
    return {
      stats,
      findings: report.findings,
      digest: {
        subject: `Training week ${stats.weekStart} to ${stats.weekEnd}`,
        body: fallbackBody(stats),
        degraded: "refusal",
        ...usage,
      },
    };
  }

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  try {
    const parsed = JSON.parse(text) as { subject: string; body: string };
    return { stats, findings: report.findings, digest: { ...parsed, ...usage } };
  } catch {
    // The digest is scheduled and expected — unlike an alert, silence here
    // would look like a broken cron. Fall back to the plain numbers.
    return {
      stats,
      findings: report.findings,
      digest: {
        subject: `Training week ${stats.weekStart} to ${stats.weekEnd}`,
        body: fallbackBody(stats),
        degraded: "parse_error",
        ...usage,
      },
    };
  }
}

/**
 * Deterministic digest used when the model can't be relied on. Deliberately
 * dull: the point is that the weekly cadence never silently stops.
 */
export function fallbackBody(s: WeekStats): string {
  const stale =
    s.daysSinceSync != null && s.daysSinceSync >= 2
      ? ` Activity data was last synced ${s.lastSyncedAt}, ${s.daysSinceSync} days ago, so recent sessions may be missing.`
      : "";
  if (s.sessions === 0) {
    // Never assert an empty week on stale data — see WeekStats.lastSyncedAt.
    return stale
      ? `No sessions have been synced for ${s.weekStart} to ${s.weekEnd}.${stale}`
      : `No sessions recorded between ${s.weekStart} and ${s.weekEnd}.`;
  }
  const sports = s.bySport
    .map((b) => `${b.sessions} × ${b.sportType}`)
    .join(", ");
  const runLine = s.runs.length
    ? ` Runs: ${s.runs.map((r) => `${r.km} km at ${r.pacePerKm}/km`).join("; ")}.`
    : "";
  return `${s.sessions} sessions, ${s.hours} hours (${sports}).${runLine} Previous week: ${s.priorWeekSessions} sessions, ${s.priorWeekHours} hours.${stale}`;
}
