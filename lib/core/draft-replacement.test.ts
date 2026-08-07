import { describe, expect, it } from "vitest";

import { buildSlots } from "../nfl/roster";
import {
  type ReplacementCandidate,
  leagueUnfilledSlots,
  replacementLevels,
  solveDemand,
  unfilledSlots,
} from "./draft-replacement";

/**
 * Replacement demand.
 *
 * The two things this exists to get right are the two the first attempt got wrong: demand
 * shrinks as rosters fill, and a FLEX is solved rather than divided. Both are asserted here
 * against hand-computable boards, so a regression names the wrong number rather than only
 * the wrong pick.
 */

const STANDARD = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
const TWO_FLEX = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2 });
const SUPERFLEX = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1 });

/** A board with an explicit, readable curve per position. */
function curve(
  position: string,
  count: number,
  top: number,
  step: number,
): ReplacementCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    position,
    value: top - i * step,
  }));
}

function counts(demand: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...demand.entries()].sort());
}

describe("unfilledSlots", () => {
  it("is every slot when the roster is empty", () => {
    expect(unfilledSlots([], STANDARD).map((s) => s.id)).toEqual(
      STANDARD.map((s) => s.id),
    );
  });

  it("solves which slot a player occupies rather than counting positions", () => {
    // Three backs and no receivers. Counting positions against slot kinds would say two
    // back slots are filled and the FLEX is open; the assignment says the third back takes
    // the FLEX and both receiver slots are what remain.
    const roster: ReplacementCandidate[] = [
      { position: "RB", value: 18 },
      { position: "RB", value: 16 },
      { position: "RB", value: 14 },
    ];
    expect(unfilledSlots(roster, STANDARD).map((s) => s.id)).toEqual([
      "qb",
      "wr1",
      "wr2",
      "te",
    ]);
  });

  it("does not credit a slot to a player who cannot fill it", () => {
    // A FLEX does not accept quarterbacks, so a second quarterback leaves it open.
    const roster: ReplacementCandidate[] = [
      { position: "QB", value: 20 },
      { position: "QB", value: 19 },
    ];
    expect(unfilledSlots(roster, STANDARD).map((s) => s.id)).toEqual([
      "rb1",
      "rb2",
      "wr1",
      "wr2",
      "te",
      "flex",
    ]);
  });

  it("aggregates the league without collapsing two teams into one", () => {
    const league = leagueUnfilledSlots(
      [[{ position: "QB", value: 20 }], []],
      STANDARD,
    );
    expect(league).toHaveLength(STANDARD.length * 2 - 1);
    expect(league.filter((s) => s.id === "qb")).toHaveLength(1);
  });
});

