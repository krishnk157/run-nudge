/**
 * Simulate webhook events end-to-end — the Day 4 outcome test.
 *
 *   npm run simulate                     # curated set: spike, quiet, comeback
 *   npm run simulate -- --activity <id>  # one activity through the pipeline
 *   npm run simulate -- --http <id>      # POST to the local webhook route
 *                                          (requires `npm run dev` running)
 *
 * Direct mode calls processEvent() in-process: same pipeline, no HTTP, no
 * tunnel needed. --http exercises the actual route + after() path.
 *
 * Each simulated event spends real Anthropic API credits (one judge call).
 */
import "dotenv/config";

import { sql } from "@/db/client";
import { processEvent } from "@/lib/pipeline/processEvent";

const argv = process.argv.slice(2);
const arg = (f: string) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1];
};

interface Case {
  label: string;
  expect: string;
  id: number;
}

/**
 * Three activities whose correct handling we know from the Day 3 replay:
 * the ACWR spike that fired, a mid-block quiet day, and the comeback run
 * where the engine refuses a ratio and reports the 28-day gap instead.
 */
async function curatedCases(): Promise<Case[]> {
  const rows = await sql<{ id: number; d: string }[]>`
    select id, to_char(started_at_local,'YYYY-MM-DD') as d
    from activities
    where started_at_local::date in ('2026-06-01','2026-06-03','2026-07-05')
    order by started_at_local`;
  const byDate = new Map(rows.map((r) => [r.d, Number(r.id)]));
  const cases: Case[] = [];
  const want: [string, string, string][] = [
    ["2026-06-01", "load spike fired — expect notify", "spike"],
    ["2026-06-03", "all rules quiet — expect skip", "quiet"],
    ["2026-07-05", "first run in 28 days — judge's call", "comeback"],
  ];
  for (const [d, expect, label] of want) {
    const id = byDate.get(d);
    if (id) cases.push({ label: `${label} (${d})`, expect, id });
  }
  return cases;
}

async function runDirect(id: number, label: string, expect: string) {
  console.log(`\n━━ ${label}`);
  console.log(`   ${expect}`);
  const result = await processEvent(
    {
      object_type: "activity",
      object_id: id,
      aspect_type: "create",
      owner_id: 0,
    },
    "simulated",
  );
  console.log(`   pipeline: ${result.status} — ${result.detail}`);

  if (result.notificationId) {
    const [n] = await sql<
      {
        decision: string;
        severity: string | null;
        subject: string | null;
        message: string | null;
        rationale: string | null;
        input_tokens: number;
        output_tokens: number;
      }[]
    >`select decision, severity, subject, message, rationale, input_tokens, output_tokens
      from notifications where id = ${result.notificationId}`;
    console.log(`   decision: ${n.decision}${n.severity ? ` (${n.severity})` : ""}`);
    if (n.subject) console.log(`   subject:  ${n.subject}`);
    if (n.message) console.log(`   message:  ${n.message}`);
    console.log(`   rationale: ${n.rationale}`);
    console.log(`   tokens: ${n.input_tokens} in / ${n.output_tokens} out`);
  }
}

async function runHttp(id: number) {
  const res = await fetch("http://localhost:3000/api/strava/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      object_type: "activity",
      object_id: id,
      aspect_type: "create",
      owner_id: 0,
      subscription_id: 0,
      event_time: Math.floor(Date.now() / 1000),
    }),
  });
  console.log(`webhook route answered ${res.status}: ${await res.text()}`);
  console.log(
    "processing runs after the response — check notifications/webhook_events in a few seconds",
  );
}

async function main() {
  const httpId = arg("--http");
  if (httpId) return runHttp(Number(httpId));

  const oneId = arg("--activity");
  if (oneId) {
    return runDirect(Number(oneId), `activity ${oneId}`, "single activity");
  }

  for (const c of await curatedCases()) {
    await runDirect(c.id, c.label, c.expect);
  }
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("Failed:", e);
    await sql.end();
    process.exit(1);
  });
