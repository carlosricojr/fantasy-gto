import { describe, expect, it } from "vitest";
import { drawWeek, type PlayerRisk } from "./roster-utility";
import { playerFingerprint } from "./draft-speculation";

const slots = [{ id: "dst", label: "DST", eligiblePositions: ["DST"] }];
const player: PlayerRisk = {
  id: "dst-test", name: "Test defense", position: "DST", weeklyMean: 4,
  weeklyStdDev: 7, p10: -1, p90: 2, byeWeek: 18, availability: 1,
};
describe("signed custom weekly scoring", () => {
  it("retains negative starts and the supplied mean rather than clamping at zero", () => {
    const draws = Array.from({ length: 5000 }, (_, scenario) => drawWeek([player], slots, [1], 3, 73, scenario)[0]);
    expect(draws.some((value) => value < 0)).toBe(true);
    expect(Math.abs(draws.reduce((a, b) => a + b, 0) / draws.length - 4)).toBeLessThan(.3);
  });
  it("selects signed starters before outcomes, not the better realized defense", () => {
    const backup = { ...player, id: "backup", weeklyMean: 3 };
    for (let scenario = 0; scenario < 100; scenario++) {
      expect(drawWeek([player, backup], slots, [1], 3, 73, scenario)).toEqual(drawWeek([player], slots, [1], 3, 73, scenario));
    }
  });
  it("uses a signed backup during a known bye", () => {
    const starter = { ...player, byeWeek: 1 };
    const backup = { ...player, id: "backup", weeklyMean: 3 };
    expect(drawWeek([starter, backup], slots, [1], 3, 73, 1)).toEqual(drawWeek([backup], slots, [1], 3, 73, 1));
  });
  it("separates cached answers when additive spread changes", () => {
    expect(playerFingerprint(player)).not.toBe(playerFingerprint({ ...player, weeklyStdDev: 8 }));
    expect(playerFingerprint(player)).not.toBe(playerFingerprint({ ...player, weeklyStdDev: undefined }));
  });
  it.each([-1, NaN, Infinity])("refuses an invalid spread %s", (weeklyStdDev) => {
    expect(() => drawWeek([{ ...player, weeklyStdDev }], slots, [1], 3, 73, 1)).toThrow("standard deviation");
  });
  it("allows a deterministic signed distribution", () => {
    expect(drawWeek([{ ...player, weeklyStdDev: 0 }], slots, [1], 3, 73, 1)).toEqual([4]);
  });
});
