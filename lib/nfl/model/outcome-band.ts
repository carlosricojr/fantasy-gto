import { Z_90 } from "../../core/rng";
import {
  expectedMaxOfTwo,
  quantile,
  standardNormalQuantile,
} from "../../core/stats";
import type { QuantileBand } from "./config";

/**
 * Measuring an outcome band for a position the weekly model does not project.
 *
 * QB, RB, WR and TE get their bands the obvious way: the backtest has a prediction for
 * every player-week, so the empirical deciles of `actual / predicted` are the band, and
 * `scripts/backtest.ts` prints them. Kickers and defenses have no prediction, so the band
 * has to be measured against the best estimate anybody *could* have held at the draft —
 * the entity's own prior-season points per game. That is deliberately the same kind of
 * quantity as the skill construction: an outcome divided by a forecast, carrying the
 * forecast's error rather than pretending it away. A same-season mean would measure the
 * spread around a level nobody knows until the season is over, which is a narrower and
 * differently-defined number.
 *
 * ## What the band is actually used for, and why that decides how to fit it
 *
 * `lib/core/roster-utility.ts` turns the pair into a lognormal and then renormalizes the
 * draw so its mean is the projection. That renormalization cancels `mu` exactly, so the
 * entire information content of a band, at the only place a K or D/ST band is ever read,
 * is the single dispersion parameter
 *
 *     sigma = ln(p90 / p10) / (2 * Z_90)
 *
 * and the only functional of the fitted distribution the objective consumes is a maximum:
 * a roster scores the best legal lineup it can field each week, so shape matters through
 * `E[max]` and through nothing else. A lone starter contributes his mean whatever the
 * shape is.
 *
 * ## Why defenses need a different fit from everybody else
 *
 * The log-range formula above assumes the tenth percentile is positive. For a defense it
 * is not: under the conventional points-allowed ladder a bad week is worth nothing or
 * less, and around an eighth of team-weeks land at or below zero. The empirical p10 is
 * therefore 0.000, the log range is undefined, and a floored epsilon would not rescue it —
 * it would manufacture a sigma near six, which is not a wide distribution but a degenerate
 * one, nearly every week at zero with rare enormous spikes. Mean preserved, shape absurd,
 * and it would inflate the worth of a *second* defense, which is the exact defect the
 * mock-draft audit found.
 *
 * So a defense is fitted by matching `E[max]` of two independent draws instead, which is
 * defined whatever the lower tail does. That substitute is not chosen for convenience: on
 * the five positions where both rules *are* defined, the incumbent log-range rule and the
 * expected-max fit agree to within 8-18%, and they disagree by 43% for D/ST alone —
 * because an atom at zero is the one thing a log range cannot read. The rule below is
 * therefore "use the incumbent rule wherever it is defined, and where it is not, use the
 * fit that agrees with it everywhere else". `docs/data-sources.md` records both figures
 * for both positions so the choice is visible rather than asserted.
 *
 * ## What this module does not claim
 *
 * The multiplicative form is an approximation for *every* position, not just these two.
 * Regressing each entity-season's weekly standard deviation on its mean gives a large
 * positive intercept and a shallow slope at all six positions, meaning weekly spread is
 * mostly additive: the model under-disperses strong players and over-disperses weak ones.
 * Measuring a band does not fix that, and nothing here pretends it does. Nor does a
 * measured band make a kicker projectable — it describes the spread around a mean the
 * model still does not produce, which is why `MODELED_POSITIONS` is untouched.
 */

/** One entity's regular-season weekly scores, in one season. */
export interface EntitySeason {
  /** Player id, or team abbreviation for a defense. */
  readonly id: string;
  readonly season: number;
  /** Fantasy points in each regular-season game the entity actually played. */
  readonly weeklyPoints: readonly number[];
}

/** How a band was arrived at, so a reader never has to infer it from the numbers. */
export type BandFitRule =
  /** The empirical deciles, exactly as the skill bands are taken. */
  | "empirical-deciles"
  /** The deciles of the lognormal matching the measured `E[max]`, used when p10 <= 0. */
  | "expected-max";

export interface OutcomeBandFit {
  readonly sampleSize: number;
  readonly empiricalP10: number;
  readonly empiricalP50: number;
  readonly empiricalP90: number;
  /** Share of the sample at or below zero — the thing that decides which rule applies. */
  readonly nonPositiveShare: number;
  /** `E[max]` of two independent weekly draws, as a multiple of the mean. */
  readonly expectedMaxRatio: number;
  /** `sigma` from the incumbent log-range rule, or `null` where p10 is not positive. */
  readonly sigmaFromRange: number | null;
  /** `sigma` from matching `E[max]`, which is always defined. */
  readonly sigmaFromExpectedMax: number;
  readonly rule: BandFitRule;
  /** The band to check in, rounded to the three decimals the skill bands carry. */
  readonly band: QuantileBand;
}

