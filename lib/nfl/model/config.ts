import type { Position } from "../scoring/types";

/**
 * Frozen model constants.
 *
 * The five parameters the model is actually sensitive to — `EMA_ALPHA`,
 * `USAGE_WEIGHT_CAP`, `DVP_WEIGHT`, `VEGAS_WEIGHT`, and the calibration toggle — were
 * selected by sweeping on the 2024 season and then evaluated once, unchanged, on 2025.
 * `CALIBRATION`, `OUTCOME_QUANTILES`, and `LEAGUE_MEAN_IMPLIED_TEAM_TOTAL` are measured
 * rather than swept, and each is printed beside its checked-in value by the program that
 * produces it: `pnpm backtest` for all three, and `pnpm verify-sources` additionally for
 * the two `OUTCOME_QUANTILES` entries the backtest cannot produce, since the model does
 * not project kickers or defenses.
 *
 * The remaining constants — the clamp bounds, the shrinkage strengths, and
 * `EFFICIENCY_PRIOR` — are judgement, not measurement. They are documented individually as
 * such. Do not read this file as claiming every number in it was derived.
 * `docs/model-validation.md` records the sweeps.
 *
 * Changing a value here without re-running the backtest and updating that document is a
 * defect, because the product's published accuracy figure is derived from this exact
 * configuration.
 */

export const MODEL_VERSION = "fgto-1.0.0";

/**
 * EMA smoothing on prior fantasy points.
 *
 * Low, meaning long memory. This was the most consequential finding of the sweep, and the
 * baseline comparison makes the point most directly: on 2025 a last-3-game average scores
 * MAE 6.36 against 5.99 for the mean of every prior game the player has (across up to three
 * seasons — deliberately not a season-to-date mean, which would be a weaker baseline and
 * would flatter the model). Aggressive recency weighting destroys signal. Weekly fantasy
 * scoring is noisy enough that older games remain informative.
 */
export const EMA_ALPHA = 0.15;

/**
 * Ceiling on how much weight the usage-implied volume estimate may take from the
 * points EMA. Ramps in at 0.15 per prior game, so it saturates after two games and a
 * player with a single game already carries three quarters of the cap. The ramp only
 * matters in production: the backtest requires four prior games, so every measured run has
 * the weight pinned at the cap.
 */
export const USAGE_WEIGHT_CAP = 0.2;

/** Weight applied to the shrunk opponent defense-vs-position factor. */
export const DVP_WEIGHT = 0.25;

/**
 * Weight applied to the Vegas adjustment.
 *
 * Selected by sweeping on the tuning season (`pnpm backtest -- --sweeps`). The value was
 * 0.25 until the lookahead-bias fix changed what the reference baseline contains; the
 * corrected sweep prefers 0.5. Re-selecting on the tuning season is legitimate — that is
 * what it is for — and the evaluation season remains untouched.
 */
export const VEGAS_WEIGHT = 0.5;

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
 * **Fitted on PPR only**, like the projected half of `OUTCOME_QUANTILES` and the published
 * accuracy figure. They are applied to every ruleset because a per-ruleset fit has not been
 * measured; for Half PPR and Standard they are an unvalidated approximation, and the
 * interface says so.
 *
 * The uncorrected model projects high — it is fitted on players selected for recent
 * production, who regress. These are `mean(actual) / mean(predicted)` per position on the
 * tuning season with calibration switched off, and `pnpm backtest` prints them: the values
 * here are copied from its output, not from memory. They are applied unchanged to the
 * evaluation season, so the resulting gain is out-of-sample.
 */
export const CALIBRATION: Readonly<Record<Position, number>> = {
  QB: 0.9771,
  RB: 0.9571,
  WR: 0.976,
  TE: 0.9884,
  K: 1,
  DST: 1,
};

export interface QuantileBand {
  readonly p10: number;
  readonly p90: number;
  /**
   * Whether these numbers were measured or assumed.
   *
   * `measured` means a checked-in program produces them from data. There are two such
   * programs, because the four positions the weekly model projects and the two it does not
   * cannot be measured the same way: `pnpm backtest` prints the skill bands from its own
   * out-of-sample predictions, and `pnpm verify-sources` prints the kicker and defense
   * bands from historical weekly scoring, against the best forecast anybody could have
   * held at the draft. `lib/nfl/model/outcome-band.ts` carries that argument in full.
   *
   * `placeholder` bands come from neither — they are plausible values standing in until
   * the position is actually measured. The distinction is recorded in the type rather than
   * in a comment so the interface can decline to present an unmeasured range as if it were
   * evidence.
   */
  provenance: "measured" | "placeholder";
}

