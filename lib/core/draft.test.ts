import { describe, expect, it } from "vitest";

import {
  BENCH_VALUE_WEIGHT,
  benchWeightFor,
  type DraftRosterShape,
  type DraftableCompetitor,
  expectedBestAvailable,
  marginalValue,
  normalCdf,
  recommendDraftPicks,
  rosterValue,
  pickOwnership,
  seatForTeamIndex,
  snakePicks,
  survivalProbability,
} from "./draft";
import type { RosterSlot } from "./optimizer";

/**
 * Draft recommendation.
 *
 * The claims worth testing are the ones the interface makes: that value is solved rather
 * than approximated, that waiting is priced from ADP dispersion rather than treated as a
 * deadline, and that the recommendation follows scarcity rather than raw projection.
 */

const SLOTS: RosterSlot[] = [
  { id: "qb", label: "QB", eligiblePositions: ["QB"] },
  { id: "rb1", label: "RB", eligiblePositions: ["RB"] },
  { id: "rb2", label: "RB", eligiblePositions: ["RB"] },
  { id: "wr1", label: "WR", eligiblePositions: ["WR"] },
  { id: "wr2", label: "WR", eligiblePositions: ["WR"] },
  { id: "te", label: "TE", eligiblePositions: ["TE"] },
  { id: "flex", label: "FLEX", eligiblePositions: ["RB", "WR", "TE"] },
];

const SHAPE: DraftRosterShape = { starters: SLOTS, benchSize: 6 };

function player(
  id: string,
  position: string,
  projectedPoints: number,
  adp: number | null = null,
  adpStdev: number | null = null,
): DraftableCompetitor {
  return {
    id,
    name: id,
    position,
    projectedPoints,
    availability: "active",
    adp,
    adpStdev,
  };
}

describe("normalCdf", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 5);
  });

  it("is symmetric", () => {
    for (const x of [0.3, 1.1, 2.4]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
  });
});

describe("survivalProbability", () => {
  it("is a coin flip at a player's own ADP", () => {
    // The common misreading is that ADP is a deadline. It is a mean: at his own ADP a
    // player is equally likely to have gone or not.
    expect(survivalProbability(player("a", "RB", 200, 40, 12), 40, 300)).toBeCloseTo(
      0.5,
      6,
    );
  });

  it("falls as the pick gets later", () => {
    const p = player("a", "RB", 200, 40, 12);
    const early = survivalProbability(p, 30, 300);
    const at = survivalProbability(p, 40, 300);
    const late = survivalProbability(p, 55, 300);
    expect(early).toBeGreaterThan(at);
    expect(at).toBeGreaterThan(late);
  });

  it("keeps a wide-spread player alive well past his ADP", () => {
    // The reason dispersion is modelled at all: a spread of 12 leaves a real chance five
    // picks later, and a draft strategy that assumed otherwise would reach too early.
    expect(survivalProbability(player("a", "RB", 200, 40, 12), 45, 300)).toBeGreaterThan(
      0.3,
    );
    expect(survivalProbability(player("a", "RB", 200, 40, 1), 45, 300)).toBeLessThan(0.01);
  });

  it("treats an unranked player as going after everyone ranked", () => {
    // Not as pick zero, which would make every unranked player look like the first
    // overall pick.
    const unranked = player("u", "RB", 50, null, null);
    expect(survivalProbability(unranked, 100, 300)).toBeGreaterThan(0.99);
  });
});

