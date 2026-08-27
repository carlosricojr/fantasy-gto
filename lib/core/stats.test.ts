import { describe, expect, it } from "vitest";

import { Z_90, createRng, standardNormal } from "./rng";
import {
  CONFIDENCE_LEVEL,
  POWER_MULTIPLIER,
  type PairedError,
  Z_POWER_80,
  Z_TWO_SIDED_95,
  bootstrapPairedComparison,
  expectedMaxOfTwo,
  normalCdf,
  standardNormalQuantile,
  pairedComparison,
  pairedOutcomeComparison,
  quantile,
  regularizedIncompleteBeta,
  studentTCdf,
  studentTQuantile,
  studentTTwoSided,
} from "./stats";

/**
 * The estimators behind every interval this project publishes.
 *
 * These are tested against arithmetic done by hand and against closed forms that exist
 * independently of the implementation, not against the implementation's own output. A
 * statistics module checked only by golden values it once produced is a module that can be
 * confidently wrong: the numbers stay stable, the intervals stay narrow, and the model
 * decisions taken on top of them are all made against the wrong noise floor.
 */

/**
 * Six observations across three players, with the clustered standard error worked out by
 * hand below.
 *
 * Deltas are 2, 4 | 0, 2 | 1, 5. Mean 14/6 = 7/3. Centred deltas sum inside each cluster to
 * 4/3, −8/3 and 4/3, so Σ(cluster total)² = 96/9 = 32/3, and
 *   Var = (3/2) · (1/36) · (32/3) = 4/9,  SE = 2/3.
 */
const HAND_FIXTURE: PairedError[] = [
  { cluster: "a", model: 1, baseline: 3 },
  { cluster: "a", model: 1, baseline: 5 },
  { cluster: "b", model: 2, baseline: 2 },
  { cluster: "b", model: 2, baseline: 4 },
  { cluster: "c", model: 3, baseline: 4 },
  { cluster: "c", model: 3, baseline: 8 },
];

