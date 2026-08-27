import { describe, expect, it } from "vitest";

import { Z_90, createRng, standardNormal } from "../../core/rng";
import { normalCdf, quantile } from "../../core/stats";
import {
  type EntitySeason,
  fitOutcomeBand,
  lognormalDeciles,
  lognormalSigmaFromExpectedMax,
  priorSeasonRatios,
} from "./outcome-band";

/**
 * The band a position gets when the backtest cannot produce one.
 *
 * Two things are worth pinning here and they are not the same thing. One is arithmetic —
 * the ratios, the deciles, the inversion — and it is checked against closed forms rather
 * than against numbers somebody recorded once. The other is the *rule*: which of the two
 * fits applies, and why. That is what decides whether a defense ends up with a band the
 * simulator can carry or a degenerate one, so the branch is exercised from both sides.
 */

const season = (id: string, year: number, weeklyPoints: number[]): EntitySeason => ({
  id,
  season: year,
  weeklyPoints,
});

/** A unit-mean lognormal sample, which is exactly what the fit assumes it is handed. */
function lognormalSample(sigma: number, count: number, seed: number): number[] {
  const rng = createRng(seed);
  const mu = -(sigma * sigma) / 2;
  return Array.from({ length: count }, () => Math.exp(mu + sigma * standardNormal(rng)));
}

describe("ratios against the prior season", () => {
  it("divides every week by the entity's own prior-season mean", () => {
    const seasons = [season("k1", 2020, [4, 8]), season("k1", 2021, [3, 9])];
    // Prior mean is 6, so the 2021 weeks are 0.5 and 1.5. 2020 contributes nothing: it has
    // no prior season, which is why a measurement window needs a season of run-up.
    expect(priorSeasonRatios(seasons, 2)).toEqual([0.5, 1.5]);
  });

  it("refuses a denominator taken from too few games", () => {
    const seasons = [season("k1", 2020, [6]), season("k1", 2021, [3, 9])];
    expect(priorSeasonRatios(seasons, 2)).toEqual([]);
    // The same data with the guard satisfied does produce ratios, so the empty result
    // above is the guard firing and not the join failing.
    expect(priorSeasonRatios(seasons, 1)).toEqual([0.5, 1.5]);
  });

  it("keeps a small but positive prior mean, which is a level and not a defect", () => {
    // The guard is at zero, not at one. A kicker who averaged half a point a game had a
    // level; dividing by it is what the construction says to do, and raising the bar would
    // drop real careers out of the sample on no stated grounds.
    const seasons = [season("k1", 2020, [0.5, 0.5]), season("k1", 2021, [1, 2])];
    expect(priorSeasonRatios(seasons, 2)).toEqual([2, 4]);
  });

  it("refuses a non-positive prior mean rather than clamping it", () => {
    // A kicker whose prior season netted zero — every attempt missed — has no level to
    // divide by. Clamping would manufacture enormous ratios; a negative mean would flip
    // the sign of every one of them.
    const zero = [season("k1", 2020, [0, 0]), season("k1", 2021, [3, 9])];
    expect(priorSeasonRatios(zero, 2)).toEqual([]);
    const negative = [season("d1", 2020, [-2, -4]), season("d1", 2021, [3, 9])];
    expect(priorSeasonRatios(negative, 2)).toEqual([]);
  });

  it("keeps entities apart, and keeps seasons in sequence", () => {
    const seasons = [
      season("a", 2020, [10, 10]),
      season("b", 2020, [2, 2]),
      season("a", 2021, [5, 5]),
      season("b", 2021, [4, 4]),
      // Two seasons on, so 2020 is not its prior and it contributes nothing.
      season("a", 2023, [1, 1]),
    ];
    expect(priorSeasonRatios(seasons, 2).sort((x, y) => x - y)).toEqual([0.5, 0.5, 2, 2]);
  });
});

describe("the lognormal the simulator draws from", () => {
  it("has unit mean, so the band contributes shape and never level", () => {
    // `drawPoints` renormalizes to the projection, so a band whose own mean were not one
    // would be silently corrected — and the deciles reported beside it would then belong
    // to a distribution nothing draws from.
    for (const sigma of [0.2, 0.75, 1.3]) {
      const { p10, p90 } = lognormalDeciles(sigma);
      const mu = Math.log(Math.sqrt(p10 * p90));
      expect(Math.exp(mu + (sigma * sigma) / 2)).toBeCloseTo(1, 12);
    }
  });

  it("round-trips through the log-range formula the band is read back with", () => {
    for (const sigma of [0.2, 0.624, 0.905, 1.3]) {
      const { p10, p90 } = lognormalDeciles(sigma);
      expect(Math.log(p90 / p10) / (2 * Z_90)).toBeCloseTo(sigma, 12);
    }
  });
});