describe("rosterValue and marginalValue", () => {
  it("values a roster by its best legal lineup", () => {
    const roster = [player("qb1", "QB", 300), player("rb1", "RB", 200)];
    expect(rosterValue(roster, SHAPE)).toBeCloseTo(500, 6);
  });

  it("discounts players who cannot start", () => {
    // Three quarterbacks, one QB slot and no superflex: the surplus two ride the bench,
    // at the quarterback bench weight rather than the flat one.
    const roster = [
      player("qb1", "QB", 300),
      player("qb2", "QB", 280),
      player("qb3", "QB", 260),
    ];
    const weight = benchWeightFor("QB", SLOTS);
    expect(rosterValue(roster, SHAPE)).toBeCloseTo(300 + weight * (280 + 260), 2);
  });

  it("cannot bank more bench than the league allows", () => {
    const shape: DraftRosterShape = { starters: SLOTS, benchSize: 1 };
    const roster = [
      player("qb1", "QB", 300),
      player("qb2", "QB", 280),
      player("qb3", "QB", 260),
    ];
    // Only the better of the two surplus quarterbacks counts.
    expect(rosterValue(roster, shape)).toBeCloseTo(
      300 + benchWeightFor("QB", SLOTS) * 280,
      2,
    );
  });

  it("values a backup by how many slots his position must fill", () => {
    // The failure this fixes was observable, not theoretical: with a flat bench weight a
    // simulated draft took four quarterbacks and no running backs, because a surplus
    // quarterback's raw points beat a fifth receiver's. A second QB sits behind a starter
    // who plays every week; a third RB covers two slots and a flex.
    expect(benchWeightFor("QB", SLOTS)).toBeLessThan(benchWeightFor("TE", SLOTS));
    expect(benchWeightFor("TE", SLOTS)).toBeLessThan(benchWeightFor("RB", SLOTS));
    expect(benchWeightFor("RB", SLOTS)).toBeCloseTo(benchWeightFor("WR", SLOTS), 6);

    // And the consequence: a higher-scoring surplus quarterback is worth less on the
    // bench than a lower-scoring surplus running back.
    const withStarters = [
      player("qb1", "QB", 320),
      player("rb1", "RB", 200),
      player("rb2", "RB", 190),
      player("rb3", "RB", 180),
    ];
    const surplusQb = marginalValue(withStarters, player("qb2", "QB", 300), SHAPE);
    const surplusRb = marginalValue(withStarters, player("rb4", "RB", 170), SHAPE);
    expect(surplusRb).toBeGreaterThan(surplusQb);
  });

  it("prices a player by what he adds, not by what he scores", () => {
    // A 250-point quarterback is worth 250 to an empty roster and almost nothing to a
    // roster that already has a better one. Raw projection cannot express that; this is
    // the whole reason value is computed against the lineup.
    const empty: DraftableCompetitor[] = [];
    const withQb = [player("qb1", "QB", 300)];
    const candidate = player("qb2", "QB", 250);
    expect(marginalValue(empty, candidate, SHAPE)).toBeCloseTo(250, 6);
    // Precision 2 because marginal values are quantised to two decimals.
    expect(marginalValue(withQb, candidate, SHAPE)).toBeCloseTo(
      benchWeightFor("QB", SLOTS) * 250,
      2,
    );
    // And the base weight is still what the reference-depth positions get.
    expect(benchWeightFor("RB", SLOTS)).toBeCloseTo(BENCH_VALUE_WEIGHT, 6);
  });

  it("routes a surplus player through FLEX when that is legal", () => {
    // A third running back is bench-only in a league with no flex, but a starter here.
    const roster = [player("rb1", "RB", 200), player("rb2", "RB", 190)];
    expect(marginalValue(roster, player("rb3", "RB", 180), SHAPE)).toBeCloseTo(180, 6);
  });
});

describe("expectedBestAvailable", () => {
  it("is the expected value of the first survivor, not of the likeliest", () => {
    // Two backs: a better one who probably will not last, and a worse one who probably
    // will. The expectation weights the second by the chance the first is gone.
    const a = player("a", "RB", 200, 10, 3); // ~0 chance to last to pick 40
    const b = player("b", "RB", 100, 60, 3); // ~certain to last to pick 40
    const value = expectedBestAvailable([a, b], [], SHAPE, 40, 300);
    // Essentially b alone, because a is gone.
    expect(value).toBeGreaterThan(95);
    expect(value).toBeLessThan(105);
  });

  it("rises when the better player is likely to survive", () => {
    const a = player("a", "RB", 200, 80, 3);
    const b = player("b", "RB", 100, 60, 3);
    expect(expectedBestAvailable([a, b], [], SHAPE, 40, 300)).toBeGreaterThan(195);
  });

  it("never exceeds the best player's own value", () => {
    const players = [
      player("a", "RB", 200, 20, 10),
      player("b", "RB", 150, 30, 10),
      player("c", "RB", 120, 40, 10),
    ];
    const best = Math.max(...players.map((p) => marginalValue([], p, SHAPE)));
    expect(expectedBestAvailable(players, [], SHAPE, 35, 300)).toBeLessThanOrEqual(best);
  });

  it("is zero on an empty position", () => {
    expect(expectedBestAvailable([], [], SHAPE, 40, 300)).toBe(0);
  });
});