describe("pairedComparison", () => {
  it("computes the clustered standard error a hand calculation gives", () => {
    const result = pairedComparison(HAND_FIXTURE);
    expect(result.n).toBe(6);
    expect(result.clusters).toBe(3);
    expect(result.degreesOfFreedom).toBe(2);
    expect(result.meanDelta).toBeCloseTo(7 / 3, 12);
    expect(result.standardError).toBeCloseTo(2 / 3, 12);
  });

  it("computes the i.i.d. standard error a hand calculation gives", () => {
    // Σ(dᵢ − d̄)² = 156/9, so s² = (156/9)/5 = 52/15 and SE = s/√6.
    const expected = Math.sqrt(52 / 15 / 6);
    expect(pairedComparison(HAND_FIXTURE).iidStandardError).toBeCloseTo(expected, 12);
  });

  it("reports the MAEs it differences", () => {
    const result = pairedComparison(HAND_FIXTURE);
    expect(result.modelMean).toBeCloseTo(12 / 6, 12);
    expect(result.baselineMean).toBeCloseTo(26 / 6, 12);
    expect(result.meanDelta).toBeCloseTo(result.baselineMean - result.modelMean, 12);
    expect(result.percentEdge).toBeCloseTo(
      (result.meanDelta / result.baselineMean) * 100,
      12,
    );
  });

  it("computes t, p, the interval and the MDE from that standard error", () => {
    const result = pairedComparison(HAND_FIXTURE);
    expect(result.t).toBeCloseTo(3.5, 12);

    // Student's t on 2 degrees of freedom has the closed form 0.5 + t/(2√(2+t²)), so this
    // p-value is checked against arithmetic rather than against the CDF being reused.
    const cdf = 0.5 + 3.5 / (2 * Math.sqrt(2 + 3.5 ** 2));
    expect(result.pValue).toBeCloseTo(2 * (1 - cdf), 10);

    // t(0.975, 2) = 4.302653, from the standard table.
    expect(result.interval[0]).toBeCloseTo(7 / 3 - 4.302653 * (2 / 3), 5);
    expect(result.interval[1]).toBeCloseTo(7 / 3 + 4.302653 * (2 / 3), 5);
    expect(result.minimumDetectableEffect).toBeCloseTo(POWER_MULTIPLIER * (2 / 3), 12);
    expect(result.minimumSignificantEffect).toBeCloseTo(4.302653 * (2 / 3), 5);
  });

  it("puts the significance floor exactly at the edge of the interval", () => {
    // The floor is the distance from zero at which p crosses 0.05, so it has to be the
    // interval's half-width. If they drifted apart, a comparison could be called
    // significant while its interval covered zero.
    const result = pairedComparison(HAND_FIXTURE);
    expect(result.minimumSignificantEffect).toBeCloseTo(
      (result.interval[1] - result.interval[0]) / 2,
      12,
    );
    // And it is what it says it is: an effect at the floor lands exactly on p = 0.05.
    expect(
      studentTTwoSided(
        result.minimumSignificantEffect / result.standardError,
        result.degreesOfFreedom,
      ),
    ).toBeCloseTo(0.05, 12);
    // Note what is *not* asserted here. The floor sits below the minimum detectable effect
    // only when t(0.975, df) is below the power multiplier of 2.8016, which fails at tiny
    // cluster counts: on this three-cluster fixture t(0.975, 2) is 4.30 and the floor is
    // the larger of the two. That ordering is checked on a realistic panel below instead.
    // The first version of this test asserted it here and failed, which is the useful kind
    // of failure — the "1.96 < 2.80" reasoning behind it silently assumed a normal
    // reference distribution this module deliberately does not use.
    expect(result.minimumSignificantEffect).toBeGreaterThan(0);
  });

  it("scales the percentage interval by the baseline MAE", () => {
    const result = pairedComparison(HAND_FIXTURE);
    expect(result.percentInterval[0]).toBeCloseTo(
      (result.interval[0] / result.baselineMean) * 100,
      12,
    );
    expect(result.percentInterval[1]).toBeCloseTo(
      (result.interval[1] / result.baselineMean) * 100,
      12,
    );
    expect(result.minimumDetectablePercent).toBeCloseTo(
      (result.minimumDetectableEffect / result.baselineMean) * 100,
      12,
    );
  });

  it("reduces to the i.i.d. standard error when every observation is its own cluster", () => {
    // The identity that pins the clustered formula from the other side. With singleton
    // clusters, Σ(cluster total)² collapses to Σ(dᵢ − d̄)² and the G/(G−1) correction
    // becomes n/(n−1), leaving exactly s/√n. If the finite-sample correction, the n²
    // denominator, or the squaring of cluster *totals* were wrong, these would part company.
    const rows = HAND_FIXTURE.map((row, i) => ({ ...row, cluster: `only-${i}` }));
    const result = pairedComparison(rows);
    expect(result.clusters).toBe(6);
    expect(result.standardError).toBeCloseTo(result.iidStandardError, 12);
  });

  it("exceeds the i.i.d. standard error when errors repeat within a player", () => {
    // The case the clustering exists for: three players, each contributing two identical
    // deltas. There are three pieces of evidence here, not six, and the naive formula
    // counts six.
    const rows: PairedError[] = [
      { cluster: "a", model: 0, baseline: 5 },
      { cluster: "a", model: 0, baseline: 5 },
      { cluster: "b", model: 0, baseline: 1 },
      { cluster: "b", model: 0, baseline: 1 },
      { cluster: "c", model: 0, baseline: 3 },
      { cluster: "c", model: 0, baseline: 3 },
    ];
    const result = pairedComparison(rows);
    // Σ(cluster total)² = 16 + 16 + 0 = 32, Var = (3/2)(32/36) = 4/3.
    expect(result.standardError).toBeCloseTo(2 / Math.sqrt(3), 12);
    // s² = 16/5, SE = √(16/5/6).
    expect(result.iidStandardError).toBeCloseTo(Math.sqrt(16 / 5 / 6), 12);
    expect(result.standardError).toBeGreaterThan(result.iidStandardError);
  });

  it("does not assume the model wins", () => {
    // A sign error here would render a losing model as a positive edge, which is the exact
    // failure `published-metrics.test.ts` guards on the other side.
    const rows: PairedError[] = [
      { cluster: "a", model: 5, baseline: 1 },
      { cluster: "b", model: 6, baseline: 2 },
      { cluster: "c", model: 4, baseline: 3 },
    ];
    const result = pairedComparison(rows);
    expect(result.meanDelta).toBeLessThan(0);
    expect(result.percentEdge).toBeLessThan(0);
    expect(result.t).toBeLessThan(0);
    expect(result.interval[0]).toBeLessThan(result.interval[1]);
  });

  it("refuses input it cannot describe rather than returning NaN", () => {
    expect(() => pairedComparison([])).toThrow(/no observations/);
    expect(() =>
      pairedComparison([
        { cluster: "a", model: 1, baseline: 2 },
        { cluster: "a", model: 3, baseline: 4 },
      ]),
    ).toThrow(/at least 2 clusters/);
    // Every percentage divides by the baseline MAE. A baseline that never missed is far
    // more likely to be an unpopulated column than a solved sport, and an edge rendered as
    // `-Infinity%` is the worst way to find that out.
    expect(() =>
      pairedComparison([
        { cluster: "a", model: 1, baseline: 0 },
        { cluster: "b", model: 2, baseline: 0 },
        { cluster: "c", model: 3, baseline: 0 },
      ]),
    ).toThrow(/baseline error is zero/);
  });

  it("reports a degenerate comparison as certain rather than as NaN", () => {
    // Every paired difference identical: no sampling variation, so no t statistic exists.
    // Dividing by a zero standard error would put NaN next to a published claim.
    const constant = pairedComparison([
      { cluster: "a", model: 1, baseline: 3 },
      { cluster: "b", model: 2, baseline: 4 },
      { cluster: "c", model: 5, baseline: 7 },
    ]);
    expect(constant.standardError).toBe(0);
    expect(constant.t).toBe(Infinity);
    expect(constant.pValue).toBe(0);

    const identical = pairedComparison([
      { cluster: "a", model: 1, baseline: 1 },
      { cluster: "b", model: 2, baseline: 2 },
      { cluster: "c", model: 5, baseline: 5 },
    ]);
    expect(identical.t).toBe(0);
    expect(identical.pValue).toBe(1);
  });
});

