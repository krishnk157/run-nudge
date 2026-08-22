/**
 * What this system costs to run, from recorded usage rather than estimate.
 *
 * `npm run cost`
 */
import "dotenv/config";

import { sql } from "@/db/client";
import { costOf, MODELS, PRICES } from "@/lib/llm/models";

interface Row {
  role: string;
  model: string;
  calls: number;
  inp: number;
  outp: number;
  cread: number;
  cwrite: number;
  days: number;
}

async function main() {
  console.log("roles in force:", MODELS, "\n");

  const rows = await sql<Row[]>`
    select role, model,
           count(*)::int                        as calls,
           sum(input_tokens)::int               as inp,
           sum(output_tokens)::int              as outp,
           sum(cache_read_tokens)::int          as cread,
           sum(cache_write_tokens)::int         as cwrite,
           greatest(1, extract(day from (now() - min(created_at)))::int) as days
    from llm_calls group by 1,2 order by 1`;

  if (rows.length === 0) {
    console.log("no calls recorded yet — run a question or a judgment first");
    await sql.end();
    return;
  }

  let total = 0;
  let perDay = 0;
  for (const r of rows) {
    const cost = costOf({
      model: r.model,
      inputTokens: r.inp,
      outputTokens: r.outp,
      cacheReadTokens: r.cread,
      cacheWriteTokens: r.cwrite,
    });
    total += cost;
    perDay += cost / r.days;

    // What the same traffic would have cost before the roles were split out.
    // `r.inp` is already the total including cached tokens, so nothing is
    // added back here — passing no cache figures prices every token at full
    // input rate, which is what "uncached Opus" means.
    const asOpus = costOf({
      model: "claude-opus-5",
      inputTokens: r.inp,
      outputTokens: r.outp,
    });

    console.log(
      `${r.role.padEnd(7)} ${r.model.padEnd(17)} calls=${String(r.calls).padStart(3)}  ` +
        `in=${String(r.inp).padStart(6)} out=${String(r.outp).padStart(6)} ` +
        `cache r/w=${r.cread}/${r.cwrite}\n` +
        `        $${cost.toFixed(4)}   (all-Opus, uncached: $${asOpus.toFixed(4)})`,
    );
  }

  console.log(`\ntotal recorded: $${total.toFixed(4)}`);
  console.log(`run rate:       ~$${(perDay * 30).toFixed(2)}/month`);
  console.log("\nlist prices $/Mtok:", PRICES);
  await sql.end();
}

main();