/**
 * Ratios of each week's actual points to the entity's *prior* season points per game.
 *
 * `minPriorGames` guards the denominator, not the numerator: a mean taken over two games
 * is noise, and dividing by it manufactures ratios that say more about the denominator
 * than the outcome. An entity with no qualifying prior season contributes nothing rather
 * than falling back to some other estimate, because a band assembled from two different
 * denominators is a band of nothing in particular.
 */
export function priorSeasonRatios(
  seasons: readonly EntitySeason[],
  minPriorGames: number,
): number[] {
  const meanByKey = new Map<string, number>();
  for (const entry of seasons) {
    if (entry.weeklyPoints.length < minPriorGames) continue;
    const total = entry.weeklyPoints.reduce((sum, points) => sum + points, 0);
    meanByKey.set(`${entry.id}|${entry.season}`, total / entry.weeklyPoints.length);
  }

  const ratios: number[] = [];
  for (const entry of seasons) {
    const priorMean = meanByKey.get(`${entry.id}|${entry.season - 1}`);
    // A non-positive prior mean is not a small denominator to be clamped — it is an
    // entity whose prior season carries no level at all, and dividing by it inverts the
    // sign of every ratio it produces.
    if (priorMean === undefined || priorMean <= 0) continue;
    for (const points of entry.weeklyPoints) ratios.push(points / priorMean);
  }
  return ratios;
}

/** The deciles of the unit-mean lognormal with this dispersion. */
export function lognormalDeciles(sigma: number): { p10: number; p90: number } {
  // Unit mean fixes `mu` at `-sigma^2 / 2`, which is what makes these two numbers a
  // complete description of the distribution the simulator draws from.
  const median = Math.exp(-(sigma * sigma) / 2);
  const spread = Math.exp(sigma * Z_90);
  return { p10: median / spread, p90: median * spread };
}

/**
 * The dispersion of the unit-mean lognormal whose `E[max]` of two draws matches `ratio`.
 *
 * Closed form: for independent unit-mean lognormals, `E[max] = 2 * Phi(sigma / sqrt(2))`.
 * A ratio at or below one means the sample shows no dispersion at all; at or above two it
 * shows more than any lognormal can carry, and both are returned as the boundary rather
 * than as an infinity that would silently poison a band.
 */
export function lognormalSigmaFromExpectedMax(ratio: number): number {
  if (!(ratio > 1)) return 0;
  if (ratio >= 2) return Number.POSITIVE_INFINITY;
  return Math.SQRT2 * standardNormalQuantile(ratio / 2);
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Fits a band to a sample of `actual / forecast` ratios.
 *
 * The simulator can never draw a negative week — `drawPoints` clamps at zero — so the
 * distribution it must reproduce is the clamped one, and `E[max]` is measured on that.
 * The *deciles* are reported raw, because those are the empirical quantiles of the thing
 * measured and clamping them would quietly move a published number.
 */
export function fitOutcomeBand(ratios: readonly number[]): OutcomeBandFit {
  const clamped = ratios.map((ratio) => Math.max(0, ratio));
  const mean = clamped.reduce((sum, value) => sum + value, 0) / clamped.length;
  const expectedMaxRatio = expectedMaxOfTwo(clamped) / mean;
  const sigmaFromExpectedMax = lognormalSigmaFromExpectedMax(expectedMaxRatio);

  const empiricalP10 = quantile(ratios, 0.1);
  const empiricalP90 = quantile(ratios, 0.9);
  const sigmaFromRange =
    empiricalP10 > 0 ? Math.log(empiricalP90 / empiricalP10) / (2 * Z_90) : null;

  const rule: BandFitRule = sigmaFromRange === null ? "expected-max" : "empirical-deciles";
  const fitted =
    rule === "empirical-deciles"
      ? { p10: empiricalP10, p90: empiricalP90 }
      : lognormalDeciles(sigmaFromExpectedMax);

  return {
    sampleSize: ratios.length,
    empiricalP10,
    empiricalP50: quantile(ratios, 0.5),
    empiricalP90,
    nonPositiveShare: ratios.filter((ratio) => ratio <= 0).length / ratios.length,
    expectedMaxRatio,
    sigmaFromRange,
    sigmaFromExpectedMax,
    rule,
    band: {
      p10: round3(fitted.p10),
      p90: round3(fitted.p90),
      provenance: "measured",
    },
  };
}
