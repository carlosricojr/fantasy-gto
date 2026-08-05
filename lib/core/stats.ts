/**
 * Paired-comparison statistics for model evaluation.
 *
 * The project publishes an edge over a baseline. Until this module existed it published a
 * point estimate and nothing else, which makes the only question that matters —
 * "is that difference bigger than the noise?" — unanswerable. Every hypothesis the model
 * might later gain is smaller than the interval measured here, so an interval is not a
 * decoration on the headline figure; it is the instrument that decides what gets built.
 *
 * Two properties of the data drive the design.
 *
 * **Observations are paired.** The model and the baseline predict the *same* player-weeks,
 * so the quantity with the smaller variance is the per-observation difference in absolute
 * error, not the difference of two separately-estimated means. Comparing the two MAEs as
 * independent samples would throw away the pairing and inflate the standard error several
 * times over.
 *
 * **Observations are not independent.** The same player appears up to seventeen times in a
 * season, and a player the model systematically misreads contributes seventeen correlated
 * errors rather than seventeen pieces of evidence. An i.i.d. standard error therefore
 * understates the true one — by about 19% on this project's data — and a t statistic built
 * on it overstates significance by the same factor. Clustering by player fixes that.
 *
 * Everything here is pure: the seed for the bootstrap is passed in, the same way the clock
 * is elsewhere in the domain. `lib/purity.test.ts` enforces it.
 */

import { createRng } from "./rng";

/**
 * One player-week scored by both the model and the baseline.
 *
 * `model` and `baseline` are *errors* — `|predicted − actual|` — not predictions, because
 * that is what MAE averages and what the pairing is over. `cluster` is the unit that
 * repeats: the player.
 */
export interface PairedError {
  cluster: string;
  model: number;
  baseline: number;
}

/**
 * The two-sided 95% normal quantile and the 80%-power normal quantile.
 *
 * These drive the minimum detectable effect. They are checked in `stats.test.ts` against
 * `normalCdf`, which is itself pinned to tabulated values — so they are verified against
 * something external rather than restated from memory, the same treatment `Z_90` gets.
 */
export const Z_TWO_SIDED_95 = 1.959963984540054;
export const Z_POWER_80 = 0.8416212335729143;

/** Sum of `Z_TWO_SIDED_95` and `Z_POWER_80`: the multiplier in the standard power formula. */
export const POWER_MULTIPLIER = Z_TWO_SIDED_95 + Z_POWER_80;

export interface PairedComparison {
  /** Player-weeks scored. */
  n: number;
  /** Distinct clusters — players. The effective sample size for inference. */
  clusters: number;
  /** Mean model error. This is the model's MAE over the scored population. */
  modelMean: number;
  /** Mean baseline error. */
  baselineMean: number;
  /** `baselineMean − modelMean`. Positive means the model is better. */
  meanDelta: number;
  /** `meanDelta / baselineMean × 100`. The published edge. */
  percentEdge: number;
  /** Standard error of `meanDelta`, clustered by player. The one to quote. */
  standardError: number;
  /**
   * Standard error of `meanDelta` assuming independence.
   *
   * Reported alongside the clustered one rather than discarded, because the gap between
   * them is the size of the mistake that publishing the naive figure would have been.
   */
  iidStandardError: number;
  /** `clusters − 1`. */
  degreesOfFreedom: number;
  t: number;
  /** Two-sided, against Student's t on `degreesOfFreedom`. */
  pValue: number;
  /** 95% interval on `meanDelta`. */
  interval: readonly [number, number];
  /**
   * 95% interval on `percentEdge`.
   *
   * `interval` rescaled by `baselineMean`, which treats the baseline's own MAE as fixed.
   * That is an approximation: the baseline mean is estimated from the same sample. It is a
   * good one here because the two are strongly positively correlated — a resample that
   * makes the baseline look worse makes the model look worse with it — and the bootstrap,
   * which propagates the denominator properly, is reported next to it as the check.
   */
  percentInterval: readonly [number, number];
  /**
   * The smallest true effect this sample could detect at 80% power, two-sided α = 0.05.
   *
   * The conventional normal approximation, `(z(1−α/2) + z(1−β)) × SE`. It is mildly
   * optimistic for small cluster counts, where the exact calculation would use a
   * noncentral t. This is the number that says whether a measurement is worth making at
   * all: an effect below it is indistinguishable from noise no matter what comes back.
   */
  minimumDetectableEffect: number;
  /** `minimumDetectableEffect` as a percentage of `baselineMean`. */
  minimumDetectablePercent: number;
}

