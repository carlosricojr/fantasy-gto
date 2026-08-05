import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  POWER_MULTIPLIER,
  studentTQuantile,
  studentTTwoSided,
} from "../../core/stats";
import metrics from "./published-metrics.json";

/**
 * The figures the interface publishes.
 *
 * `pnpm backtest` writes `published-metrics.json`, and `/accuracy` and the landing page
 * render it directly, so nothing on those pages is transcribed by hand. That removes the
 * drift, but it introduces a new way to be wrong: the artifact is checked in, so it can be
 * edited, or left stale while the model changes underneath it.
 *
 * These tests are the guard. They cannot re-run the backtest — it needs the network — so
 * instead they check the two things that would betray a hand-edited or stale file: that the
 * derived percentages still follow from the raw errors, and that the document which is the
 * sole authority for accuracy claims states the same headline numbers.
 */

const validation = readFileSync(
  join(__dirname, "../../../docs/model-validation.md"),
  "utf8",
);

describe("published metrics", () => {
  it("derives its percentages from its own error figures", () => {
    const edge =
      ((metrics.priorGamesMeanMae - metrics.modelMae) / metrics.priorGamesMeanMae) * 100;
    expect(metrics.edgeVsPriorGamesMean).toBeCloseTo(edge, 10);

    const lastThree =
      ((metrics.lastThreeMae - metrics.modelMae) / metrics.lastThreeMae) * 100;
    expect(metrics.edgeVsLastThree).toBeCloseTo(lastThree, 10);
  });

  it("beats the baselines it claims to beat", () => {
    // A sign error here would render as a positive edge over a baseline the model loses to.
    expect(metrics.modelMae).toBeLessThan(metrics.priorGamesMeanMae);
    expect(metrics.modelMae).toBeLessThan(metrics.lastThreeMae);
    expect(metrics.edgeVsPriorGamesMean).toBeGreaterThan(0);
  });

  it("quotes the weaker baseline as the smaller edge", () => {
    // The prior-games mean is the stronger baseline, so the edge over it must be the
    // smaller of the two. If this ever inverts, the page's "cherry-picking" caveat is
    // pointed at the wrong number.
    expect(metrics.edgeVsPriorGamesMean).toBeLessThan(metrics.edgeVsLastThree);
  });

  it("agrees with docs/model-validation.md, the sole authority for these claims", () => {
    expect(validation).toContain(metrics.modelMae.toFixed(4));
    expect(validation).toContain(metrics.priorGamesMeanMae.toFixed(4));
    expect(validation).toContain(metrics.lastThreeMae.toFixed(4));
    expect(validation).toContain(`${metrics.edgeVsPriorGamesMean.toFixed(2)}%`);
    expect(validation).toContain(`${metrics.edgeVsLastThree.toFixed(2)}%`);
    expect(validation).toContain(String(metrics.sampleSize.toLocaleString("en-US")));
  });

  it("agrees with the disclosed residual bias", () => {
    // Negative means the model projects high. The README and /accuracy both disclose it,
    // so the sign matters as much as the magnitude.
    expect(metrics.bias).toBeLessThan(0);
    expect(validation).toContain(metrics.bias.toFixed(3).replace("-", "−"));
  });

  it("labels the calibration figure with the season it was measured on", () => {
    // This one is in-sample and the page says so. The factors are fitted on the tuning
    // season, so measuring the on/off difference there flatters the effect — it is the
    // season the correction was derived from. It is reported because it is the figure the
    // sweeps table carries and it isolates calibration from every other term; the
    // out-of-sample counterpart is in docs/model-validation.md, where syncing the factors
    // moved 2025 MAE from 5.8324 to 5.8236.
    //
    // What must hold is that it is never presented as the evaluation result.
    expect(metrics.calibration.season).toBeLessThan(metrics.season);
    expect(metrics.calibration.onMae).toBeLessThan(metrics.calibration.offMae);
    expect(validation).toContain(metrics.calibration.onMae.toFixed(4));
    expect(validation).toContain(metrics.calibration.offMae.toFixed(4));
  });

  it("covers every position the interface names", () => {
    for (const position of ["QB", "RB", "WR", "TE"]) {
      expect(metrics.perPositionMae[position as "QB"]).toBeGreaterThan(0);
    }
  });
});

/**
 * The interval published beside the headline edge.
 *
 * These checks matter more than the ones above, because an interval is the one figure on
 * the page a reader cannot sanity-check by eye. A point estimate that drifts looks wrong
 * eventually; an interval that is too narrow by a factor of 1.22 looks exactly like a
 * correct one, and it is the number every future decision about this model gets made
 * against.
 *
 * So each figure is recomputed here from the others using the same estimators the script
 * used, rather than compared against a value written down once. That is what would catch a
 * hand-edited artifact, a swapped standard error, or an interval left behind by a model
 * change.
 */