describe("recommendDraftPicks", () => {
  /** Enough depth at every position that a seven-pick draft actually fills the lineup. */
  const filler = () => [
    player("qb_a", "QB", 250, 40, 6),
    player("qb_b", "QB", 240, 70, 6),
    player("rb_a", "RB", 180, 20, 6),
    player("rb_b", "RB", 175, 45, 6),
    player("rb_c", "RB", 170, 55, 6),
    player("rb_d", "RB", 165, 80, 6),
  ];

  it("prefers the scarce position over the higher projection", () => {
    // The central claim. The receiver is worth more points than the tight end, but two
    // near-equal receivers are very likely to last while the next tight end is a
    // 120-point cliff away. Over a draft that actually fills the lineup, taking the
    // receiver now costs more than it gains.
    const available = [
      ...filler(),
      player("wr_a", "WR", 200, 12, 4),
      player("wr_b", "WR", 190, 30, 4),
      player("wr_c", "WR", 185, 35, 4),
      player("te_a", "TE", 180, 12, 4),
      player("te_b", "TE", 60, 60, 4),
    ];
    const [top] = recommendDraftPicks({
      available,
      myRoster: [],
      shape: SHAPE,
      currentPick: 12,
      nextPick: 25,
      // A real snake tail. With only one pick left the comparison is degenerate: two
      // roster spots against seven slots means raw points win regardless of position.
      remainingPicks: [25, 36, 49, 60, 73, 84],
    });
    expect(top.competitor.id).toBe("te_a");
    // And it explains itself in those terms rather than asserting a verdict.
    expect(top.reasons.map((r) => r.key)).toContain("value.wait");

    // The inverse fixture, to show the rule is not simply "prefer tight ends": make the
    // receivers scarce instead and the recommendation flips.
    const flipped = [
      ...filler(),
      player("wr_a", "WR", 200, 12, 4),
      player("wr_b", "WR", 60, 60, 4),
      player("te_a", "TE", 180, 12, 4),
      player("te_b", "TE", 175, 30, 4),
      player("te_c", "TE", 170, 35, 4),
    ];
    const [flippedTop] = recommendDraftPicks({
      available: flipped,
      myRoster: [],
      shape: SHAPE,
      currentPick: 12,
      nextPick: 25,
      remainingPicks: [25, 36, 49, 60, 73, 84],
    });
    expect(flippedTop.competitor.id).toBe("wr_a");
  });

  it("falls back to raw value when there is no next pick", () => {
    // On the last pick there is nothing to wait for, so the best available wins outright.
    const available = [player("wr_a", "WR", 200, 12, 4), player("te_a", "TE", 180, 12, 4)];
    const [top] = recommendDraftPicks({
      available,
      myRoster: [],
      shape: SHAPE,
      currentPick: 200,
      nextPick: null,
      remainingPicks: [],
    });
    expect(top.competitor.id).toBe("wr_a");
    expect(top.valueIfWaited).toBeNull();
  });

  it("stops recommending a position once its slots are full", () => {
    // With the only QB slot filled by a better player, another quarterback is bench
    // filler and must not outrank a starter-quality back.
    const available = [player("qb2", "QB", 290, 5, 3), player("rb1", "RB", 150, 5, 3)];
    const [top] = recommendDraftPicks({
      available,
      myRoster: [player("qb1", "QB", 300)],
      shape: SHAPE,
      currentPick: 30,
      nextPick: 45,
      remainingPicks: [45],
    });
    expect(top.competitor.id).toBe("rb1");
  });

  it("is deterministic", () => {
    const available = [
      player("a", "RB", 200, 10, 5),
      player("b", "WR", 198, 11, 5),
      player("c", "TE", 197, 12, 5),
    ];
    const state = {
      available,
      myRoster: [],
      shape: SHAPE,
      currentPick: 10,
      nextPick: 20,
      remainingPicks: [20],
    };
    const first = recommendDraftPicks(state).map((r) => r.competitor.id);
    const second = recommendDraftPicks(state).map((r) => r.competitor.id);
    expect(first).toEqual(second);
  });

  it("returns nothing on an empty board rather than throwing", () => {
    expect(
      recommendDraftPicks({
        available: [],
        myRoster: [],
        shape: SHAPE,
        currentPick: 1,
        nextPick: 2,
        remainingPicks: [2],
      }),
    ).toEqual([]);
  });
});

