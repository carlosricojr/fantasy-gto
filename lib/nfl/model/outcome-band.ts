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
 * and the dominant functional of the fitted distribution is a maximum: a roster scores the
 * best legal lineup it can field each week. A lone starter contributes his mean whatever
 * the shape is, so shape earns its keep at the slots where two players compete — which is
 * where depth is priced, and where the audit found the defect. It is not *only* `E[max]`:
 * the championship comparison is between season totals, whose spread depends on the shape
 * too. Matching `E[max]` is the criterion because it is the one the objective leans on
 * hardest, not because nothing else moves.
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
 * defined whatever the lower tail does. `pnpm verify-sources` prints both dispersions for
 * all six positions under one construction, which is what makes the substitute checkable
 * rather than asserted, and the honest reading of that table is narrower than it might be:
 * the log range is undefined for four of the six, because a prior-season denominator over a
 * whole release includes plenty of players with scoreless weeks. Where both rules are
 * defined they land within a fifth of each other. So the argument for the substitute is not
 * that it reproduces the incumbent — on two positions it is 4-21% below it — but that it is
 * the only one of the two that is defined everywhere, and that it matches the functional
 * the objective actually consumes. The incumbent is kept wherever it works, for continuity
 * with the four bands the backtest produces.
 *
 * ## What this module does not claim
 *
 * The multiplicative form is an approximation for *every* position, not just these two.
 * `pnpm verify-sources` regresses each entity-season's weekly standard deviation on its own
 * mean and prints the fit: a large positive intercept and a shallow slope at all six, which
 * says weekly spread is mostly additive and a scale family therefore under-disperses strong
 * players and over-disperses weak ones. Measuring a band does not fix that, and nothing
 * here pretends it does. Nor does a
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
 * A ratio at or below one means the sample shows no dispersion at all, and is answered with
 * zero rather than with the negative dispersion the inversion would otherwise return.
 *
 * The upper end needs no guard of its own. Two is the ceiling — the expected maximum of two
 * draws cannot exceed twice the mean — and a ratio at or above it maps to a probability at
 * or above one, which `standardNormalQuantile` already answers as an infinity rather than
 * by extrapolating. A second check for it here would be a branch no input can distinguish,
 * which mutation testing reports as a survivor and a reader reads as a live case.
 */
export function lognormalSigmaFromExpectedMax(ratio: number): number {
  if (!(ratio > 1)) return 0;
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
 *
 * **Throws on a sample it cannot fit, rather than returning one.** Without the two guards
 * below an empty sample produces `NaN` for the mean and the expected maximum, `NaN` fails
 * every comparison on the way down, and the function returns a band of exactly `1/1`
 * stamped `provenance: "measured"` — a perfectly plausible-looking pair, describing a
 * distribution with no spread at all, produced from no data. A sample whose every ratio
 * clamps to zero does the same by a different route. That is the failure mode this whole
 * repository has one rule about, so it is refused loudly at the only place it can arise
 * instead of being left for a caller to notice.
 */
export function fitOutcomeBand(ratios: readonly number[]): OutcomeBandFit {
  if (ratios.length === 0) {
    throw new Error("an outcome band cannot be fitted from an empty sample");
  }
  const clamped = ratios.map((ratio) => Math.max(0, ratio));
  const mean = clamped.reduce((sum, value) => sum + value, 0) / clamped.length;
  // `!(mean > 0)` rather than `mean <= 0`, so a `NaN` from a non-finite ratio is refused
  // here too instead of falling through every later comparison unnoticed.
  if (!(mean > 0)) {
    throw new Error(
      `an outcome band cannot be fitted from ${ratios.length} ratios whose clamped mean ` +
        `is ${mean}: the ratio distribution has to be renormalized to a mean of one, and ` +
        `there is nothing here to renormalize`,
    );
  }
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

  // Rounding is the last place the degenerate band can come back, and it comes back
  // wearing the right label. Three decimals is what the skill bands carry, so a fitted
  // p10 below 0.0005 rounds to exactly zero — and a checked-in zero is what `fitLognormal`
  // floors at an epsilon and turns into the dispersion near six this module exists to
  // refuse. A wide enough sample reaches it: dispersion past about 3.6 puts the tenth
  // percentile of a unit-mean lognormal under that threshold. The pair also has to be
  // strictly increasing, or `ln(p90 / p10)` is zero or negative and the simulator reads
  // back no spread at all.
  const p10 = round3(fitted.p10);
  const p90 = round3(fitted.p90);
  if (!(p10 > 0) || !(p90 > p10)) {
    throw new Error(
      `${ratios.length} ratios fitted to a band of ${p10}/${p90} at three decimals, which ` +
        `is not a pair the log-range formula can read back — the sample is too dispersed ` +
        `for a multiplicative band to describe at the precision the others carry`,
    );
  }

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
    band: { p10, p90, provenance: "measured" },
  };
}
