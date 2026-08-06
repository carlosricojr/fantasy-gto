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

/**
 * The honesty ledger, which is the other document these figures have to agree with.
 *
 * `docs/model-validation.md` is the authority for how a number was measured; the README
 * ledger is the index of what the product actually *claims*. A drift between the artifact
 * and the ledger is the more dangerous of the two, because the ledger is what a reader
 * checks a marketing claim against.
 */
const readme = readFileSync(join(__dirname, "../../../README.md"), "utf8");

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
/**
 * The frozen pipeline's own figures, pinned as literals.
 *
 * Every other assertion in this file recomputes one artifact figure from another, which
 * catches internal inconsistency but would happily accept a wholesale shift — if the model
 * changed, or if the backtest started feeding it a different history, all of these would
 * move together and stay self-consistent.
 *
 * These are the numbers that were measured on the holdout under the configuration frozen
 * before 2025 was looked at, transcribed here deliberately. Widening the evaluation window
 * to 2013–2024 must not move them: the holdout runs under `FROZEN_HISTORY_SEASONS` rather
 * than the uniform lookback for exactly that reason. If this test fails, either the model
 * changed — in which case the holdout has been re-evaluated and that needs to have been a
 * pre-registered decision — or the frozen path has been broken by accident.
 *
 * Pinned at the precision they are published at. Reordering players changed the last digit
 * or two of these doubles through floating-point summation before the iteration order was
 * made canonical, and pinning a full double would be pinning an artifact of accumulation
 * order rather than a measurement.
 */
const FROZEN_HOLDOUT = {
  season: 2025,
  sampleSize: 3037,
  clusters: 308,
  modelMae: "5.8236",
  priorGamesMeanMae: "5.9877",
  lastThreeMae: "6.3618",
  edgeVsPriorGamesMean: "2.74",
  edgeVsLastThree: "8.46",
  bias: "-0.573",
  clusteredStandardError: "0.0443",
  t: "3.7035",
} as const;

