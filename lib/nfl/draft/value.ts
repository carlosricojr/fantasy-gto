import {
  AVAILABILITY_FLOOR,
  GAMES_IN_SEASON,
  MODEL_BLEND_WEIGHT,
  SEASON_EMA_ALPHA,
} from "./config";

/**
 * Season-long player valuation for drafting.
 *
 * Two independent estimates of the same quantity — how many fantasy points a player will
 * score across a season — combined at a weight chosen on a tuning season.
 *
 * The combination does **not** beat the market. Measured out-of-sample on 2024: the market
 * ranks players at 0.5403 by rank correlation, our model at 0.4433, and the blend at
 * 0.5364 — a 0.72% decline against the market alone. The blend is kept because it wins on
 * the other metric the backtest reports, total points among each method's top 24, and
 * because the two disagree and one evaluation season of 151 players cannot settle it. No
 * ranking edge over the market may be claimed anywhere in the interface.
 *
 * This docstring previously said measurement showed the combination beats either. It does
 * not, and `config.ts`, `published-draft-metrics.json` and the backtest's own output all
 * said so at the time. See `docs/draft-validation.md`.
 *
 * This is a different question from the weekly model's. Weekly asks "how will he do on
 * Sunday", which is dominated by matchup and recent form. Season-long asks "how much will
 * he accumulate", which is dominated by how many games he plays and what his role is —
 * and the market knows things about role that box scores cannot: depth charts, holdouts,
 * coaching changes, and rookies with no history at all.
 */

/** Exponentially weighted mean, most recent last. Matches the weekly model's `ema`. */
export function emaRate(perGamePoints: readonly number[], alpha: number): number {
  if (perGamePoints.length === 0) return 0;
  let accumulated = perGamePoints[0];
  for (let i = 1; i < perGamePoints.length; i += 1) {
    accumulated = alpha * perGamePoints[i] + (1 - alpha) * accumulated;
  }
  return accumulated;
}

/**
 * Games a player is expected to play, from how many he played last season.
 *
 * Ramps from `AVAILABILITY_FLOOR` of a season to a full one. Using last season's games
 * directly would project a player who missed ten weeks to miss ten weeks again, which the
 * data does not support; ignoring availability entirely would value a player who has not
 * finished a season in three years identically to an ironman.
 */
export function expectedGames(priorSeasonGames: number): number {
  const availability = Math.min(Math.max(priorSeasonGames, 0), GAMES_IN_SEASON) / GAMES_IN_SEASON;
  return GAMES_IN_SEASON * (AVAILABILITY_FLOOR + (1 - AVAILABILITY_FLOOR) * availability);
}

export interface SeasonProjectionInput {
  /** Per-game fantasy points from the prior two seasons, oldest game first. */
  perGamePoints: readonly number[];
  /** Games played in the immediately prior season. */
  priorSeasonGames: number;
  alpha?: number;
}

/** Our own estimate of a player's season total, from production alone. */
export function seasonProjection(input: SeasonProjectionInput): number {
  const rate = emaRate(input.perGamePoints, input.alpha ?? SEASON_EMA_ALPHA);
  return round2(rate * expectedGames(input.priorSeasonGames));
}

/**
 * The market's implied season total, as a function of where a player is drafted.
 *
 * Points fall roughly linearly in the logarithm of draft position: the gap between the
 * first and fifth picks is far larger than between the hundredth and hundred-and-fourth.
 * A linear fit against raw ADP gets the top of the board badly wrong, which is exactly
 * where a draft is decided.
 */
export interface AdpCurve {
  intercept: number;
  slope: number;
  /** How many players the fit was drawn from, so a thin fit is visible rather than implied. */
  sampleSize: number;
  /** The season the curve was fitted on. */
  season: number;
}

export interface AdpCurveSample {
  adp: number;
  actualSeasonPoints: number;
  position: string;
}

/**
 * One curve per position, with a pooled fallback.
 *
 * Fitting a single curve across all positions is measurably wrong, and wrong in a way
 * that matters: quarterbacks score far more raw points than running backs taken at the
 * same slot, so a pooled curve reads every quarterback as badly overvalued and every
 * running back as underpriced. On held-out 2024 that mis-specification cost the market
 * signal a full tenth of its rank correlation — 0.4455 pooled against 0.5459 per
 * position. It was the difference between the market looking beatable and the market
 * looking correct.
 */
export interface AdpCurveSet {
  byPosition: Readonly<Record<string, AdpCurve>>;
  /** Used for a position with too few players to fit its own curve. */
  pooled: AdpCurve | null;
  season: number;
}

/**
 * Fewest players a position needs before it gets its own curve.
 *
 * Below this the fit is dominated by whichever few players happened to be listed, which
 * is worse than borrowing the pooled shape. Tight ends and quarterbacks sit near this
 * line on a thin board, so it is doing real work rather than guarding a corner case.
 */