function meanOf(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Compares a model against a baseline on paired, player-clustered errors.
 *
 * Throws rather than returning `NaN` on an input it cannot describe. A `NaN` printed
 * beside a published claim reads as a measurement, and this project has already been
 * bitten once by a figure that looked derived and was not.
 */
export function pairedComparison(rows: readonly PairedError[]): PairedComparison {
  if (rows.length === 0) {
    throw new Error("pairedComparison: no observations");
  }

  const deltas = rows.map((row) => row.baseline - row.model);
  const n = rows.length;
  const meanDelta = meanOf(deltas);
  const modelMean = meanOf(rows.map((row) => row.model));
  const baselineMean = meanOf(rows.map((row) => row.baseline));
  // A baseline that never missed. Every percentage here divides by it, so continuing would
  // publish an edge of NaN or Infinity against a predictor that was simply perfect — which
  // in practice means the errors were never populated, not that a baseline solved fantasy
  // football. Better to say so than to render it.
  if (baselineMean === 0) {
    throw new Error("pairedComparison: baseline error is zero, no percentage edge exists");
  }

  // Per-cluster sums of the centred deltas. The cluster-robust variance of a mean is
  //   (G / (G−1)) · (1/n²) · Σ_g (Σ_{i∈g} (dᵢ − d̄))²
  // which is the sandwich estimator specialised to a regression on an intercept. Squaring
  // the cluster *total* rather than each observation is the whole difference from the
  // i.i.d. formula: it is what lets errors inside a cluster reinforce each other instead of
  // being counted as independent evidence.
  const clusterSums = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const centred = deltas[i] - meanDelta;
    clusterSums.set(rows[i].cluster, (clusterSums.get(rows[i].cluster) ?? 0) + centred);
  }
  const clusters = clusterSums.size;
  if (clusters < 2) {
    throw new Error(`pairedComparison: needs at least 2 clusters, got ${clusters}`);
  }

  let clusterSumOfSquares = 0;
  for (const sum of clusterSums.values()) clusterSumOfSquares += sum * sum;
  const clusteredVariance =
    (clusters / (clusters - 1)) * (clusterSumOfSquares / (n * n));
  const standardError = Math.sqrt(clusteredVariance);

  // The naive alternative, kept for the comparison rather than for use. With one
  // observation per cluster the two formulas coincide exactly, which is how the clustered
  // one is tested. `n >= 2` here because two distinct clusters need two observations.
  const iidStandardError = Math.sqrt(
    deltas.reduce((sum, delta) => sum + (delta - meanDelta) ** 2, 0) / (n - 1) / n,
  );

  const degreesOfFreedom = clusters - 1;

  // A standard error of exactly zero means every paired difference is identical — the two
  // predictors differ by a constant, or not at all. There is no sampling variation left to
  // test against, so the t statistic is not finite and reporting one would be a fiction.
  const degenerate = standardError === 0;
  const t = degenerate
    ? meanDelta === 0
      ? 0
      : Math.sign(meanDelta) * Infinity
    : meanDelta / standardError;
  const pValue = degenerate
    ? meanDelta === 0
      ? 1
      : 0
    : studentTTwoSided(t, degreesOfFreedom);

  const critical = studentTQuantile(0.975, degreesOfFreedom);
  const halfWidth = critical * standardError;
  const interval: readonly [number, number] = [
    meanDelta - halfWidth,
    meanDelta + halfWidth,
  ];
  const minimumDetectableEffect = POWER_MULTIPLIER * standardError;

  const toPercent = (value: number) => (value / baselineMean) * 100;

  return {
    n,
    clusters,
    modelMean,
    baselineMean,
    meanDelta,
    percentEdge: toPercent(meanDelta),
    standardError,
    iidStandardError,
    degreesOfFreedom,
    t,
    pValue,
    interval,
    percentInterval: [toPercent(interval[0]), toPercent(interval[1])],
    minimumDetectableEffect,
    minimumDetectablePercent: toPercent(minimumDetectableEffect),
  };
}

export interface BootstrapOptions {
  /** Number of resamples. The analytic figures are the primary ones; this is the check. */
  resamples: number;
  /** Passed in rather than drawn, so a published interval is reproducible. */
  seed: number;
}

export interface BootstrapComparison {
  resamples: number;
  seed: number;
  /** Standard deviation of the resampled `meanDelta`. Compare against the analytic SE. */
  standardError: number;
  /** Percentile interval on `meanDelta`. */
  interval: readonly [number, number];
  /**
   * Percentile interval on the percentage edge.
   *
   * Unlike the analytic `percentInterval`, this one recomputes the baseline MAE inside
   * every resample, so the denominator's own sampling error is propagated rather than
   * assumed away.
   */
  percentInterval: readonly [number, number];
}

/**
 * Block bootstrap over clusters, as a distribution-free check on the analytic interval.
 *
 * Whole players are resampled with replacement, never individual player-weeks. Resampling
 * player-weeks would destroy the within-player correlation the clustered standard error
 * exists to account for, and would reproduce the i.i.d. figure the analytic estimator was
 * chosen to avoid — an agreement that proves nothing because both sides made the same
 * mistake.
 *
 * Resampled clusters carry unequal sizes, so the total observation count varies between
 * resamples. That is the correct behaviour: it is part of the sampling variation being
 * estimated.
 */
