import { expect, it } from "vitest";
import { customBoardBlock } from "./custom-board-readiness";
const id = 'sleeper-v1:{"rec":0.5}';
const row = { position: "DST", blendedPoints: 60, historicalScoringSource: "sleeper-custom-stats", weeklyStdDev: 6 };
it("does not treat a catalog-only response as a custom board", () => {
  expect(customBoardBlock(id, [{ position: "WR", blendedPoints: null }])).toMatch(/not been published/);
  expect(customBoardBlock("half_ppr", [])).toBeNull();
});
it("requires custom provenance and signed distribution parameters", () => {
  expect(customBoardBlock(id, [{ ...row, historicalScoringSource: undefined }])).toMatch(/Preset/);
  expect(customBoardBlock(id, [{ ...row, weeklyStdDev: undefined }])).toMatch(/incomplete/);
  expect(customBoardBlock(id, [{ ...row, weeklyStdDev: NaN }])).toMatch(/incomplete/);
  expect(customBoardBlock(id, [row])).toBeNull();
});
it("refuses legacy lognormal skill ranges even with exact-scoring provenance", () => {
  const skill = { ...row, position: "RB", weeklyStdDev: undefined };
  expect(customBoardBlock(id, [skill])).toMatch(/Zero-scoring/);
  expect(customBoardBlock(id, [{ ...skill, weeklyOutcomeRatios: Array(100).fill(1) }])).toBeNull();
  expect(customBoardBlock(id, [{ ...skill, weeklyOutcomeRatios: Array(100).fill(0) }])).toMatch(/incomplete/);
});
