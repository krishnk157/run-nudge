/**
 * Every threshold the analysis engine applies, in one place.
 *
 * These were hardcoded across the rules until it became clear they are not all
 * the same kind of thing. Some are *facts about the method* — an acute:chronic
 * ratio is meaningless below a certain training density, regardless of who is
 * asking. Others are *preferences* — where to draw "high" encodes how quiet you
 * want the system to be. Defending a preference as though it were a measurement
 * is its own kind of dishonesty, so they live together, labelled, and every one
 * is swept by `npm run sensitivity` to show whether it sits on a plateau (the
 * exact value doesn't matter) or a cliff (it was chosen to produce an answer).
 */
export interface AnalysisConfig {
  // --- acute:chronic workload ---------------------------------------
  /** METHOD: below this density the ratio tracks single sessions, not training. */
  minChronicSessions: number;
  /** METHOD: sessions must be spread, not bunched — a count is not a distribution. */
  minChronicWeeks: number;
  /** PREFERENCE: where "elevated" begins. */
  acwrHigh: number;
  /** PREFERENCE: where "detraining" begins. */
  acwrLow: number;
  /** PREFERENCE: where elevated becomes worth a stronger word. */
  acwrWarning: number;
  /** METHOD: exponential smoothing horizons, in days. */
  ewmaAcuteDays: number;
  ewmaChronicDays: number;

  // --- aerobic efficiency -------------------------------------------
  /** METHOD: fewer points than this and a slope is fitting noise. */
  minEfficiencyRuns: number;
  /** PREFERENCE: monthly change worth remarking on, as a fraction. */
  efficiencyChangePerMonth: number;

  // --- consistency ---------------------------------------------------
  /** PREFERENCE: a gap this long makes the session that ends it notable. */
  returnGapDays: number;
  /** PREFERENCE: silence this long is worth raising unprompted. */
  stalledDays: number;

  // --- resting heart rate --------------------------------------------
  /** METHOD: minimum worn nights before a baseline exists at all. */
  minRestingBaselineNights: number;
  /** METHOD: minimum recent worn nights to compare against it. */
  minRestingRecentNights: number;
  /** PREFERENCE: drift worth mentioning, in bpm. */
  restingHrDeltaBpm: number;

  // --- aerobic dose ---------------------------------------------------
  /**
   * METHOD: fraction of max HR above which a session counts as aerobic work.
   *
   * 0.75 is the conventional boundary between "moving" and "training the
   * aerobic system". It is a method constant rather than a preference because
   * the whole measure is meaningless if it counts a walk.
   */
  aerobicHrFraction: number;
  /** METHOD: below this share of sessions carrying HR, the week is unmeasured. */
  minAerobicHrCoverage: number;
  /** METHOD: a single week is not a dose; this many are needed to compare. */
  minAerobicWeeks: number;
  /** PREFERENCE: weekly change in aerobic minutes worth remarking on. */
  aerobicChangeFraction: number;
}

export const DEFAULT_CONFIG: AnalysisConfig = {
  minChronicSessions: 8,
  minChronicWeeks: 3,
  acwrHigh: 1.5,
  acwrLow: 0.8,
  acwrWarning: 1.8,
  ewmaAcuteDays: 7,
  ewmaChronicDays: 28,

  minEfficiencyRuns: 8,
  efficiencyChangePerMonth: 0.02,

  returnGapDays: 14,
  stalledDays: 10,

  minRestingBaselineNights: 5,
  minRestingRecentNights: 3,
  restingHrDeltaBpm: 4,

  aerobicHrFraction: 0.75,
  minAerobicHrCoverage: 0.6,
  minAerobicWeeks: 3,
  aerobicChangeFraction: 0.3,
};