describe("solveDemand allocates flexible slots by value, not in equal shares", () => {
  it("gives a flex to the positions that are actually worth it", () => {
    // Twelve teams, one FLEX each. Backs and receivers run far deeper in value than tight
    // ends: the 25th back is worth 8 where the 13th tight end is worth 2. Equal splitting
    // would hand four of the twelve flex slots to tight end. Solving hands it none.
    const unfilled = leagueUnfilledSlots(
      Array.from({ length: 12 }, () => []),
      STANDARD,
    );
    const board = [
      ...curve("QB", 40, 20, 0.2),
      ...curve("RB", 60, 20, 0.5),
      ...curve("WR", 60, 20, 0.5),
      ...curve("TE", 40, 14, 1),
    ];
    const demand = solveDemand(unfilled, board);
    expect(counts(demand)).toEqual({ QB: 12, RB: 30, TE: 12, WR: 30 });
    // Stated as the property rather than only as the number: tight end takes its twelve
    // dedicated slots and no share of the flex at all.
    expect(demand.get("TE")).toBe(12);
    expect((demand.get("RB") ?? 0) + (demand.get("WR") ?? 0)).toBe(60);
  });

  it("sends the flex to a tight end when the tight ends are the ones worth it", () => {
    // The mirror board, so the previous result is a consequence of the value curves rather
    // than of tight end being special.
    const unfilled = leagueUnfilledSlots(
      Array.from({ length: 12 }, () => []),
      STANDARD,
    );
    const board = [
      ...curve("QB", 40, 20, 0.2),
      ...curve("RB", 60, 20, 2),
      ...curve("WR", 60, 20, 2),
      ...curve("TE", 40, 20, 0.1),
    ];
    expect(counts(solveDemand(unfilled, board))).toEqual({
      QB: 12,
      RB: 24,
      TE: 24,
      WR: 24,
    });
  });

  it("scales the flex demand with the number of flex slots", () => {
    const board = [
      ...curve("QB", 40, 20, 0.2),
      ...curve("RB", 60, 20, 0.5),
      ...curve("WR", 60, 20, 0.5),
      ...curve("TE", 40, 14, 1),
    ];
    const one = solveDemand(
      leagueUnfilledSlots(Array.from({ length: 12 }, () => []), STANDARD),
      board,
    );
    const two = solveDemand(
      leagueUnfilledSlots(Array.from({ length: 12 }, () => []), TWO_FLEX),
      board,
    );
    expect(counts(one)).toEqual({ QB: 12, RB: 30, TE: 12, WR: 30 });
    // Twelve more flexible slots, and they fall the same way the first twelve did.
    expect(counts(two)).toEqual({ QB: 12, RB: 36, TE: 12, WR: 36 });
  });

  it("lets a SUPERFLEX take a quarterback the FLEX could not", () => {
    const board = [
      ...curve("QB", 40, 30, 0.2),
      ...curve("RB", 60, 20, 0.5),
      ...curve("WR", 60, 20, 0.5),
      ...curve("TE", 40, 14, 1),
    ];
    // Quarterbacks lead this board by ten points a week. A FLEX cannot take one, so the
    // league drafts twelve; a SUPERFLEX can, so it drafts twenty-four.
    const flex = solveDemand(
      leagueUnfilledSlots(Array.from({ length: 12 }, () => []), STANDARD),
      board,
    );
    const superflex = solveDemand(
      leagueUnfilledSlots(Array.from({ length: 12 }, () => []), SUPERFLEX),
      board,
    );
    expect(flex.get("QB")).toBe(12);
    expect(superflex.get("QB")).toBe(24);
    expect(counts(superflex)).toEqual({ QB: 24, RB: 24, TE: 12, WR: 24 });
  });

  it("reroutes a seated player rather than refusing a slot he is blocking", () => {
    // One QB slot and one SUPERFLEX, and the two best players on the board are
    // quarterbacks. Seating them greedily fills both. The best back then has to displace a
    // quarterback out of the SUPERFLEX and into the QB slot — a reroute, not a refusal.
    // Without it the back would be reported as having no demand at all.
    const slots = buildSlots({ QB: 1, SUPERFLEX: 1 });
    const board: ReplacementCandidate[] = [
      { position: "QB", value: 30 },
      { position: "QB", value: 29 },
      { position: "RB", value: 28 },
    ];
    // Both quarterbacks are better than the back, so a greedy pass with no reroute seats
    // them into `qb` and `superflex` and then has nowhere for the back. The answer is still
    // QB 2 here — that is the maximum — so the reroute is asserted where it changes the
    // answer instead:
    expect(counts(solveDemand(slots, board))).toEqual({ QB: 2 });

    const backHeavy: ReplacementCandidate[] = [
      { position: "QB", value: 30 },
      { position: "RB", value: 29 },
      { position: "QB", value: 5 },
    ];
    // The first quarterback takes the SUPERFLEX by arriving first; the back must then move
    // him into the QB slot to claim it. A refusal would report RB 0 and QB 2.
    expect(counts(solveDemand(slots, backHeavy))).toEqual({ QB: 1, RB: 1 });
  });
});

