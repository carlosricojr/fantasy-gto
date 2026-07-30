import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
