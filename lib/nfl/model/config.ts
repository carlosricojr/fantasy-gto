import type { Position } from "../scoring/types";

/**
 * Frozen model constants.
 *
 * Every number here was selected by sweeping on the 2024 season and then evaluated once,
 * unchanged, on 2025. None of them were chosen by intuition. `docs/model-validation.md`
 * records the sweeps, and `backtest.ts` reproduces them.
 *
 * Changing a value here without re-running the backtest and updating that document is a
 * defect, because the product's published accuracy figure is derived from this exact
 * configuration.
 */

export const MODEL_VERSION = "fgto-1.0.0";

/**
 * EMA smoothing on prior fantasy points.
 *
 * Low, meaning long memory. This was the most consequential finding of the sweep: a
 * last-3-game average scores MAE 6.36 while a season-to-date mean scores 5.99, so
 * aggressive recency weighting actively destroys signal. Weekly fantasy scoring is noisy
 * enough that older games remain informative.
 */
export const EMA_ALPHA = 0.15;

/**
 * Ceiling on how much weight the usage-implied volume estimate may take from the
 * points EMA. Ramps in at 0.15 per prior game, so a player with one game barely uses it.
 */
export const USAGE_WEIGHT_CAP = 0.2;

/** Weight applied to the shrunk opponent defense-vs-position factor. */
export const DVP_WEIGHT = 0.25;

/** Weight applied to the Vegas adjustment. */
export const VEGAS_WEIGHT = 0.25;

/**
 * Clamps on the multiplicative adjustments.
 *
 * Both adjustments are ratios that can blow up on thin samples or lopsided lines. Clamping
 * bounds the damage a single extreme input can do to a projection.
 */
export const VEGAS_RATIO_MIN = 0.8;
export const VEGAS_RATIO_MAX = 1.2;
export const DVP_FACTOR_MIN = 0.9;
export const DVP_FACTOR_MAX = 1.1;

/**
 * Shrinkage strength for defense-vs-position factors, in units of observed player-games.
 * A matchup needs roughly this many observations before its factor moves halfway from
 * neutral toward its raw value.
 */
export const DVP_SHRINKAGE = 30;

/** Shrinkage strength for a player's own efficiency, in units of observed games. */
export const EFFICIENCY_SHRINKAGE = 4;

/**
 * Per-position priors for scoring efficiency per unit of opportunity, used as the
 * shrinkage target before a player has much history.
 *
 * Anchored to PPR, the product default. In a non-PPR league these targets are slightly
 * high, but they are only a shrinkage prior competing against the player's own observed
 * efficiency at weight `EFFICIENCY_SHRINKAGE`, so the residual effect is small.
 */
export const EFFICIENCY_PRIOR: Readonly<Record<Position, number>> = {
  QB: 0.52, // points per pass attempt
  RB: 0.95, // points per touch (carry or target)
  WR: 1.75, // points per target
  TE: 1.75, // points per target
  K: 0,
  DST: 0,
};

/**
 * Per-position multiplicative bias correction.
 *
 * The uncorrected model projects high — it is fitted on players selected for recent
 * production, who regress. These factors were computed on 2024 and, applied unchanged to
 * 2025, reduced mean bias from -0.87 to -0.59 points and improved MAE from 5.9095 to
 * 5.8512. That is a genuine out-of-sample gain, not a curve fit.
 */
export const CALIBRATION: Readonly<Record<Position, number>> = {
  QB: 0.9839,
  RB: 0.9617,
  WR: 0.9794,
  TE: 0.9909,
  K: 1,
  DST: 1,
};

export interface QuantileBand {
  p10: number;
  p90: number;
  /**
   * Whether these numbers were measured or assumed.
   *
   * `measured` bands come from the out-of-sample backtest. `placeholder` bands do not —
   * they are plausible values standing in until the position is actually projected and
   * measured. The distinction is recorded in the type rather than in a comment so the
   * interface can decline to present an unmeasured range as if it were evidence.
   */
  provenance: "measured" | "placeholder";
}

/**
 * Quantiles of actual/projected, used to turn a point estimate into a floor and ceiling.
 *
 * QB, RB, WR, and TE were measured out-of-sample on 2025 after calibration. The spread is
 * enormous — a tenth-percentile outcome is around a fifth of the projection and a
 * ninetieth-percentile outcome nearly double it. That is not a defect in the model; it is
 * the week-to-week variance of fantasy football, and showing it honestly is more useful
 * than implying a precision that does not exist.
 *
 * K and DST are **placeholders**. The model does not project those positions yet (see the
 * README's known gaps), so there is no backtest behind their bands. They are present so
 * the table is total, not because they are evidence.
 */
export const OUTCOME_QUANTILES: Readonly<Record<Position, QuantileBand>> = {
  QB: { p10: 0.165, p90: 1.751, provenance: "measured" },
  RB: { p10: 0.264, p90: 1.892, provenance: "measured" },
  WR: { p10: 0.189, p90: 1.775, provenance: "measured" },
  TE: { p10: 0.212, p90: 1.949, provenance: "measured" },
  K: { p10: 0.25, p90: 1.85, provenance: "placeholder" },
  DST: { p10: 0.2, p90: 2.0, provenance: "placeholder" },
};

/**
 * League-average implied team total, used only as a fallback when a team has no
 * season history of its own to compare against. Measured across 14,036 team-games.
 */
export const LEAGUE_MEAN_IMPLIED_TEAM_TOTAL = 21.745;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