describe("inverting the expected maximum", () => {
  it("recovers the dispersion that produced it", () => {
    for (const sigma of [0.1, 0.5, 0.905, 2]) {
      // The closed form: two independent unit-mean lognormals have E[max] = 2 Phi(s/sqrt2).
      const expectedMax = 2 * normalCdf(sigma / Math.SQRT2);
      expect(lognormalSigmaFromExpectedMax(expectedMax)).toBeCloseTo(sigma, 5);
    }
  });

  it("reports no dispersion where the sample shows none", () => {
    expect(lognormalSigmaFromExpectedMax(1)).toBe(0);
    expect(lognormalSigmaFromExpectedMax(0.8)).toBe(0);
  });

  it("saturates rather than returning a band nothing could hold", () => {
    // Two is the ceiling: E[max] of two draws cannot exceed twice the mean. Inherited from
    // `standardNormalQuantile` rather than guarded here, so this is the assertion that the
    // inheritance actually holds.
    expect(lognormalSigmaFromExpectedMax(2)).toBe(Number.POSITIVE_INFINITY);
    expect(lognormalSigmaFromExpectedMax(2.5)).toBe(Number.POSITIVE_INFINITY);
    expect(lognormalSigmaFromExpectedMax(1.999)).toBeLessThan(Number.POSITIVE_INFINITY);
  });
});

describe("fitting a band", () => {
  it("takes the empirical deciles where the tenth percentile is positive", () => {
    const ratios = lognormalSample(0.7, 4000, 20260826);
    const fit = fitOutcomeBand(ratios);
    expect(fit.rule).toBe("empirical-deciles");
    expect(fit.band.p10).toBeCloseTo(quantile(ratios, 0.1), 3);
    expect(fit.band.p90).toBeCloseTo(quantile(ratios, 0.9), 3);
    expect(fit.band.provenance).toBe("measured");
  });

  it("recovers a known dispersion by either route, which is what licenses the substitute", () => {
    // The whole argument for fitting a defense on E[max] is that the two rules agree
    // wherever both are defined. On a sample that really is lognormal they must, and this
    // is the check that they do — 4,000 draws, so the agreement is the formula's and not
    // the sample's.
    const fit = fitOutcomeBand(lognormalSample(0.62, 4000, 4242));
    expect(fit.sigmaFromRange).toBeCloseTo(0.62, 1);
    expect(fit.sigmaFromExpectedMax).toBeCloseTo(0.62, 1);
    expect(Math.abs(fit.sigmaFromExpectedMax - (fit.sigmaFromRange ?? 0))).toBeLessThan(0.03);
  });

  it("switches to the expected-max fit when the tenth percentile is not positive", () => {
    // A defense in miniature: a fifth of weeks at or below zero, so no multiplicative band
    // can carry the empirical p10 and the log range is undefined.
    const ratios = [...lognormalSample(0.8, 800, 7), ...Array.from({ length: 200 }, () => 0)];
    const fit = fitOutcomeBand(ratios);
    expect(fit.empiricalP10).toBe(0);
    expect(fit.sigmaFromRange).toBeNull();
    expect(fit.rule).toBe("expected-max");
    expect(fit.band.p10).toBeGreaterThan(0);
    // The band that gets checked in must read back as the dispersion that was measured,
    // because the log-range formula is how the simulator will re-derive it.
    expect(Math.log(fit.band.p90 / fit.band.p10) / (2 * Z_90)).toBeCloseTo(
      fit.sigmaFromExpectedMax,
      2,
    );
  });

  it("measures the expectation on the clamped sample, because the simulator cannot draw below zero", () => {
    const raw = [-4, -1, 0, 0.5, 1, 1.5, 2, 6];
    const clamped = raw.map((value) => Math.max(0, value));
    expect(fitOutcomeBand(raw).expectedMaxRatio).toBeCloseTo(
      fitOutcomeBand(clamped).expectedMaxRatio,
      12,
    );
  });

  it("divides the expected maximum by the sample's own mean", () => {
    // Pinned against the arithmetic rather than against the other fit, because a
    // comparison between two fits cancels any error the two share — which is exactly how
    // a wrong mean survives a test that looks like it covers one.
    const raw = [-4, -1, 0, 0.5, 1, 1.5, 2, 6];
    const clamped = raw.map((value) => Math.max(0, value));
    const mean = clamped.reduce((sum, value) => sum + value, 0) / clamped.length;
    let expectedMax = 0;
    for (const a of clamped) for (const b of clamped) expectedMax += Math.max(a, b);
    expect(fitOutcomeBand(raw).expectedMaxRatio).toBeCloseTo(
      expectedMax / clamped.length ** 2 / mean,
      12,
    );
    expect(mean).toBeCloseTo(11 / 8, 12);
  });

  it("reports the median of the ratios it was handed", () => {
    const raw = [0, 1, 2, 3, 4, 5, 6, 100];
    expect(fitOutcomeBand(raw).empiricalP50).toBeCloseTo(3.5, 12);
    expect(fitOutcomeBand(raw).empiricalP50).toBe(quantile(raw, 0.5));
  });

  it("reports the deciles raw, so a negative tenth percentile is visible as one", () => {
    // The opposite of the line above, and deliberately so: clamping the *reported*
    // quantiles would move a published number to make a chart tidier.
    const fit = fitOutcomeBand([-4, -1, 0, 0.5, 1, 1.5, 2, 6]);
    expect(fit.empiricalP10).toBeLessThan(0);
    expect(fit.nonPositiveShare).toBeCloseTo(3 / 8, 12);
    expect(fit.rule).toBe("expected-max");
  });

  it("marks what it produced as measured, whichever rule produced it", () => {
    for (const ratios of [lognormalSample(0.5, 500, 1), [0, 0, 1, 2, 3, 4]]) {
      expect(fitOutcomeBand(ratios).band.provenance).toBe("measured");
    }
  });
});