/**
 * Quantiles of actual/projected, used to turn a point estimate into a floor and ceiling.
 *
 * QB, RB, WR, and TE are measured on 2025 after calibration, **under PPR scoring**, and
 * `pnpm backtest` prints them — these values are copied from its output, not from memory.
 * Note that these bands are fitted on the same predictions the evaluation MAE is computed
 * from, so unlike that MAE they are an in-sample description of the spread, not an
 * out-of-sample claim about it. Applied to another ruleset they are an approximation, not a measurement. The spread is
 * enormous — a tenth-percentile outcome is around a fifth of the projection and a
 * ninetieth-percentile outcome nearly double it. That is not a defect in the model; it is
 * the week-to-week variance of fantasy football, and showing it honestly is more useful
 * than implying a precision that does not exist.
 *
 * K and DST are measured too, but not by the backtest and not against a projection — the
 * model does not project either position and still does not (see the README's known gaps).
 * Their forecast is the entity's own prior-season points per game, which is what a drafter
 * actually has, and `pnpm verify-sources` prints both bands beside these values. The
 * kicker band is the empirical deciles, exactly as the four above are. The defense band is
 * not: an eighth of team-weeks score nothing or less, so its empirical tenth percentile is
 * 0.000 and no multiplicative band can carry it. It is the closest fit that can be — the
 * lognormal reproducing the measured expectation of a weekly maximum, which is the only
 * functional the season simulation consumes. `lib/nfl/model/outcome-band.ts` makes the
 * whole argument, and `docs/data-sources.md` records both figures for both positions.
 *
 * Two things a measured band here does **not** buy. It is not a projection: nothing has
 * started estimating what a kicker will score, only how far a week strays from an estimate
 * somebody else supplies. And it is fitted under this repo's own K and D/ST scoring
 * ladders, which `lib/nfl/scoring/presets.ts` says plainly are conventional defaults
 * matched against no external source — unlike the offensive values, which are verified.
 * A league that scores defenses differently has a differently-shaped band.
 */
/**
 * The band used for a position `OUTCOME_QUANTILES` has no entry for.
 *
 * Not measured, and named so that nothing reads it as though it were. It exists because a
 * draft board can carry a position the weekly model never scores — anything a future
 * ruleset adds — and giving one no spread at all would make it look risk-free rather than
 * unmeasured. Every position the product ships today has a measured entry above, so
 * nothing reaches this in practice; it is the fail-closed default for the position that
 * does not exist yet, not a live value.
 */
export const PLACEHOLDER_QUANTILES: QuantileBand = {
  p10: 0.2,
  p90: 1.9,
  // Typed rather than commented, for the reason `QuantileBand` says: a band that cannot
  // state where it came from is one the interface cannot decline to present as evidence.
  provenance: "placeholder",
};

export const OUTCOME_QUANTILES: Readonly<Record<Position, QuantileBand>> = {
  QB: { p10: 0.171, p90: 1.772, provenance: "measured" },
  RB: { p10: 0.269, p90: 1.901, provenance: "measured" },
  WR: { p10: 0.186, p90: 1.808, provenance: "measured" },
  TE: { p10: 0.217, p90: 1.953, provenance: "measured" },
  K: { p10: 0.271, p90: 1.864, provenance: "measured" },
  DST: { p10: 0.208, p90: 2.118, provenance: "measured" },
};

/**
 * League-average implied team total, used only as a fallback when a team has no
 * season history of its own to compare against.
 *
 * Measured across 14,036 team-games and reproduced by `pnpm backtest`, which prints it
 * alongside the checked-in value.
 */
export const LEAGUE_MEAN_IMPLIED_TEAM_TOTAL = 21.745;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The tunable parameters, bundled so they can be varied.
 *
 * The model reads `DEFAULT_MODEL_CONFIG` unless a caller supplies an override. Only the
 * backtest's sweep mode does, which is what makes the claims in
 * `docs/model-validation.md` reproducible instead of merely asserted — the project's own
 * rule is that a number the code cannot produce may not be published.
 *
 * Application code must never pass an override. The published accuracy figure belongs to
 * the default configuration.
 */
export interface ModelConfig {
  readonly emaAlpha: number;
  readonly usageWeightCap: number;
  readonly dvpWeight: number;
  readonly vegasWeight: number;
  /** When false, the per-position bias correction is skipped. */
  readonly calibrate: boolean;
  /**
   * Reference for the Vegas adjustment. `team` compares this game's implied total against
   * the team's own prior weeks; `league` compares it against the league average, which
   * sweeping showed to be worth very little at its best weight and harmful beyond it —
   * worse at full weight than omitting the term. `team` is better at every weight above
   * zero. See the sweeps table in `docs/model-validation.md`.
   */
  readonly vegasReference: "team" | "league";
}

export const DEFAULT_MODEL_CONFIG: Readonly<ModelConfig> = Object.freeze({
  emaAlpha: EMA_ALPHA,
  usageWeightCap: USAGE_WEIGHT_CAP,
  dvpWeight: DVP_WEIGHT,
  vegasWeight: VEGAS_WEIGHT,
  calibrate: true,
  vegasReference: "team",
});

/*
 * The configuration objects above are exported by reference and read on every projection.
 * Freezing them means a caller cannot quietly retune the model at runtime — which would
 * detach the output from the published accuracy figure without changing a single line of
 * committed code. `readonly` alone only stops TypeScript; the freeze stops JavaScript.
 */
Object.freeze(EFFICIENCY_PRIOR);
Object.freeze(CALIBRATION);
for (const band of Object.values(OUTCOME_QUANTILES)) Object.freeze(band);
Object.freeze(OUTCOME_QUANTILES);
