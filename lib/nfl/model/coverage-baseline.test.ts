import { describe, expect, it } from "vitest";
import { priorSeasonCoverageBaseline } from "./coverage-baseline";

const target = { season: 2024, index: 1 };
const history = Array.from({ length: 8 }, (_, i) => ({ period: { season: 2023, index: i + 1 }, points: i - 4 }));
describe("experimental coverage baseline", () => {
  it("names the uncalibrated historical mean and carries no invented distribution", () => {
    expect(priorSeasonCoverageBaseline(history, target)).toEqual({ points: -0.5, method: "prior-season-game-mean",
      historyGames: 8, lastPlayed: { season: 2023, index: 8 }, calibration: "none" });
  });
  it("does not inspect target season, future seasons or older history", () => {
    const extra = [2022, 2024, 2025].flatMap(season => history.map(row => ({ period: { ...row.period, season }, points: 1000 })));
    expect(priorSeasonCoverageBaseline([...history, ...extra], target)).toEqual(priorSeasonCoverageBaseline(history, target));
  });
  it("retains real zero and refuses insufficient, duplicate or malformed history", () => {
    expect(priorSeasonCoverageBaseline(history.map(row => ({ ...row, points: 0 })), target)?.points).toBe(0);
    expect(priorSeasonCoverageBaseline(history.slice(1), target)).toBeNull();
    expect(priorSeasonCoverageBaseline([...history, history[0]], target)).toBeNull();
    expect(priorSeasonCoverageBaseline(history.map((row, i) => i === 0 ? { ...row, points: NaN } : row), target)).toBeNull();
    expect(priorSeasonCoverageBaseline(history, { season: 2024, index: 19 })).toBeNull();
  });
});
