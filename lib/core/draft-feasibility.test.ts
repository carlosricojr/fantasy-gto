import { describe, expect, it } from "vitest";
import { filledStarterCount, guardDraftCompletion } from "./draft-feasibility";
import { basePolicyPick, completeOwnRoster, trimDraftRoster } from "./draft-policy";
import type { PlayerRisk } from "./roster-utility";
import type { RosterSlot } from "./optimizer";

const player = (id: string, position: string, weeklyMean = 10): PlayerRisk => ({
  id, name: id, position, weeklyMean, availability: 1, byeWeek: 18, p10: 0.5, p90: 1.5, adp: 50,
});
const slots: RosterSlot[] = [
  { id: "qb", label: "QB", eligiblePositions: ["QB"] },
  { id: "rb", label: "RB", eligiblePositions: ["RB"] },
  { id: "flex", label: "FLEX", eligiblePositions: ["RB", "WR", "TE"] },
];
const league = { slots, weeks: [1, 2], wireCover: new Map([["QB", 1]]) };

describe("required starter feasibility", () => {
  it("does not mistake a hypothetical waiver quarterback for an owned starter", () => {
    const roster = [player("rb", "RB"), player("wr", "WR")];
    const available = [player("bench", "RB", 30), player("qb", "QB", 3)];
    const guard = guardDraftCompletion(roster, available, slots, 1);
    expect(guard).toMatchObject({ missingStarters: 1, canComplete: true, reason: "starter-deadline" });
    expect(guard.candidates.map((entry) => entry.id)).toEqual(["qb"]);
    expect(basePolicyPick(roster, available, league, slots, { picksRemaining: 1 })?.id).toBe("qb");
    expect(filledStarterCount(completeOwnRoster(roster, 1, available, league, null, 3, []), slots)).toBe(3);
  });

  it("matches overlapping FLEX and SUPERFLEX slots instead of counting each independently", () => {
    const flexible = [...slots, { id: "sf", label: "SUPERFLEX", eligiblePositions: ["QB", "RB", "WR", "TE"] }];
    const roster = [player("rb", "RB"), player("qb", "QB")];
    expect(filledStarterCount(roster, flexible)).toBe(2);
    const guard = guardDraftCompletion(roster, [player("k", "K"), player("te", "TE"), player("wr", "WR")], flexible, 2);
    expect(guard.canComplete).toBe(true);
    expect(guard.candidates.map((entry) => entry.id).sort()).toEqual(["te", "wr"]);
  });

  it("reports an impossible pool, a short pick budget and zero picks without inventing players", () => {
    const rb = player("rb", "RB");
    expect(guardDraftCompletion([], [rb], slots, 3).canComplete).toBe(false);
    expect(guardDraftCompletion([], [rb, player("qb", "QB"), player("wr", "WR")], slots, 2).canComplete).toBe(false);
    expect(guardDraftCompletion([], [rb], slots, 0).candidates).toEqual([]);
  });

  it("protects the last required positional supply before an opponent can take it", () => {
    const roster = [player("rb", "RB"), player("wr", "WR")];
    const pool = [player("qb", "QB", -2), player("bench", "WR", 30)];
    expect(guardDraftCompletion(roster, pool, slots, 3, 1)).toMatchObject({
      reason: "last-position-supply", candidates: [pool[0]], canComplete: true,
    });
    expect(guardDraftCompletion(roster, pool, slots, 3, 0).reason).toBe("unrestricted");
  });

  it("applies scarcity even when every remaining pick must fill a starter", () => {
    const shape = slots.slice(0, 2);
    const pool = [player("qb", "QB", -2), player("rb1", "RB", 20), player("rb2", "RB", 19)];
    const guard = guardDraftCompletion([], pool, shape, 2, 1);
    expect(guard.candidates.map((entry) => entry.id)).toEqual(["qb"]);
    expect(basePolicyPick([], pool, { ...league, slots: shape }, shape,
      { picksRemaining: 2, opponentsBeforeNext: 1 })?.id).toBe("qb");
  });

  it("does not count held duplicates or points as structural coverage", () => {
    const rb = player("rb", "RB", -10);
    const result = guardDraftCompletion([rb], [rb, player("qb", "QB", -1)], slots, 2);
    expect(result.candidates.map((entry) => entry.id)).toEqual(["qb"]);
    expect(result.missingStarters).toBe(2);
    expect(result.canComplete).toBe(false);
  });

  it("preseason cuts preserve legal starters even when their expected points are negative", () => {
    const roster = [player("qb", "QB", -2), player("rb", "RB", 4), player("wr", "WR", 3), player("bench", "WR", 2)];
    const cut = trimDraftRoster(roster, 3, slots);
    expect(filledStarterCount(cut, slots)).toBe(3);
    expect(cut.map((entry) => entry.id)).toContain("qb");
  });
});