describe("the frozen holdout evaluation", () => {
  it("still produces the figures it produced before the window was widened", () => {
    expect(metrics.season).toBe(FROZEN_HOLDOUT.season);
    expect(metrics.sampleSize).toBe(FROZEN_HOLDOUT.sampleSize);
    expect(metrics.significance.clusters).toBe(FROZEN_HOLDOUT.clusters);
    expect(metrics.modelMae.toFixed(4)).toBe(FROZEN_HOLDOUT.modelMae);
    expect(metrics.priorGamesMeanMae.toFixed(4)).toBe(FROZEN_HOLDOUT.priorGamesMeanMae);
    expect(metrics.lastThreeMae.toFixed(4)).toBe(FROZEN_HOLDOUT.lastThreeMae);
    expect(metrics.edgeVsPriorGamesMean.toFixed(2)).toBe(
      FROZEN_HOLDOUT.edgeVsPriorGamesMean,
    );
    expect(metrics.edgeVsLastThree.toFixed(2)).toBe(FROZEN_HOLDOUT.edgeVsLastThree);
    expect(metrics.bias.toFixed(3)).toBe(FROZEN_HOLDOUT.bias);
    expect(metrics.significance.clusteredStandardError.toFixed(4)).toBe(
      FROZEN_HOLDOUT.clusteredStandardError,
    );
    expect(metrics.significance.t.toFixed(4)).toBe(FROZEN_HOLDOUT.t);
  });
});

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

  it("puts the significance floor at the edge of the published interval", () => {
    // The floor is what a measured effect has to exceed before p < 0.05, so it is the
    // interval's half-width. Published because it is the sharper of the two power figures:
    // the MDE says what this sample could find, the floor says that anything it does find
    // below the floor is not reportable and anything smaller than the floor can only be
    // reported by overstating itself.
    const half =
      (significance.confidenceInterval[1] - significance.confidenceInterval[0]) / 2;
    expect(significance.minimumSignificantEffect).toBeCloseTo(half, 10);
    expect(significance.minimumSignificantPercent).toBeCloseTo(
      (significance.minimumSignificantEffect / metrics.priorGamesMeanMae) * 100,
      10,
    );
    expect(significance.minimumSignificantEffect).toBeLessThan(
      significance.minimumDetectableEffect,
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
    expect(validation).toContain(significance.minimumSignificantEffect.toFixed(4));
    expect(validation).toContain(`${significance.minimumSignificantPercent.toFixed(2)}%`);
    expect(validation).toContain(`${significance.confidenceLevel}%`);
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

  it("carries the weaker comparison too, and agrees with the document about it", () => {
    // The document quotes this comparison in prose, and nothing produced or checked it
    // until a reviewer noticed. Every figure it states is now derived here from the
    // artifact and matched against the document at the precision it is printed with.
    const weak = metrics.significanceVsLastThree;
    expect(weak.comparison).toContain("last 3");
    expect(weak.meanDelta).toBeCloseTo(metrics.lastThreeMae - metrics.modelMae, 10);
    expect(weak.t).toBeCloseTo(weak.meanDelta / weak.clusteredStandardError, 10);
    expect(weak.pValue).toBeCloseTo(
      studentTTwoSided(weak.t, weak.degreesOfFreedom),
      12,
    );
    expect(weak.minimumSignificantEffect).toBeCloseTo(
      (weak.confidenceInterval[1] - weak.confidenceInterval[0]) / 2,
      10,
    );
    // Measured against the weaker baseline, so the edge must be the larger of the two —
    // the same invariant the headline percentages are held to, one level down.
    expect(weak.meanDelta).toBeGreaterThan(significance.meanDelta);

    expect(validation).toContain(weak.meanDelta.toFixed(4));
    expect(validation).toContain(weak.clusteredStandardError.toFixed(4));
    expect(validation).toContain(weak.t.toFixed(2));
    expect(validation).toContain(weak.minimumDetectableEffect.toFixed(4));
    expect(validation).toContain(`${weak.minimumDetectablePercent.toFixed(2)}%`);
    expect(validation).toContain(weak.minimumSignificantEffect.toFixed(4));
    expect(validation).toContain(`${weak.minimumSignificantPercent.toFixed(2)}%`);
    expect(validation).toContain(weak.bootstrap.standardError.toFixed(4));
    for (const end of [0, 1] as const) {
      expect(validation).toContain(
        `${weak.percentConfidenceInterval[end].toFixed(2)}%`,
      );
    }
  });

  it("agrees with the README honesty ledger, which is what a reader checks", () => {
    // The ledger row for the headline edge quotes the interval. Nothing asserted that
    // before, so a backtest that moved the interval would have left the ledger — the
    // document whose entire job is mapping a claim to its computation — quoting a number
    // the code no longer produces. That is the specific failure the ledger exists to catch,
    // happening to the ledger itself.
    //
    // Matched against the artifact rather than against literals, so this cannot be
    // satisfied by editing the test to agree with a stale README.
    const ledgerRow = readme
      .split("\n")
      .find((line) => line.includes("prior-games-mean baseline"));
    expect(ledgerRow, "honesty ledger row for the headline edge").toBeDefined();

    // The command, not only the numbers. The ledger's job is mapping a claim to the
    // computation behind it, and this row credited a plain `pnpm backtest` after that run
    // stopped scoring the holdout entirely — it now prints "HOLDOUT NOT EVALUATED". Every
    // figure in the row was still correct, so nothing here caught it. A reader following
    // the ledger would have run the command and found none of these numbers.
    expect(ledgerRow).toContain("pnpm backtest -- --holdout");
    expect(ledgerRow).toContain(`${metrics.edgeVsPriorGamesMean.toFixed(2)}%`);
    expect(ledgerRow).toContain(`${significance.confidenceLevel}% CI`);
    for (const end of [0, 1] as const) {
      expect(ledgerRow).toContain(
        `${significance.percentConfidenceInterval[end].toFixed(2)}%`,
      );
    }
    expect(ledgerRow).toContain(String(metrics.significance.clusters));
    expect(ledgerRow).toContain(metrics.sampleSize.toLocaleString("en-US"));

    // The clustering gap, stated in one direction everywhere. `/accuracy` renders this
    // same figure, and it previously rendered the inverse — 18% against the ledger's 22%,
    // both arithmetically right, describing one measurement with two numbers. A reader
    // checking the page against the ledger would have found them disagreeing.
    const widenedBy = Math.round(
      (significance.clusteredStandardError / significance.iidStandardError - 1) * 100,
    );
    expect(ledgerRow).toContain(`${widenedBy}% larger`);
    expect(validation).toContain(`${widenedBy}% larger`);

    // The known gap that bounds every future claim about this model.
    expect(readme).toContain(`${significance.minimumDetectablePercent.toFixed(2)}%`);
    expect(readme).toContain(`${significance.minimumSignificantPercent.toFixed(2)}%`);
    expect(readme).toContain(significance.minimumDetectableEffect.toFixed(4));
  });
});