/**
 * A synthetic panel with real within-player correlation.
 *
 * Built from the seeded generator rather than `Math.random`, so the numbers below are the
 * same on every machine and the tolerances mean something.
 *
 * Each player carries two persistent traits: how hard he is to project at all, and — the
 * one that matters here — how much better or worse the model does on him than on an average
 * player. The second is shared by every week he appears in, so his weeks are not
 * independent evidence about the model's edge. That is the correlation clustering exists
 * for, and what the bootstrap has to recover without being told it is there. An earlier
 * version of this fixture varied only the first trait, which left the *differences*
 * independent and the whole panel silently unclustered.
 */
function syntheticPanel(seed: number, players: number): PairedError[] {
  const rng = createRng(seed);
  const rows: PairedError[] = [];
  for (let player = 0; player < players; player += 1) {
    const difficulty = standardNormal(rng) * 1.5;
    const persistentEdge = standardNormal(rng) * 0.9;
    const weeks = 8 + Math.floor(rng.next() * 10);
    for (let week = 0; week < weeks; week += 1) {
      const model = Math.abs(6 + difficulty + standardNormal(rng) * 3);
      rows.push({
        cluster: `p${player}`,
        model,
        baseline: Math.max(0, model + 0.16 + persistentEdge + standardNormal(rng) * 2),
      });
    }
  }
  return rows;
}