describe("snakePicks", () => {
  it("reverses every other round", () => {
    // Slot 3 of 12, six rounds: 3, 22, 27, 46, 51, 70.
    expect(snakePicks(3, 12, 6)).toEqual([3, 22, 27, 46, 51, 70]);
  });

  it("gives the turn manager back-to-back picks", () => {
    const last = snakePicks(12, 12, 4);
    expect(last).toEqual([12, 13, 36, 37]);
  });

  it("covers every pick exactly once across all slots", () => {
    const teams = 10;
    const rounds = 5;
    const all = Array.from({ length: teams }, (_, i) => snakePicks(i + 1, teams, rounds))
      .flat()
      .sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: teams * rounds }, (_, i) => i + 1));
  });
});

describe("pick ownership", () => {
  // Worth being precise about what these do and do not prove. The map that used to be
  // inlined in the page computed the same seat mapping, so most of the invariants below
  // held for it as well — they guard a future bad extraction rather than catching the bug
  // that shipped. Only the out-of-range slot test exercises the defect itself, which was
  // that `slot > teams` produced another seat's pick numbers and that seat then overwrote
  // the user's. The commit that added these overstated them; this note is the correction.

  /** Every league shape the interface can produce, plus a few beyond it. */
  const shapes: Array<[number, number]> = [];
  for (const teams of [4, 6, 8, 10, 11, 12, 14, 16]) {
    for (let slot = 1; slot <= teams; slot += 1) shapes.push([teams, slot]);
  }

  it("gives every pick in the draft exactly one owner, for every shape", () => {
    // The invariant that matters. Three separate defects hid behind an ownership map that
    // rendered fine and was silently wrong: one seat overwrote another's picks, some picks
    // ended up owned by nobody, and a player recorded against an unowned pick was never
    // marked as taken and kept being recommended after he was gone.
    const rounds = 15;
    for (const [teams, slot] of shapes) {
      const owners = pickOwnership(teams, slot, rounds);
      expect(owners.size).toBe(teams * rounds);
      for (let pick = 1; pick <= teams * rounds; pick += 1) {
        expect(owners.get(pick)).toBeDefined();
      }
    }
  });

  it("gives every team the same number of picks", () => {
    const rounds = 12;
    for (const [teams, slot] of shapes) {
      const counts = new Array<number>(teams).fill(0);
      for (const team of pickOwnership(teams, slot, rounds).values()) counts[team] += 1;
      for (const count of counts) expect(count).toBe(rounds);
    }
  });

  it("puts the user at index 0 owning exactly their own slot's picks", () => {
    for (const [teams, slot] of shapes) {
      const owners = pickOwnership(teams, slot, 10);
      const mine = [...owners.entries()]
        .filter(([, team]) => team === 0)
        .map(([pick]) => pick)
        .sort((a, b) => a - b);
      expect(mine).toEqual(snakePicks(slot, teams, 10).sort((a, b) => a - b));
    }
  });

  it("maps team indices onto distinct seats", () => {
    for (const [teams, slot] of shapes) {
      const seats = Array.from({ length: teams }, (_, i) => seatForTeamIndex(i, slot));
      expect(new Set(seats).size).toBe(teams);
      expect(seats.every((seat) => seat >= 1 && seat <= teams)).toBe(true);
      expect(seatForTeamIndex(0, slot)).toBe(slot);
    }
  });

  it("refuses a slot outside the league instead of producing another seat's picks", () => {
    // The failure this prevents was silent: a slot of 12 in a ten-team league returns the
    // pick set of seat 9, and every number in it looks perfectly ordinary.
    expect(() => snakePicks(12, 10, 15)).toThrow(/outside a 10-team league/);
    expect(() => snakePicks(0, 10, 15)).toThrow();
    expect(() => snakePicks(-1, 10, 15)).toThrow();
    expect(() => snakePicks(1.5, 10, 15)).toThrow();
    expect(() => pickOwnership(10, 12, 15)).toThrow();
  });

  it("still reverses each round, and gives the turn manager back-to-back picks", () => {
    const owners = pickOwnership(12, 1, 4);
    // Seat 1 picks first in odd rounds and last in even ones.
    expect(owners.get(1)).toBe(0);
    expect(owners.get(24)).toBe(0);
    expect(owners.get(25)).toBe(0);
  });
});
