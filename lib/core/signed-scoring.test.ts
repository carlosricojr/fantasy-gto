import { describe, expect, it } from "vitest";
import { drawWeek, rosterUtility, type PlayerRisk } from "./roster-utility";
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
  it("may bench a negative pre-game mean, but counts the eligible slot as covered", () => {
    const negative = { ...player, weeklyMean: -4, weeklyStdDev: 0 };
    expect(drawWeek([negative], slots, [1], 3, 73, 1)).toEqual([0]);
    expect(rosterUtility([negative], slots, { weeks: [1], scenarios: 1, meanAbsenceWeeks: 3 }, 73).expectedEmptySlots).toBe(0);
  });
});

describe("zero-inclusive custom skill scoring", () => {
  const skill: PlayerRisk = { ...player, id: "rb", position: "RB", weeklyMean: 10,
    weeklyStdDev: undefined, weeklyOutcomeRatios: Array.from({ length: 100 }, (_, i) => i < 50 ? 0 : 2) };
  const skillSlots = [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }];
  it("preserves measured zero mass, bounded outcomes and mean without a lognormal floor", () => {
    const values = Array.from({ length: 5000 }, (_, scenario) => drawWeek([skill], skillSlots, [1], 3, 73, scenario)[0]);
    expect(new Set(values)).toEqual(new Set([0, 20]));
    expect(Math.abs(values.reduce((a, b) => a + b, 0) / values.length - 10)).toBeLessThan(.4);
  });
  it("cannot use a bench player after observing the starter's zero", () => {
    const backup = { ...skill, id: "backup", weeklyMean: 9 };
    for (let scenario = 0; scenario < 100; scenario++) {
      expect(drawWeek([skill, backup], skillSlots, [1], 3, 73, scenario)).toEqual(drawWeek([skill], skillSlots, [1], 3, 73, scenario));
    }
  });
  it("preserves negative empirical outcomes and separates memo identity", () => {
    const signedSkill = { ...skill, weeklyOutcomeRatios: Array.from({ length: 100 }, (_, i) => i < 50 ? -.2 : 2.2) };
    expect(Array.from({ length: 100 }, (_, s) => drawWeek([signedSkill], skillSlots, [1], 3, 73, s)[0]).some(v => v < 0)).toBe(true);
    expect(playerFingerprint(skill)).not.toBe(playerFingerprint(signedSkill));
  });
  it.each([[], [1], Array(100).fill(0), Array(100).fill(NaN)].map(ratios => ({ ratios })))("rejects malformed or unnormalized knots", ({ ratios }) => {
    expect(() => drawWeek([{ ...skill, weeklyOutcomeRatios: ratios }], skillSlots, [1], 3, 73, 1)).toThrow("mean-one");
  });
  it("rejects two conflicting distribution contracts", () => {
    expect(() => drawWeek([{ ...skill, weeklyStdDev: 1 }], skillSlots, [1], 3, 73, 1)).toThrow("mean-one");
  });
});