describe("published significance", () => {
  const { significance } = metrics;

  it("differences the two MAEs it claims to difference", () => {
    expect(significance.meanDelta).toBeCloseTo(
      metrics.priorGamesMeanMae - metrics.modelMae,
      10,
    );
    expect(significance.comparison).toContain("prior games");
  });

  it("has fewer players than player-weeks, which is why it clusters at all", () => {
    // The whole reason the clustered standard error exists. If these were equal, every
    // player appeared once and there would be nothing to cluster.
    expect(significance.clusters).toBeGreaterThan(1);
    expect(significance.clusters).toBeLessThan(metrics.sampleSize);
    expect(significance.degreesOfFreedom).toBe(significance.clusters - 1);
  });

  it("builds t and p from the clustered standard error, not the i.i.d. one", () => {
    // The single most consequential way this artifact could be wrong: the two standard
    // errors differ by 22% on this sample, so a swap would still look entirely plausible
    // while overstating every significance claim built on it.
    expect(significance.t).toBeCloseTo(
      significance.meanDelta / significance.clusteredStandardError,
      10,
    );
    expect(significance.pValue).toBeCloseTo(
      studentTTwoSided(significance.t, significance.degreesOfFreedom),
      12,
    );
    expect(significance.pValue).toBeGreaterThan(0);
    expect(significance.pValue).toBeLessThanOrEqual(1);
  });

  it("is the interval those figures imply", () => {
    const half =
      studentTQuantile(0.975, significance.degreesOfFreedom) *
      significance.clusteredStandardError;
    expect(significance.confidenceInterval[0]).toBeCloseTo(
      significance.meanDelta - half,
      10,
    );
    expect(significance.confidenceInterval[1]).toBeCloseTo(
      significance.meanDelta + half,
      10,
    );
    expect(significance.confidenceInterval[0]).toBeLessThan(significance.meanDelta);
    expect(significance.confidenceInterval[1]).toBeGreaterThan(significance.meanDelta);
  });

  it("scales the percentage interval by the same baseline the edge is scaled by", () => {
    // If these used different denominators, the interval on the page would not be an
    // interval around the number printed next to it.
    for (const end of [0, 1] as const) {
      expect(significance.percentConfidenceInterval[end]).toBeCloseTo(
        (significance.confidenceInterval[end] / metrics.priorGamesMeanMae) * 100,
        10,
      );
    }
    expect(metrics.edgeVsPriorGamesMean).toBeGreaterThan(
      significance.percentConfidenceInterval[0],
    );
    expect(metrics.edgeVsPriorGamesMean).toBeLessThan(
      significance.percentConfidenceInterval[1],
    );
  });

  it("derives the minimum detectable effect from the standard error", () => {
    expect(significance.minimumDetectableEffect).toBeCloseTo(
      POWER_MULTIPLIER * significance.clusteredStandardError,
      10,
    );
    expect(significance.minimumDetectablePercent).toBeCloseTo(
      (significance.minimumDetectableEffect / metrics.priorGamesMeanMae) * 100,
      10,
    );
  });

  it("agrees with the bootstrap that cross-checks it", () => {
    // A distribution-free estimate of the same quantity, from resampled players. The
    // tolerance is 10% and describes the method rather than this run: 2,000 resamples carry
    // a Monte Carlo error near 1.6% on a standard error, and the two estimators are not the
    // same algebra. Agreement here is what says the analytic formula is not quietly wrong.
    expect(significance.bootstrap.resamples).toBeGreaterThanOrEqual(2000);
    const ratio =
      significance.bootstrap.standardError / significance.clusteredStandardError;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
    for (const end of [0, 1] as const) {
      expect(
        Math.abs(
          significance.bootstrap.percentConfidenceInterval[end] -
            significance.percentConfidenceInterval[end],
        ),
      ).toBeLessThan(0.1 * significance.minimumDetectablePercent);
    }
  });

  it("agrees with docs/model-validation.md, the sole authority for these claims", () => {
    expect(validation).toContain(significance.clusteredStandardError.toFixed(4));
    expect(validation).toContain(significance.iidStandardError.toFixed(4));
    expect(validation).toContain(significance.t.toFixed(2));
    expect(validation).toContain(significance.pValue.toFixed(5));
    expect(validation).toContain(String(significance.clusters));
    expect(validation).toContain(significance.minimumDetectableEffect.toFixed(4));
    expect(validation).toContain(`${significance.minimumDetectablePercent.toFixed(2)}%`);
    expect(validation).toContain(significance.bootstrap.standardError.toFixed(4));
    // The seed and the resample count are the document's reproducibility claim: someone
    // re-running the backtest has to be able to land on the same interval. Change either in
    // the script without touching the document and the claim is quietly false, so both are
    // pinned here rather than only the figure they produced.
    expect(validation).toContain(String(significance.bootstrap.seed));
    expect(validation).toContain(
      significance.bootstrap.resamples.toLocaleString("en-US"),
    );
    for (const end of [0, 1] as const) {
      expect(validation).toContain(significance.confidenceInterval[end].toFixed(4));
      expect(validation).toContain(
        `${significance.percentConfidenceInterval[end].toFixed(2)}%`,
      );
    }
  });
});
