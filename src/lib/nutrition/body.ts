import { sql } from "@/db/client";
import { slope } from "@/lib/analysis/metrics";

/**
 * Body weight, and the phases it has to be read inside.
 *
 * The governing rule here is the one the athlete stated: goals change, so a
 * weight trend means nothing unless you say *which phase* it was measured in.
 * A regression through a bulk and the cut that follows it produces a slope
 * that describes neither, and it will look perfectly reasonable. Every
 * function below is therefore scoped to a phase, or explicitly says it isn't.
 */

export type Phase = "bulk" | "cut" | "maintain";

export interface PhaseSpan {
  id: number;
  phase: Phase;
  startedOn: string;
  /** Exclusive: the day the next phase began, or null while this one is current. */
  endedOn: string | null;
  note: string | null;
}

export interface WeightPoint {
  date: string;
  weightKg: number;
  /** The phase in force on that date, or null if it predates any declaration. */
  phase: Phase | null;
}

export async function logWeight(
  date: string,
  weightKg: number,
  note?: string,
): Promise<void> {
  await sql`
    insert into body_log (date, weight_kg, note)
    values (${date}, ${weightKg}, ${note ?? null})
    on conflict (date) do update
      set weight_kg = excluded.weight_kg,
          note = excluded.note,
          created_at = now()`;
}

export async function startPhase(
  phase: Phase,
  startedOn: string,
  note?: string,
): Promise<void> {
  // Re-declaring the same start date replaces it rather than erroring: the
  // common case is fixing a typo in the date you just entered, not recording
  // two phases that began the same morning.
  await sql`
    insert into goal_phases (phase, started_on, note)
    values (${phase}, ${startedOn}, ${note ?? null})
    on conflict (started_on) do update
      set phase = excluded.phase, note = excluded.note`;
}

/**
 * Phases as closed spans, derived rather than stored.
 *
 * `lead()` turns the single stored boundary into the pair every query wants,
 * which is the payoff for storing one column instead of two: the derived end
 * date cannot contradict the next phase's start, because it *is* the next
 * phase's start.
 */
export async function phaseSpans(): Promise<PhaseSpan[]> {
  return sql<PhaseSpan[]>`
    select id, phase,
           to_char(started_on, 'YYYY-MM-DD') as "startedOn",
           to_char(lead(started_on) over (order by started_on),
                   'YYYY-MM-DD') as "endedOn",
           note
    from goal_phases
    order by started_on`;
}

export async function currentPhase(): Promise<PhaseSpan | null> {
  const spans = await phaseSpans();
  return spans.length ? spans[spans.length - 1] : null;
}

/** Every weigh-in, tagged with the phase that was in force when it was taken. */
export async function weightSeries(): Promise<WeightPoint[]> {
  return sql<WeightPoint[]>`
    select to_char(b.date, 'YYYY-MM-DD') as date,
           b.weight_kg as "weightKg",
           (select g.phase from goal_phases g
             where g.started_on <= b.date
             order by g.started_on desc limit 1) as phase
    from body_log b
    order by b.date`;
}

export interface PhaseTrend {
  eligible: boolean;
  /** Present when ineligible: what is missing, phrased as the unlock condition. */
  reason?: string;
  phase?: Phase;
  startedOn?: string;
  readings?: number;
  spanDays?: number;
  firstKg?: number;
  lastKg?: number;
  kgPerWeek?: number;
  /** Whether the measured direction matches what the phase intends. */
  agrees?: boolean;
}

/** METHOD: below this a "trend" is two readings and a straight line. */
export const MIN_PHASE_READINGS = 4;
/** METHOD: day-to-day weight swings exceed a week of real change. */
export const MIN_PHASE_DAYS = 14;
/** PREFERENCE: drift slower than this is not worth calling a direction. */
export const FLAT_KG_PER_WEEK = 0.1;

/**
 * Rate of change within the current phase only.
 *
 * Least squares over the phase's own readings — never across its start, which
 * is the entire reason phases are stored. Reported as a fact with its sample
 * size attached, never as a recommendation: this says "you have been losing
 * 0.3 kg/week while bulking", and stops. What to eat about it is not this
 * system's business.
 */
export async function currentPhaseTrend(): Promise<PhaseTrend> {
  const phase = await currentPhase();
  if (!phase) {
    return { eligible: false, reason: "no goal phase declared yet" };
  }

  const points = (await weightSeries()).filter(
    (p) => p.date >= phase.startedOn,
  );

  if (points.length < MIN_PHASE_READINGS) {
    return {
      eligible: false,
      reason: `${MIN_PHASE_READINGS} weigh-ins needed inside the current phase; have ${points.length}`,
      phase: phase.phase,
      startedOn: phase.startedOn,
      readings: points.length,
    };
  }

  const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const spanDays = day(points[points.length - 1].date) - day(points[0].date);

  if (spanDays < MIN_PHASE_DAYS) {
    return {
      eligible: false,
      reason: `readings span ${Math.round(spanDays)} days; ${MIN_PHASE_DAYS} needed`,
      phase: phase.phase,
      startedOn: phase.startedOn,
      readings: points.length,
      spanDays: Math.round(spanDays),
    };
  }

  // The engine's own least-squares fit, not a second copy of one. Two
  // implementations of the same regression is two things to keep in agreement,
  // and the day they diverge the dashboard and the notification disagree about
  // which way the athlete is going.
  const x0 = day(points[0].date);
  const n = points.length;
  const kgPerDay =
    slope(points.map((p) => ({ x: day(p.date) - x0, y: p.weightKg }))) ?? 0;
  const kgPerWeek = Math.round(kgPerDay * 7 * 100) / 100;

  const intended =
    phase.phase === "bulk" ? 1 : phase.phase === "cut" ? -1 : 0;
  const measured =
    kgPerWeek > FLAT_KG_PER_WEEK ? 1 : kgPerWeek < -FLAT_KG_PER_WEEK ? -1 : 0;

  return {
    eligible: true,
    phase: phase.phase,
    startedOn: phase.startedOn,
    readings: n,
    spanDays: Math.round(spanDays),
    firstKg: points[0].weightKg,
    lastKg: points[n - 1].weightKg,
    kgPerWeek,
    agrees: intended === measured,
  };
}

export async function latestWeight(): Promise<WeightPoint | null> {
  const [row] = await sql<WeightPoint[]>`
    select to_char(date, 'YYYY-MM-DD') as date, weight_kg as "weightKg", null as phase
    from body_log order by date desc limit 1`;
  return row ?? null;
}

export async function getHeightCm(): Promise<number | null> {
  const [row] = await sql<{ h: number | null }[]>`
    select height_cm as h from profile where id = 1`;
  return row?.h ?? null;
}

export async function setHeightCm(heightCm: number): Promise<void> {
  await sql`
    insert into profile (id, height_cm) values (1, ${heightCm})
    on conflict (id) do update set height_cm = excluded.height_cm, updated_at = now()`;
}