describe("bootstrapPairedComparison", () => {
  const rows = syntheticPanel(20260805, 300);

  it("agrees with the analytic clustered standard error", () => {
    // The documented tolerance is 10%, and it is a statement about the method rather than
    // about this seed. Two thousand resamples carry a Monte Carlo error on the standard
    // error of roughly 1/√(2B) ≈ 1.6%, the cluster bootstrap is itself only asymptotically
    // correct in the number of clusters, and the two estimators are not algebraically the
    // same quantity. Agreeing this closely is the check; agreeing to twelve decimals would
    // mean one of them was computing the other.
    const analytic = pairedComparison(rows);
    const boot = bootstrapPairedComparison(rows, { resamples: 2000, seed: 4242 });
    const ratio = boot.standardError / analytic.standardError;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("agrees with the analytic interval to the same tolerance", () => {
    const analytic = pairedComparison(rows);
    const boot = bootstrapPairedComparison(rows, { resamples: 2000, seed: 4242 });
    for (const end of [0, 1] as const) {
      expect(Math.abs(boot.interval[end] - analytic.interval[end])).toBeLessThan(
        0.1 * analytic.standardError * 2,
      );
      expect(Math.abs(boot.percentInterval[end] - analytic.percentInterval[end])).toBeLessThan(
        0.1 * analytic.minimumDetectablePercent,
      );
    }
  });

  it("recovers a standard error the naive one would understate", () => {
    // The panel has a persistent per-player component, so the naive standard error is the
    // wrong one and the bootstrap must side with the clustered figure. If the resampling
    // ever drew player-weeks instead of players, this is the assertion that would fail.
    const analytic = pairedComparison(rows);
    const boot = bootstrapPairedComparison(rows, { resamples: 2000, seed: 4242 });
    expect(analytic.standardError).toBeGreaterThan(analytic.iidStandardError * 1.05);
    expect(boot.standardError).toBeGreaterThan(analytic.iidStandardError * 1.05);
  });

  it("is reproducible from its seed and sensitive to it", () => {
    const first = bootstrapPairedComparison(rows, { resamples: 500, seed: 11 });
    const again = bootstrapPairedComparison(rows, { resamples: 500, seed: 11 });
    const other = bootstrapPairedComparison(rows, { resamples: 500, seed: 12 });
    expect(again.standardError).toBe(first.standardError);
    expect(again.interval).toEqual(first.interval);
    expect(other.standardError).not.toBe(first.standardError);
    expect(first.seed).toBe(11);
    expect(first.resamples).toBe(500);
  });

  it("puts the significance floor below the detectable effect at a realistic cluster count", () => {
    // With 300 clusters t(0.975, 299) is about 1.968, comfortably under the 2.8016 power
    // multiplier, so the floor is the lower of the two. This is the ordering that makes the
    // winner's curse bite: there is a band of true effects too small to be found reliably
    // yet large enough that a lucky sample can report them — and every report from that
    // band overstates.
    const analytic = pairedComparison(rows);
    expect(analytic.clusters).toBe(300);
    expect(analytic.minimumSignificantEffect).toBeLessThan(
      analytic.minimumDetectableEffect,
    );
  });

  it("brackets the point estimate", () => {
    const analytic = pairedComparison(rows);
    const boot = bootstrapPairedComparison(rows, { resamples: 2000, seed: 4242 });
    expect(boot.interval[0]).toBeLessThan(analytic.meanDelta);
    expect(boot.interval[1]).toBeGreaterThan(analytic.meanDelta);
  });

  it("refuses input it cannot describe", () => {
    expect(() => bootstrapPairedComparison([], { resamples: 100, seed: 1 })).toThrow(
      /no observations/,
    );
    for (const resamples of [1, 0, -5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      // Fractional truncates through the loop bound; Infinity never terminates; NaN makes
      // the loop body unreachable and the standard deviation of an empty sample NaN. All
      // three end as a published interval that is not a number, so none of them is allowed
      // to be an "at least 2" near-miss.
      expect(() =>
        bootstrapPairedComparison(HAND_FIXTURE, { resamples, seed: 1 }),
      ).toThrow(/at least 2 resamples as an integer/);
    }
    expect(() =>
      bootstrapPairedComparison(
        [
          { cluster: "a", model: 1, baseline: 0 },
          { cluster: "b", model: 2, baseline: 0 },
        ],
        { resamples: 10, seed: 1 },
      ),
    ).toThrow(/zero-error baseline clusters/);
    expect(() =>
      bootstrapPairedComparison([{ cluster: "a", model: 1, baseline: 2 }], {
        resamples: 100,
        seed: 1,
      }),
    ).toThrow(/at least 2 clusters/);
  });
});

describe("regularizedIncompleteBeta", () => {
  it("is bounded and monotone on the unit interval", () => {
    expect(regularizedIncompleteBeta(0, 2, 3)).toBe(0);
    expect(regularizedIncompleteBeta(1, 2, 3)).toBe(1);
    let previous = 0;
    for (let x = 0.05; x < 1; x += 0.05) {
      const value = regularizedIncompleteBeta(x, 2.5, 1.5);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it("satisfies the reflection identity", () => {
    // I_x(a,b) = 1 − I_{1−x}(b,a). The implementation evaluates the continued fraction on
    // whichever side converges, so this checks the two branches against each other.
    for (const [x, a, b] of [
      [0.1, 0.5, 3],
      [0.35, 2, 2],
      [0.6, 4, 0.5],
      [0.9, 1.5, 7],
    ] as const) {
      expect(regularizedIncompleteBeta(x, a, b)).toBeCloseTo(
        1 - regularizedIncompleteBeta(1 - x, b, a),
        12,
      );
    }
  });

  it("matches the closed form at integer parameters", () => {
    // I_x(1, b) = 1 − (1−x)^b and I_x(a, 1) = x^a, both elementary.
    for (const x of [0.1, 0.4, 0.75, 0.95]) {
      expect(regularizedIncompleteBeta(x, 1, 3)).toBeCloseTo(1 - (1 - x) ** 3, 12);
      expect(regularizedIncompleteBeta(x, 4, 1)).toBeCloseTo(x ** 4, 12);
    }
  });
});

describe("studentTCdf", () => {
  it("matches the Cauchy closed form at one degree of freedom", () => {
    // t(1) is Cauchy: F(t) = 0.5 + atan(t)/π. Nothing in the continued fraction knows that,
    // so this is an external check on the whole chain.
    for (const t of [-4, -1.5, -0.3, 0, 0.3, 1.5, 4, 12.706]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(0.5 + Math.atan(t) / Math.PI, 10);
    }
  });

  it("matches the closed form at two degrees of freedom", () => {
    // F(t) = 0.5 + t / (2√(2 + t²)).
    for (const t of [-5, -1, 0, 1, 2.5, 4.303]) {
      expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(2 + t * t)), 10);
    }
  });

  it("is symmetric and centred", () => {
    for (const df of [1, 3, 10, 291]) {
      expect(studentTCdf(0, df)).toBeCloseTo(0.5, 12);
      for (const t of [0.4, 1.1, 2.6]) {
        expect(studentTCdf(t, df) + studentTCdf(-t, df)).toBeCloseTo(1, 12);
      }
    }
  });

  it("approaches the normal as the degrees of freedom grow", () => {
    for (const t of [0.5, 1.96, 3]) {
      expect(studentTCdf(t, 5)).toBeLessThan(normalCdf(t));
      expect(Math.abs(studentTCdf(t, 1e7) - normalCdf(t))).toBeLessThan(1e-6);
    }
  });

  it("handles infinite input and rejects impossible degrees of freedom", () => {
    expect(studentTCdf(Infinity, 5)).toBe(1);
    expect(studentTCdf(-Infinity, 5)).toBe(0);
    expect(() => studentTCdf(1, 0)).toThrow(/degrees of freedom/);
  });
});

describe("studentTTwoSided", () => {
  it("agrees with the CDF wherever the CDF is well conditioned", () => {
    for (const df of [1, 2, 10, 291]) {
      for (const t of [-3, -1.2, -0.4, 0.4, 1.2, 3]) {
        expect(studentTTwoSided(t, df)).toBeCloseTo(
          2 * (1 - studentTCdf(Math.abs(t), df)),
          12,
        );
      }
    }
  });

  it("stays positive where the CDF subtraction collapses to zero", () => {
    // This is the reason the tail is computed directly. At |t| this large the CDF rounds to
    // exactly 1 in double precision, so the textbook expression returns a p-value of zero —
    // a claim of infinite certainty from 308 players.
    expect(2 * (1 - studentTCdf(10.2, 307))).toBe(0);
    const p = studentTTwoSided(10.2, 307);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1e-15);
  });

  it("is symmetric, is 1 at zero, and rejects impossible degrees of freedom", () => {
    expect(studentTTwoSided(0, 7)).toBeCloseTo(1, 12);
    expect(studentTTwoSided(2.3, 7)).toBeCloseTo(studentTTwoSided(-2.3, 7), 12);
    expect(studentTTwoSided(Infinity, 7)).toBe(0);
    expect(() => studentTTwoSided(1, 0)).toThrow(/degrees of freedom/);
  });

  it("inverts against the critical values the intervals use", () => {
    // p at the 95% two-sided critical value must be 0.05, which ties the p-value and the
    // interval to the same distribution. If they used different ones, a comparison could
    // report p < 0.05 while its interval covered zero.
    for (const df of [3, 30, 307]) {
      expect(studentTTwoSided(studentTQuantile(0.975, df), df)).toBeCloseTo(0.05, 12);
    }
  });
});

describe("studentTQuantile", () => {
  it("returns the tabulated two-sided 95% critical values", () => {
    // The published table, to the three decimals it is printed with. These are the numbers
    // that set the width of every interval this project publishes.
    const table: Array<[number, number]> = [
      [1, 12.706],
      [2, 4.303],
      [3, 3.182],
      [5, 2.571],
      [10, 2.228],
      [20, 2.086],
      [30, 2.042],
      [60, 2.0],
      [100, 1.984],
    ];
    for (const [df, critical] of table) {
      expect(studentTQuantile(0.975, df)).toBeCloseTo(critical, 3);
    }
  });

  it("returns the tabulated one-sided 95% critical values", () => {
    for (const [df, critical] of [
      [1, 6.314],
      [5, 2.015],
      [10, 1.812],
      [30, 1.697],
    ] as const) {
      expect(studentTQuantile(0.95, df)).toBeCloseTo(critical, 3);
    }
  });

  it("converges to the normal quantile", () => {
    expect(studentTQuantile(0.975, 1e8)).toBeCloseTo(Z_TWO_SIDED_95, 6);
  });

  it("inverts the CDF", () => {
    for (const df of [2, 7, 291]) {
      for (const p of [0.01, 0.25, 0.5, 0.75, 0.99]) {
        expect(studentTCdf(studentTQuantile(p, df), df)).toBeCloseTo(p, 10);
      }
    }
  });

  it("is antisymmetric and rejects probabilities outside (0, 1)", () => {
    expect(studentTQuantile(0.3, 9)).toBeCloseTo(-studentTQuantile(0.7, 9), 10);
    expect(() => studentTQuantile(0, 9)).toThrow(/must be in/);
    expect(() => studentTQuantile(1, 9)).toThrow(/must be in/);
  });
});

describe("the power constants", () => {
  it("are the normal quantiles they claim to be", () => {
    // Checked against `normalCdf`, which is pinned to tabulated values within 7.5e-8 — the
    // same treatment `Z_90` gets, and for the same reason: a constant restated from memory
    // is exactly the kind of unbacked number this repository exists to refuse.
    expect(Math.abs(normalCdf(Z_TWO_SIDED_95) - 0.975)).toBeLessThan(7.5e-8);
    expect(Math.abs(normalCdf(Z_POWER_80) - 0.8)).toBeLessThan(7.5e-8);
    expect(POWER_MULTIPLIER).toBeCloseTo(Z_TWO_SIDED_95 + Z_POWER_80, 15);
    // The multiplier every minimum detectable effect is built from.
    expect(POWER_MULTIPLIER).toBeCloseTo(2.8016, 4);
  });
});

describe("quantile", () => {
  it("interpolates between order statistics", () => {
    const values = [1, 2, 3, 4];
    expect(quantile(values, 0)).toBe(1);
    expect(quantile(values, 1)).toBe(4);
    expect(quantile(values, 0.5)).toBeCloseTo(2.5, 12);
    // Index (4−1)·0.25 = 0.75, so three quarters of the way from 1 to 2.
    expect(quantile(values, 0.25)).toBeCloseTo(1.75, 12);
  });

  it("does not reorder its input", () => {
    const values = [3, 1, 2];
    quantile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it("returns NaN on an empty sample rather than a number", () => {
    expect(quantile([], 0.5)).toBeNaN();
  });

  it("answers from a sample of one, which is the boundary beside that guard", () => {
    // A pre-existing gap the K/D-ST band work surfaced: the empty guard was pinned and
    // the case immediately next to it was not, so a guard that refused one element too
    // many would have gone unnoticed by every caller that reads a quantile.
    for (const q of [0, 0.1, 0.5, 0.9, 1]) expect(quantile([5], q)).toBe(5);
  });
});

/**
 * Paired binary outcomes.
 *
 * Every fixture here is small enough to compute by hand and the arithmetic is written out,
 * because the whole point of the function is that it is *not* the sum of two marginal
 * standard errors and a reader has to be able to check that for themselves.
 */
describe("pairedOutcomeComparison", () => {
  /** `sqrt(((a + b) - n * mean^2) / (n - 1) / n)`, the sample SE of the paired differences. */
  const seOf = (candidateOnly: number, baselineOnly: number, n: number): number => {
    const mean = (candidateOnly - baselineOnly) / n;
    return Math.sqrt((candidateOnly + baselineOnly - n * mean * mean) / (n - 1) / n);
  };

  it("is zero mean and zero error when the two win exactly the same scenarios", () => {
    // Perfectly concordant. Every difference is 0, so there is nothing to be uncertain about.
    const wins = [true, false, true, true, false, false];
    const result = pairedOutcomeComparison(wins, wins);
    expect(result.n).toBe(6);
    expect(result.candidateOnly).toBe(0);
    expect(result.baselineOnly).toBe(0);
    expect(result.agreed).toBe(6);
    expect(result.meanDifference).toBe(0);
    expect(result.standardError).toBe(0);
    expect(result.interval).toEqual([0, 0]);
  });

  it("is zero error when the two disagree in every scenario the same way", () => {
    // Perfectly discordant, one-sided: the candidate wins exactly the four the baseline
    // loses. Every difference is +1, so the mean is 1 and the variance is 0.
    const candidate = [true, true, true, true];
    const baseline = [false, false, false, false];
    const result = pairedOutcomeComparison(candidate, baseline);
    expect(result.candidateOnly).toBe(4);
    expect(result.baselineOnly).toBe(0);
    expect(result.meanDifference).toBe(1);
    expect(result.standardError).toBe(0);
    expect(result.interval).toEqual([1, 1]);
  });

  it("is zero mean and nonzero error when the two disagree in both directions equally", () => {
    // Perfectly discordant, two-sided. Differences are +1, -1, +1, -1: mean 0, and a real
    // spread around it.
    //
    //   a = 2, b = 2, n = 4, mean = 0
    //   SE = sqrt((4 - 0) / 3 / 4) = sqrt(1/3) = 0.5773502691896258
    const result = pairedOutcomeComparison(
      [true, false, true, false],
      [false, true, false, true],
    );
    expect(result.meanDifference).toBe(0);
    expect(result.standardError).toBeCloseTo(Math.sqrt(1 / 3), 12);
    expect(result.standardError).toBeCloseTo(seOf(2, 2, 4), 12);
    expect(result.interval[0]).toBeLessThan(0);
    expect(result.interval[1]).toBeGreaterThan(0);
  });

  it("is the arithmetic on a mixed fixture", () => {
    //   candidate  T T T F F F T F
    //   baseline   T F F F T F F F
    //   difference 0 +1 +1 0 -1 0 +1 0
    //   a = 3, b = 1, agreed = 4, n = 8
    //   mean = 2/8 = 0.25
    //   SE   = sqrt((4 - 8*0.0625) / 7 / 8) = sqrt(3.5 / 56) = 0.25
    const result = pairedOutcomeComparison(
      [true, true, true, false, false, false, true, false],
      [true, false, false, false, true, false, false, false],
    );
    expect(result.candidateOnly).toBe(3);
    expect(result.baselineOnly).toBe(1);
    expect(result.agreed).toBe(4);
    expect(result.meanDifference).toBe(0.25);
    expect(result.standardError).toBeCloseTo(0.25, 12);
    expect(result.standardError).toBeCloseTo(seOf(3, 1, 8), 12);
  });

  it("negates the mean and preserves the error when the two sides are swapped", () => {
    const candidate = [true, true, false, false, true, false];
    const baseline = [false, true, true, false, false, false];
    const forward = pairedOutcomeComparison(candidate, baseline);
    const reversed = pairedOutcomeComparison(baseline, candidate);
    expect(reversed.meanDifference).toBeCloseTo(-forward.meanDifference, 12);
    expect(reversed.standardError).toBeCloseTo(forward.standardError, 12);
    expect(reversed.candidateOnly).toBe(forward.baselineOnly);
    expect(reversed.baselineOnly).toBe(forward.candidateOnly);
    expect(reversed.agreed).toBe(forward.agreed);
    expect(reversed.interval[0]).toBeCloseTo(-forward.interval[1], 12);
    expect(reversed.interval[1]).toBeCloseTo(-forward.interval[0], 12);
  });

  it("is not always tighter than treating the two samples as independent", () => {
    // The invariant a reader might reach for, and it is false. Positively correlated
    // outcomes make the paired error smaller — the usual case, and the reason pairing is
    // worth anything — but negatively correlated ones make it larger, and a sample can land
    // either way. Asserting "paired is always smaller" would be asserting something untrue.
    const n = 4;
    const marginalSum = (a: readonly boolean[]): number => {
      const p = a.filter(Boolean).length / n;
      return Math.sqrt((p * (1 - p)) / n);
    };
    // Discordant: candidate and baseline both win half the scenarios, never the same half.
    const discordant = pairedOutcomeComparison(
      [true, true, false, false],
      [false, false, true, true],
    );
    const independentSum =
      marginalSum([true, true, false, false]) + marginalSum([false, false, true, true]);
    expect(discordant.standardError).toBeGreaterThan(independentSum);

    // Concordant: the same rates, the same scenarios. Zero against the same sum.
    const concordant = pairedOutcomeComparison(
      [true, true, false, false],
      [true, true, false, false],
    );
    expect(concordant.standardError).toBeLessThan(independentSum);
  });

  it("refuses vectors of different lengths", () => {
    expect(() => pairedOutcomeComparison([true, false], [true])).toThrow(
      /same trials/,
    );
  });

  it("refuses fewer than two trials", () => {
    // One observation carries no information about variation between observations, and a
    // standard error of zero would read as certainty.
    expect(() => pairedOutcomeComparison([true], [false])).toThrow(/at least 2 trials/);
    expect(() => pairedOutcomeComparison([], [])).toThrow(/at least 2 trials/);
  });

  it("carries the confidence level it built the interval at", () => {
    const result = pairedOutcomeComparison([true, false, true], [false, false, true]);
    expect(result.confidenceLevel).toBe(CONFIDENCE_LEVEL);
    // Student's t at 2 degrees of freedom, two-sided 95%.
    const critical = studentTQuantile(0.975, 2);
    expect(result.interval[0]).toBeCloseTo(
      result.meanDifference - critical * result.standardError,
      12,
    );
  });
});

describe("the inverse standard normal", () => {
  it("inverts the CDF it is built on", () => {
    // Round-tripped through `normalCdf` rather than against tabulated quantiles, because
    // that is the accuracy actually on offer: the bisection is exact, the CDF is not, and
    // asserting more would be claiming precision the approximation does not have.
    for (const p of [1e-4, 0.01, 0.1, 0.5, 0.9, 0.975, 1 - 1e-4]) {
      expect(normalCdf(standardNormalQuantile(p))).toBeCloseTo(p, 9);
    }
  });

  it("lands on the z-values the rest of the repo is keyed to", () => {
    // Held to the bound the inversion actually inherits rather than to a round number of
    // decimals: an error of `e` in the CDF becomes `e / density` in the quantile, so the
    // tolerance widens as the density thins. Asserting a fixed six decimals passes at 0.9
    // and fails at 0.975 for no reason but that — which is a fact about the density, not
    // a defect. Every one of these is inside its own bound by a factor of two or more.
    const density = (z: number) => Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
    for (const [p, z] of [
      [0.9, Z_90],
      [0.975, Z_TWO_SIDED_95],
      [0.8, Z_POWER_80],
    ] as const) {
      expect(Math.abs(standardNormalQuantile(p) - z)).toBeLessThan(7.5e-8 / density(z));
    }
  });

  it("is antisymmetric about a half", () => {
    for (const p of [0.001, 0.05, 0.3, 0.49]) {
      expect(standardNormalQuantile(p) + standardNormalQuantile(1 - p)).toBeCloseTo(0, 9);
    }
  });

  it("refuses a probability outside the open unit interval rather than guessing", () => {
    expect(standardNormalQuantile(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(standardNormalQuantile(1)).toBe(Number.POSITIVE_INFINITY);
    expect(standardNormalQuantile(-0.5)).toBe(Number.NEGATIVE_INFINITY);
    expect(standardNormalQuantile(1.5)).toBe(Number.POSITIVE_INFINITY);
  });

  it("answers NaN for a NaN, rather than a confident upper tail", () => {
    // `NaN` fails every comparison, so without its own branch it falls out of the
    // below-zero test as `+Infinity` — an invalid probability silently becoming the
    // strongest possible statement about the top of the distribution.
    expect(standardNormalQuantile(Number.NaN)).toBeNaN();
  });
});

describe("the expected maximum of two draws", () => {
  it("is the mean when every draw is the same", () => {
    expect(expectedMaxOfTwo([4, 4, 4])).toBe(4);
  });

  it("matches the definition summed over every ordered pair", () => {
    // The closed form collapses an n-squared double sum to one pass, so the double sum is
    // what it has to be checked against — not against a number somebody computed once.
    const sample = [-3, 0, 0.5, 2, 7, 7, 11.25];
    let total = 0;
    for (const a of sample) for (const b of sample) total += Math.max(a, b);
    expect(expectedMaxOfTwo(sample)).toBeCloseTo(total / sample.length ** 2, 12);
  });

  it("is insensitive to the order it is handed", () => {
    const sample = [5, 1, 9, 2, 2, 8];
    expect(expectedMaxOfTwo([...sample].reverse())).toBeCloseTo(expectedMaxOfTwo(sample), 12);
  });

  it("exceeds the mean by more the wider the sample, and never falls below it", () => {
    const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
    const tight = [9, 10, 11];
    const wide = [0, 10, 20];
    expect(expectedMaxOfTwo(tight)).toBeGreaterThan(mean(tight));
    expect(expectedMaxOfTwo(wide) - mean(wide)).toBeGreaterThan(
      expectedMaxOfTwo(tight) - mean(tight),
    );
  });

  it("has no answer for an empty sample rather than a zero", () => {
    expect(expectedMaxOfTwo([])).toBeNaN();
  });

  it("answers the single value it was given, rather than refusing a sample of one", () => {
    // The guard is on *empty*, and the boundary beside it is the case that must still
    // work: two draws from a one-point distribution have that point as their maximum.
    expect(expectedMaxOfTwo([7])).toBe(7);
    expect(expectedMaxOfTwo([-3])).toBe(-3);
  });
});
