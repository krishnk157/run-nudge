/**
 * Replay the analysis engine over real history and check it against a
 * reference implementation.
 *
 *   npm run analyze              # replay every activity, summarise findings
 *   npm run analyze -- --validate  # compare our ACWR against Garmin's
 *   npm run analyze -- --activity 604003275089
 */
import "dotenv/config";

import { sql } from "@/db/client";
import { getAnchors } from "@/lib/analysis/athlete";
import { computeInsights } from "@/lib/analysis/engine";
import { activityLoads, calibrate, ewmaLoad, windowLoad } from "@/lib/analysis/load";

const argv = process.argv.slice(2);
const arg = (flag: string) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

function pad(s: string | number, n: number) {
  return String(s).padEnd(n);
}

async function replay() {
  const anchors = await getAnchors();
  console.log("Anchors derived from this athlete's own history:");
  console.log(`  max HR      ${anchors.hrMax} (${anchors.hrMaxSource})`);
  console.log(
    `  resting HR  ${anchors.restingHr} (${anchors.restingHrSource}, ${anchors.restingHrSamples} nights)\n`,
  );

  const rows = await sql<{ id: number; d: string; sport: string }[]>`
    select id, to_char(started_at_local,'YYYY-MM-DD') as d, sport_type as sport
    from activities order by started_at_local`;

  console.log(
    `${pad("date", 12)}${pad("sport", 16)}${pad("fire", 6)}${pad("quiet", 6)}${pad("n/a", 5)}${pad("err", 5)}headline`,
  );
  console.log("-".repeat(104));

  let errors = 0;
  for (const r of rows) {
    const rep = await computeInsights(Number(r.id));
    errors += rep.counts.error;
    const top = rep.findings
      .filter((f) => f.status === "fired")
      .sort((a, b) => (b.severity === "warning" ? 1 : 0) - (a.severity === "warning" ? 1 : 0))[0];
    const broke = rep.findings.find((f) => f.status === "error");
    console.log(
      pad(r.d, 12) +
        pad(r.sport, 16) +
        pad(rep.counts.fired, 6) +
        pad(rep.counts.quiet, 6) +
        pad(rep.counts.ineligible, 5) +
        pad(rep.counts.error || "", 5) +
        (broke ? `!! ${broke.rule}: ${broke.data.error}` : (top?.statement ?? "—")),
    );
  }
  console.log(
    errors
      ? `\n${errors} rule errors — these are defects, not missing data.`
      : "\nNo rule errors.",
  );
}

/**
 * Compare our acute:chronic ratio against Garmin's on the days both exist.
 *
 * This is a cross-check, not a correctness test: Garmin's formula is
 * undocumented, its load unit is its own, and it counts activities we may not
 * have. Agreement in *direction and shape* is the signal worth having;
 * identical numbers would actually be suspicious.
 */
async function validate() {
  const anchors = await getAnchors();
  const cal = await calibrate(anchors);
  const loads = await activityLoads(anchors, cal);

  const rows = await sql<
    { d: string; garmin_acwr: number; acute: number | null; chronic: number | null }[]
  >`
    select to_char(date,'YYYY-MM-DD') as d, garmin_acwr,
           acute_training_load as acute, chronic_training_load as chronic
    from daily_metrics
    where garmin_acwr is not null order by date`;

  console.log(`Comparing ${rows.length} days where Garmin reported an ACWR.\n`);
  console.log(
    `${pad("date", 12)}${pad("ours", 10)}${pad("garmin", 10)}${pad("sess/28d", 10)}note`,
  );
  console.log("-".repeat(78));

  let bothCount = 0;
  let agreeDirection = 0;
  const pairs: { ours: number; garmin: number }[] = [];
  let weRefused = 0;

  for (const r of rows) {
    const w = windowLoad(loads, new Date(`${r.d}T12:00:00Z`));
    const populated = w.sessionsChronic >= 8 && w.weeksCovered >= 3;
    const ours = populated ? ewmaLoad(loads, new Date(`${r.d}T12:00:00Z`)).ratio : null;
    if (ours == null) weRefused++;

    let note = "";
    if (ours == null) {
      note = `we refuse — ${w.sessionsChronic} sessions across ${w.weeksCovered}/4 weeks`;
    } else {
      bothCount++;
      pairs.push({ ours, garmin: r.garmin_acwr });
      const oursHigh = ours >= 1.3;
      const garminHigh = r.garmin_acwr >= 1.3;
      if (oursHigh === garminHigh) agreeDirection++;
      else note = "direction differs";
    }

    console.log(
      pad(r.d, 12) +
        pad(ours == null ? "—" : ours.toFixed(2), 10) +
        pad(r.garmin_acwr.toFixed(2), 10) +
        pad(w.sessionsChronic, 10) +
        note,
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log(`Days Garmin reported a ratio:      ${rows.length}`);
  console.log(`Days we also reported one:         ${bothCount}`);
  console.log(`Days we deliberately refused:      ${weRefused}  (chronic baseline too thin)`);
  if (bothCount) {
    console.log(
      `Agreement on elevated-or-not:      ${agreeDirection}/${bothCount} ` +
        `(${Math.round((100 * agreeDirection) / bothCount)}%)`,
    );
    const corr = pearson(pairs.map((p) => p.ours), pairs.map((p) => p.garmin));
    console.log(`Correlation with Garmin's ratio:   ${corr === null ? "n/a" : corr.toFixed(3)}`);
  }
  console.log(
    "\nGarmin reported a ratio on every one of these days, including days its own\n" +
      "chronic load had collapsed. Refusing those is the intended difference, not a gap.",
  );
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}

async function single(id: number) {
  const rep = await computeInsights(id);
  console.log(JSON.stringify(rep, null, 2));
}

async function main() {
  const one = arg("--activity");
  if (one) return single(Number(one));
  if (argv.includes("--validate")) return validate();
  return replay();
}

main()
  .then(() => sql.end())
  .catch(async (e) => {
    console.error("Failed:", e);
    await sql.end();
    process.exit(1);
  });
