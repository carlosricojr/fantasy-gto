import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import metrics from "./published-draft-metrics.json";

/**
 * The published figures and the document that quotes them.
 *
 * `docs/draft-validation.md` is the sole authority for what the draft board may claim, and
 * `published-draft-metrics.json` is what the backtest actually wrote. Nothing connected
 * them: the numbers were copied across by hand, and this branch has already had them
 * disagree once — the tie correction moved every figure, and the doc, `config.ts` and
 * `value.ts` each had to be found and edited separately.
 *
 * So this test reads the table out of the markdown and compares it to the JSON. It is not
 * checking arithmetic; it is checking that a rerun of the backtest cannot leave the
 * document quoting figures that no longer exist.
 */
const doc = readFileSync(join(__dirname, "../../../docs/draft-validation.md"), "utf8");

/** The number in a given column of the row whose first cell contains `label`. */
function tableValue(label: string, column: number): number {
  const row = doc
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(label));
  if (row === undefined) throw new Error(`No table row mentioning "${label}"`);
  const cells = row.split("|").map((c) => c.trim());
  // `cells[0]` is the empty string before the leading pipe.
  const raw = cells[column + 1].replace(/\*/g, "");
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Column ${column} of the "${label}" row is not a number: ${raw}`);
  }
  return value;
}

describe("docs/draft-validation.md quotes the published metrics", () => {
  it("matches the Spearman column for all three methods", () => {
    expect(tableValue("Market (ADP)", 1)).toBeCloseTo(metrics.spearman.adpOnly, 4);
    expect(tableValue("Our season model", 1)).toBeCloseTo(metrics.spearman.modelOnly, 4);
    expect(tableValue("Blend, weight", 1)).toBeCloseTo(metrics.spearman.blended, 4);
  });

  it("matches the top-24 and top-48 columns", () => {
    expect(tableValue("Market (ADP)", 2)).toBeCloseTo(metrics.topN["24"].adpOnly, 1);
    expect(tableValue("Our season model", 2)).toBeCloseTo(metrics.topN["24"].modelOnly, 1);
    expect(tableValue("Blend, weight", 2)).toBeCloseTo(metrics.topN["24"].blended, 1);

    expect(tableValue("Market (ADP)", 3)).toBeCloseTo(metrics.topN["48"].adpOnly, 1);
    expect(tableValue("Our season model", 3)).toBeCloseTo(metrics.topN["48"].modelOnly, 1);
    expect(tableValue("Blend, weight", 3)).toBeCloseTo(metrics.topN["48"].blended, 1);
  });

  it("quotes the blend's decline against the market with the right sign and size", () => {
    // The document states this as a positive "0.72% decline", the JSON as a negative
    // percentage. The sign convention differs; the magnitude may not.
    const stated = doc.match(/a ([\d.]+)% decline/);
    expect(stated).not.toBeNull();
    expect(Number(stated![1])).toBeCloseTo(Math.abs(metrics.edgeOverMarketPercent), 2);
    expect(metrics.edgeOverMarketPercent).toBeLessThan(0);
  });

  it("states the sample size the metrics were computed over", () => {
    expect(doc).toContain(String(metrics.sampleSize));
  });

  it("keeps the blend weight the document names in step with the one measured", () => {
    // The label cell reads "Blend, weight 0.2", so the weight is parsed out of it rather
    // than read as a column.
    const row = doc.split("\n").find((line) => line.includes("Blend, weight"));
    const weight = row?.match(/Blend, weight ([\d.]+)/)?.[1];
    expect(weight).toBeDefined();
    expect(Number(weight)).toBeCloseTo(metrics.chosenBlendWeight, 4);
  });
});