export function bootstrapPairedComparison(
  rows: readonly PairedError[],
  options: BootstrapOptions,
): BootstrapComparison {
  if (rows.length === 0) {
    throw new Error("bootstrapPairedComparison: no observations");
  }
  if (options.resamples < 2) {
    throw new Error(
      `bootstrapPairedComparison: needs at least 2 resamples, got ${options.resamples}`,
    );
  }

  // Only three numbers per cluster are ever needed, so they are accumulated once. A
  // resample then costs G additions instead of n, which is what makes several thousand
  // resamples across every comparison in the backtest free rather than something to
  // ration.
  const totals = new Map<string, { model: number; baseline: number; count: number }>();
  for (const row of rows) {
    const entry = totals.get(row.cluster) ?? { model: 0, baseline: 0, count: 0 };
    entry.model += row.model;
    entry.baseline += row.baseline;
    entry.count += 1;
    totals.set(row.cluster, entry);
  }
  const clusters = [...totals.values()];
  if (clusters.length < 2) {
    throw new Error(
      `bootstrapPairedComparison: needs at least 2 clusters, got ${clusters.length}`,
    );
  }

  const rng = createRng(options.seed);
  const deltas: number[] = [];
  const percents: number[] = [];
  for (let draw = 0; draw < options.resamples; draw += 1) {
    let model = 0;
    let baseline = 0;
    let count = 0;
    for (let pick = 0; pick < clusters.length; pick += 1) {
      const chosen = clusters[Math.floor(rng.next() * clusters.length)];
      model += chosen.model;
      baseline += chosen.baseline;
      count += chosen.count;
    }
    const delta = (baseline - model) / count;
    deltas.push(delta);
    percents.push((delta / (baseline / count)) * 100);
  }

  const meanDelta = meanOf(deltas);
  const standardError = Math.sqrt(
    deltas.reduce((sum, delta) => sum + (delta - meanDelta) ** 2, 0) / (deltas.length - 1),
  );

  return {
    resamples: options.resamples,
    seed: options.seed,
    standardError,
    interval: [quantile(deltas, 0.025), quantile(deltas, 0.975)],
    percentInterval: [quantile(percents, 0.025), quantile(percents, 0.975)],
  };
}

/** Linear-interpolated quantile of a sorted copy. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lower = Math.floor(at);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (at - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * Lanczos log-gamma, g = 7.
 *
 * Private, and only ever called with arguments at or above 0.5 — the incomplete beta below
 * uses `df/2` and `0.5`, and `df` is a cluster count of at least one. The reflection
 * formula for small arguments is therefore omitted rather than written and left untested.
 */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(x: number): number {
  const z = x - 1;
  let series = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i += 1) series += LANCZOS[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Modified Lentz evaluation of the continued fraction for the incomplete beta. */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;

    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 3e-16) break;
  }
  return h;
}

/**
 * Regularized incomplete beta, `I_x(a, b)`.
 *
 * Exported for its own tests rather than only through `studentTCdf`, because the identities
 * that pin it — `I_x(a,b) = 1 − I_{1−x}(b,a)`, and the closed forms at integer parameters —
 * are statements about this function and check the continued fraction directly.
 */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log(1 - x),
  );
  // The fraction converges quickly only on one side of this point; the symmetry identity
  // moves the other side across.
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Student's t cumulative distribution.
 *
 * Used rather than the normal because the reference distribution for a cluster-robust t
 * statistic has `G − 1` degrees of freedom, not infinitely many. On this project's full
 * season the difference is a fraction of a percent, but the hypotheses this epic will test
 * are measured on subgroups — the players listed Questionable in a season number in the
 * low hundreds of player-weeks and far fewer players — and there the gap is real.
 */
export function studentTCdf(t: number, df: number): number {
  if (df <= 0) throw new Error(`studentTCdf: degrees of freedom must be positive, got ${df}`);
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const tail = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
  return t > 0 ? 1 - tail : tail;
}

/**
 * Two-sided p-value for a t statistic, computed in the tail rather than from the CDF.
 *
 * `2 × (1 − studentTCdf(|t|, df))` is the textbook expression and is wrong in floating
 * point for anything strongly significant: past about |t| = 8 the CDF rounds to exactly 1
 * and the subtraction returns a p-value of exactly zero. Printing `p = 0` claims infinite
 * certainty from a finite sample, which is precisely the kind of unbacked number this
 * project refuses. The incomplete beta *is* the tail mass, so evaluating it directly
 * carries small probabilities down to where doubles stop rather than to where the
 * cancellation does.
 */
export function studentTTwoSided(t: number, df: number): number {
  if (df <= 0) {
    throw new Error(`studentTTwoSided: degrees of freedom must be positive, got ${df}`);
  }
  if (!Number.isFinite(t)) return 0;
  return regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/**
 * Inverse of `studentTCdf`, by bisection.
 *
 * Bisection rather than a closed-form approximation because it is exact to the precision
 * of the CDF it inverts, needs no separate set of fitted constants to audit, and is called
 * a handful of times per backtest — there is nothing to gain by being clever.
 */
export function studentTQuantile(p: number, df: number): number {
  if (p <= 0 || p >= 1) throw new Error(`studentTQuantile: p must be in (0, 1), got ${p}`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);

  let low = 0;
  let high = 1;
  while (studentTCdf(high, df) < p && high < 1e12) high *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