describe("solveDemand boundaries", () => {
  it("demands only what the board can supply", () => {
    // Twelve teams want twelve quarterbacks and the board holds three.
    const unfilled = leagueUnfilledSlots(
      Array.from({ length: 12 }, () => []),
      STANDARD,
    );
    const board = [
      ...curve("QB", 3, 20, 1),
      ...curve("RB", 60, 20, 0.5),
      ...curve("WR", 60, 20, 0.5),
      ...curve("TE", 40, 14, 1),
    ];
    expect(solveDemand(unfilled, board).get("QB")).toBe(3);
  });

  it("is zero for a position the template has no slot for", () => {
    const unfilled = leagueUnfilledSlots([[]], STANDARD);
    const board = [...curve("RB", 10, 20, 1), ...curve("K", 10, 9, 0.1)];
    // No kicker slot in this template, so no kicker is ever seated.
    expect(solveDemand(unfilled, board).get("K")).toBeUndefined();
  });

  it("is zero for a position whose slots the league has already filled", () => {
    // Every team holds a quarterback, so the next one fills nothing.
    const rosters = Array.from({ length: 12 }, () => [
      { position: "QB", value: 18 },
    ]);
    const unfilled = leagueUnfilledSlots(rosters, STANDARD);
    const board = [
      ...curve("QB", 40, 17, 0.2),
      ...curve("RB", 60, 20, 0.5),
      ...curve("WR", 60, 20, 0.5),
      ...curve("TE", 40, 14, 1),
    ];
    expect(solveDemand(unfilled, board).get("QB")).toBeUndefined();
  });

  it("returns nothing when there is nothing to fill or nothing to fill it with", () => {
    expect(counts(solveDemand([], curve("RB", 5, 10, 1)))).toEqual({});
    expect(counts(solveDemand(STANDARD, []))).toEqual({});
  });

  it("resolves an exact tie the same way whichever order the board arrives in", () => {
    const slots = buildSlots({ FLEX: 1 });
    const tied: ReplacementCandidate[] = [
      { position: "RB", value: 10 },
      { position: "WR", value: 10 },
      { position: "TE", value: 10 },
    ];
    const forward = counts(solveDemand(slots, tied));
    const reversed = counts(solveDemand(slots, [...tied].reverse()));
    expect(forward).toEqual(reversed);
    // Broken by position name, which is the only key that does not depend on input order.
    expect(forward).toEqual({ RB: 1 });
  });
});

describe("replacementLevels", () => {
  it("reads the player at the zero-based demand index", () => {
    // Ten unfilled quarterback slots and a board of twenty. The league takes QB0..QB9, so
    // replacement is QB10 — value 20 - 10 = 10.
    const slots = buildSlots({ QB: 10 });
    const levels = replacementLevels(slots, curve("QB", 20, 20, 1));
    expect(levels.get("QB")).toEqual({ demand: 10, value: 10, exhausted: false });
  });

  it("has no replacement when the demand outruns the board", () => {
    const slots = buildSlots({ QB: 10 });
    const levels = replacementLevels(slots, curve("QB", 10, 20, 1));
    // Exactly ten quarterbacks for ten slots: the league takes all of them.
    expect(levels.get("QB")).toEqual({ demand: 10, value: 0, exhausted: true });
  });

  it("prices a position with no remaining demand against the best of it", () => {
    // No slot anywhere accepts a kicker. A kicker is therefore worth nothing over the
    // kicker who is freely available, which is the best one — not zero, which would make
    // scarcity out of a position nobody can start.
    const slots = buildSlots({ QB: 1 });
    const levels = replacementLevels(slots, [
      ...curve("QB", 5, 20, 1),
      ...curve("K", 5, 9, 0.1),
    ]);
    expect(levels.get("K")).toEqual({ demand: 0, value: 9, exhausted: false });
  });

  it("says nothing about a position with no players on the board", () => {
    const levels = replacementLevels(STANDARD, curve("RB", 5, 20, 1));
    expect(levels.get("QB")).toBeUndefined();
  });

  it("shrinks demand as the league's rosters fill", () => {
    // The premise the first attempt got wrong. Eleven of twelve single-quarterback teams
    // already hold one: the twelfth slot is the only demand left, so the next quarterback
    // is priced against the second-best remaining rather than the thirteenth.
    const board = curve("QB", 40, 20, 1);
    const empty = replacementLevels(
      leagueUnfilledSlots(Array.from({ length: 12 }, () => []), buildSlots({ QB: 1 })),
      board,
    );
    const mostlyFilled = replacementLevels(
      leagueUnfilledSlots(
        [[], ...Array.from({ length: 11 }, () => [{ position: "QB", value: 25 }])],
        buildSlots({ QB: 1 }),
      ),
      board,
    );
    expect(empty.get("QB")).toEqual({ demand: 12, value: 8, exhausted: false });
    expect(mostlyFilled.get("QB")).toEqual({ demand: 1, value: 19, exhausted: false });
  });
});
