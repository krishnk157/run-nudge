import { sql } from "@/db/client";

/**
 * What day is it, for this athlete?
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and it is wrong for
 * anyone who isn't in London. At 00:12 IST it returns *yesterday*, so a meal
 * logged just after midnight is filed to the day before — a wrong row, written
 * confidently, with nothing on screen to suggest it.
 *
 * The athlete's offset is not something to ask them to configure: it is
 * already in the data. Strava gives every activity both an absolute instant
 * and the wall-clock time it started at, and the difference between them is
 * the clock the athlete was standing under. Reading it from the most recent
 * activity also means it tracks travel and daylight saving on its own.
 *
 * The known limitation: it is an *offset*, not a timezone, taken from whenever
 * they last trained. If they fly to another continent and don't train for a
 * fortnight, this reports the old clock until the next activity syncs. That is
 * a smaller and more visible error than assuming UTC, and it is the reason the
 * value is derived per request rather than cached for the process lifetime.
 */

/** Seconds east of UTC, from the athlete's most recent recorded activity. */
export async function athleteOffsetSeconds(): Promise<number> {
  const [row] = await sql<{ offset_s: number | null }[]>`
    select extract(
             epoch from (started_at_local - (started_at at time zone 'UTC'))
           )::int as offset_s
    from activities
    where started_at_local is not null
    order by started_at desc
    limit 1`;
  return row?.offset_s ?? 0;
}

/** Today's calendar date on the athlete's clock, as YYYY-MM-DD. */
export async function athleteToday(now: Date = new Date()): Promise<string> {
  const offset = await athleteOffsetSeconds();
  return shiftToDate(now, offset);
}

/** Pure half, so the arithmetic is testable without a database. */
export function shiftToDate(now: Date, offsetSeconds: number): string {
  return new Date(now.getTime() + offsetSeconds * 1000)
    .toISOString()
    .slice(0, 10);
}