export const MIN_CURVE_SAMPLES = 8;

/**
 * Fits the ADP-to-points curve by least squares on log(ADP).
 *
 * Must be fitted on a season that has already been played, and never on the season being
 * projected — the whole point is to learn what a given draft slot has historically been
 * worth, then apply it to this year's slots. Fitting on the target season would be
 * reading the answers.
 */
export function fitAdpCurve(
  samples: readonly AdpCurveSample[],
  season: number,
): AdpCurve | null {
  const usable = samples.filter((s) => s.adp > 0 && Number.isFinite(s.actualSeasonPoints));
  if (usable.length < 2) return null;

  const xs = usable.map((s) => Math.log(s.adp));
  const ys = usable.map((s) => s.actualSeasonPoints);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < xs.length; i += 1) {
    covariance += (xs[i] - meanX) * (ys[i] - meanY);
    variance += (xs[i] - meanX) ** 2;
  }
  if (variance === 0) return null;

  const slope = covariance / variance;
  return {
    slope,
    intercept: meanY - slope * meanX,
    sampleSize: usable.length,
    season,
  };
}

/** Fits one curve per position, plus a pooled fallback for thin positions. */
export function fitAdpCurves(
  samples: readonly AdpCurveSample[],
  season: number,
): AdpCurveSet {
  const byPositionSamples = new Map<string, AdpCurveSample[]>();
  for (const sample of samples) {
    const key = sample.position.toUpperCase();
    const bucket = byPositionSamples.get(key);
    if (bucket) bucket.push(sample);
    else byPositionSamples.set(key, [sample]);
  }

  const byPosition: Record<string, AdpCurve> = {};
  for (const [position, bucket] of byPositionSamples) {
    if (bucket.length < MIN_CURVE_SAMPLES) continue;
    const curve = fitAdpCurve(bucket, season);
    if (curve !== null) byPosition[position] = curve;
  }

  return { byPosition, pooled: fitAdpCurve(samples, season), season };
}

/**
 * The market's implied points for a draft slot at a position. Never negative.
 *
 * `null` when neither a position curve nor a pooled one could be fitted — the market has
 * said nothing usable, and inventing a number would be worse than admitting it.
 */
export function adpImpliedPoints(
  adp: number,
  position: string,
  curves: AdpCurveSet,
): number | null {
  if (adp <= 0) return 0;
  const curve = curves.byPosition[position.toUpperCase()] ?? curves.pooled;
  if (curve === undefined || curve === null) return null;
  return round2(Math.max(0, curve.intercept + curve.slope * Math.log(adp)));
}

/**
 * Combines our estimate with the market's, where both have one.
 *
 * Absence has to mean absence on **both** sides, and getting that wrong is not a rounding
 * error. A rookie has no prior games, so the model returns zero — not "he will score
 * nothing", but "I have no basis for an opinion". Blending that zero in marked every
 * rookie down by the model's full weight: a first-round rookie priced by the market at 300
 * points was carried on the board at 240. That is a systematic markdown of exactly the
 * players the model knows least about, which is the opposite of what a blend is for.
 *
 * So `null` on either side means the other estimate stands alone. The market alone for a
 * player with no history, the model alone for a player with no market.
 */
export function blendedSeasonValue(
  modelPoints: number | null,
  adpImplied: number | null,
  weight: number = MODEL_BLEND_WEIGHT,
): number {
  if (modelPoints === null && adpImplied === null) return 0;
  if (adpImplied === null) return round2(modelPoints ?? 0);
  if (modelPoints === null) return round2(adpImplied);
  return round2(weight * modelPoints + (1 - weight) * adpImplied);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Converts an expected season total into points per game *played*.
 *
 * The simulator wants what a player scores in a week he suits up, and then decides
 * separately how often that happens. A season total is not that number: it already carries
 * the injury discount, because the model half multiplies by expected games and the market
 * half is fitted against actual season points, which include the games players missed.
 *
 * Handing the simulator `seasonPoints / games` and an availability alongside it therefore
 * discounted twice. Measured on the shipped board, a player at 0.50 availability realised
 * 150 points of an intended 300 — and an ironman was barely touched, so the error fell
 * entirely on the injury-prone, who are exactly the players the market has already priced
 * for it.
 *
 * The floor stops a player with no recorded availability from dividing the total up to
 * nothing; below it the season estimate is too thin to rescale meaningfully anyway.
 */
export const MIN_AVAILABILITY_FOR_RATE = 0.05;

export function perGameRate(
  seasonPoints: number,
  availability: number,
  gamesInSeason: number = GAMES_IN_SEASON,
): number {
  const usable = Math.max(availability, MIN_AVAILABILITY_FOR_RATE);
  return seasonPoints / (gamesInSeason * usable);
}
