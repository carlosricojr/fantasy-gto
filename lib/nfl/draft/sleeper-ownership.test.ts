import { describe, expect, it } from "vitest";

import { pickOwnership, snakePicks, teamIndexForSeat } from "../../core/draft";
import { sleeperPickOwnership } from "./sleeper-ownership";

describe("sleeperPickOwnership", () => {
  it("is the ordinary snake map when the draft has no traded picks", () => {
    const result = sleeperPickOwnership({
      teams: 10,
      rounds: 16,
      userSlot: 5,
      slotToRosterId: {},
      tradedPicks: [],
    });
    expect(result.exact).toBe(true);
    if (!result.exact) return;
    expect([...result.owners]).toEqual([...pickOwnership(10, 5, 16)]);
    expect(result.reassignedPicks).toEqual([]);
  });

  it("uses roster ids rather than mistaking them for draft seats", () => {
    // The real failure shape: roster 7 sits in seat 1 and roster 1 in seat 8. Roster 7
    // acquired roster 1's second-round square, so the owner is seat 1, not seat 7.
    const result = sleeperPickOwnership({
      teams: 10,
      rounds: 16,
      userSlot: 5,
      slotToRosterId: { 1: 7, 2: 3, 3: 8, 4: 4, 5: 6, 6: 9, 7: 2, 8: 1, 9: 5, 10: 10 },
      tradedPicks: [{ round: 2, rosterId: 1, ownerId: 7 }],
    });
    expect(result.exact).toBe(true);
    if (!result.exact) return;
    const square = snakePicks(8, 10, 16)[1];
    expect(square).toBe(13);
    expect(result.owners.get(square)).toBe(teamIndexForSeat(1, 5));
    expect(result.reassignedPicks).toEqual([13]);
  });

  it("can give the user an acquired turn and remove a traded-away turn", () => {
    const result = sleeperPickOwnership({
      teams: 4,
      rounds: 3,
      userSlot: 2,
      slotToRosterId: { 1: 40, 2: 20, 3: 10, 4: 30 },
      tradedPicks: [
        { round: 1, rosterId: 40, ownerId: 20 },
        { round: 3, rosterId: 20, ownerId: 10 },
      ],
    });
    expect(result.exact).toBe(true);
    if (!result.exact) return;
    expect(result.owners.get(1)).toBe(0);
    expect(result.owners.get(10)).toBe(teamIndexForSeat(3, 2));
  });

  it("reproduces the live league's shuffled roster map and traded squares", () => {
    const slotToRosterId = { 1: 7, 2: 3, 3: 8, 4: 4, 5: 6, 6: 9, 7: 2, 8: 1, 9: 5, 10: 10 };
    const tradedPicks = [
      [2, 1, 7],
      [1, 2, 2],
      [2, 2, 3],
      [4, 2, 2],
      [2, 3, 8],
      [5, 3, 5],
      [6, 3, 10],
      [3, 5, 10],
      [4, 7, 1],
      [6, 7, 2],
      [3, 10, 3],
    ].map(([round, rosterId, ownerId]) => ({ round, rosterId, ownerId }));
    const result = sleeperPickOwnership({
      teams: 10,
      rounds: 16,
      userSlot: 5,
      slotToRosterId,
      tradedPicks,
    });
    expect(result.exact).toBe(true);
    if (!result.exact) return;

    // Roster 6 is the user in seat 5 and neither acquired nor sold a pick.
    const userPicks = [...result.owners]
      .filter(([, owner]) => owner === 0)
      .map(([pick]) => pick);
    expect(userPicks).toEqual(snakePicks(5, 10, 16));
    // Two endpoint rows are picks traded away and then back to their original owner.
    expect(result.reassignedPicks).toHaveLength(9);
    expect(result.owners.get(snakePicks(8, 10, 16)[1])).toBe(teamIndexForSeat(1, 5));
    expect(result.owners.get(snakePicks(7, 10, 16)[1])).toBe(teamIndexForSeat(2, 5));
  });

  it("fails closed when a trade cannot be mapped exactly", () => {
    const missingSlot = sleeperPickOwnership({
      teams: 4,
      rounds: 3,
      userSlot: 2,
      slotToRosterId: { 1: 40, 2: 20, 3: 10 },
      tradedPicks: [{ round: 1, rosterId: 40, ownerId: 20 }],
    });
    expect(missingSlot).toMatchObject({
      exact: false,
      owners: null,
      unsupported: ["slot_to_roster_id.4"],
    });

    const unknownOwner = sleeperPickOwnership({
      teams: 4,
      rounds: 3,
      userSlot: 2,
      slotToRosterId: { 1: 40, 2: 20, 3: 10, 4: 30 },
      tradedPicks: [{ round: 1, rosterId: 40, ownerId: 99 }],
    });
    expect(unknownOwner).toMatchObject({ exact: false, unsupported: ["owner roster 99"] });
  });

  it("refuses duplicate or out-of-range source squares instead of choosing one", () => {
    const result = sleeperPickOwnership({
      teams: 2,
      rounds: 2,
      userSlot: 1,
      slotToRosterId: { 1: 10, 2: 20 },
      tradedPicks: [
        { round: 3, rosterId: 10, ownerId: 20 },
        { round: 1, rosterId: 10, ownerId: 20 },
        { round: 1, rosterId: 10, ownerId: 10 },
      ],
    });
    expect(result).toMatchObject({
      exact: false,
      unsupported: ["duplicate traded pick 1:10", "traded pick 3:10"],
    });
  });
});
