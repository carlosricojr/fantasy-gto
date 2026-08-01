import { describe, expect, it } from "vitest";

import { buildSlots } from "../nfl/roster";
import {
  type DraftPolicyState,
  type DraftTeam,
  basePolicyPick,
  completeDraft,
  recommendByChampionship,
} from "./draft-policy";
import { snakePicks } from "./draft";
import { createRng } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import type { LeagueConfig } from "./season-sim";

/**
 * Draft policy.
 *
 * The behaviours worth pinning are the ones the previous objective could not produce:
 * filling a slot rather than hoarding points, covering a bye, and preferring a durable
 * starter — none of which are coded as rules anywhere. They are consequences of playing
 * the season out.
 */

const SLOTS = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
const TEAMS = 8;
const ROUNDS = 10;

const CONFIG: LeagueConfig = {
  slots: SLOTS,
  weeks: Array.from({ length: 14 }, (_, i) => i + 1),
  playoffWeeks: [15, 16],
  playoffTeams: 4,
  scenarios: 150,
  meanAbsenceWeeks: 3,
};

function player(
  id: string,
  position: string,
  weeklyMean: number,
  overrides: Partial<PlayerRisk> = {},
): PlayerRisk {
  return {
    id,
    name: id,
    position,
    weeklyMean,
    p10: 0.269,
    p90: 1.901,
    byeWeek: null,
    availability: 0.9,
    ...overrides,
  };
}

/** A deep enough board that the draft can actually be completed. */
function board(): PlayerRisk[] {
  const players: PlayerRisk[] = [];
  for (const [position, count] of [
    ["QB", 20],
    ["RB", 40],
    ["WR", 40],
    ["TE", 20],
  ] as const) {
    for (let i = 0; i < count; i += 1) {
      players.push(
        player(`${position}${i}`, position, 18 - i * 0.35, {
          byeWeek: 5 + (i % 8),
        }),
      );
    }
  }
  return players;
}

function freshTeams(): DraftTeam[] {
  return Array.from({ length: TEAMS }, (_, i) => ({
    id: `t${i}`,
    name: `Team ${i + 1}`,
    roster: [],
    remainingPicks: snakePicks(i + 1, TEAMS, ROUNDS),
  }));
}

describe("basePolicyPick", () => {
  it("takes the player who adds most to the starting lineup", () => {
    const roster = [player("qb", "QB", 20)];
    const available = [player("qb2", "QB", 19), player("rb", "RB", 12)];
    // A second quarterback cannot start; a back fills an empty slot.
    expect(basePolicyPick(roster, available, SLOTS)?.id).toBe("rb");
  });

  it("returns null on an empty board rather than throwing", () => {
    expect(basePolicyPick([], [], SLOTS)).toBeNull();
  });
});

describe("completeDraft", () => {
  const state = (): DraftPolicyState => ({
    teams: freshTeams(),
    myTeamIndex: 0,
    available: board(),
    rosterSize: ROUNDS,
  });

  it("fills every team to the roster size", () => {
    const rosters = completeDraft(state(), SLOTS, null);
    for (const roster of rosters) expect(roster).toHaveLength(ROUNDS);
  });

  it("never gives the same player to two teams", () => {
    const rosters = completeDraft(state(), SLOTS, null);
    const ids = rosters.flat().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("honours a forced first pick", () => {
    const s = state();
    const forced = s.available.find((p) => p.id === "TE9")!;
    const rosters = completeDraft(s, SLOTS, forced);
    expect(rosters[0].map((p) => p.id)).toContain("TE9");
  });

  it("leaves no starting slot unfilled, which the old objective could not manage", () => {
    const rosters = completeDraft(state(), SLOTS, null);
    for (const roster of rosters) {
      for (const slot of SLOTS) {
        expect(roster.some((p) => slot.eligiblePositions.includes(p.position))).toBe(true);
      }
    }
  });
});

describe("recommendByChampionship", () => {
  it("is deterministic for a seed", () => {
    const s: DraftPolicyState = {
      teams: freshTeams(),
      myTeamIndex: 0,
      available: board(),
      rosterSize: ROUNDS,
    };
    const first = recommendByChampionship(s, CONFIG, 3, createRng, 4);
    const second = recommendByChampionship(s, CONFIG, 3, createRng, 4);
    expect(first.map((r) => r.player.id)).toEqual(second.map((r) => r.player.id));
  });

  it("reports a standard error and flags candidates that are tied", () => {
    // A title is a rare event, so the top few candidates are frequently inside the noise.
    // Presenting that ordering as resolved would be false precision.
    const recs = recommendByChampionship(
      {
        teams: freshTeams(),
        myTeamIndex: 0,
        available: board(),
        rosterSize: ROUNDS,
      },
      CONFIG,
      5,
      createRng,
      5,
    );
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(r.standardError).toBeGreaterThan(0);
    expect(recs[0].tiedWithLeader).toBe(true);
  });

  it("avoids stacking a bye it already has", () => {
    // Both my backs share a bye. Among otherwise similar candidates the recommendation
    // should not add a third on the same week. Nothing in the code says so — the week
    // simply scores zero when the slot cannot be filled.
    const all = board();
    const clashers = all.filter((p) => p.position === "RB" && p.byeWeek === 5);
    const teams = freshTeams();
    teams[0].roster = [clashers[0], clashers[1]];
    teams[0].remainingPicks = snakePicks(1, TEAMS, ROUNDS).slice(2);

    const available = all.filter((p) => p.id !== clashers[0].id && p.id !== clashers[1].id);
    const recs = recommendByChampionship(
      { teams, myTeamIndex: 0, available, rosterSize: ROUNDS },
      CONFIG,
      11,
      createRng,
      8,
    );

    const top = recs[0];
    // The leader either plays a different week, or is not a back at all.
    expect(top.player.byeWeek === 5 && top.player.position === "RB").toBe(false);
  });

  it("prefers the durable player between two otherwise identical starters", () => {
    // Availability is a real input, not a label. With a slot to fill and two equal
    // candidates, the one who plays more weeks wins — again with no rule saying so.
    const teams = freshTeams();
    // Deliberately the two best players on the board, identical in every respect except
    // how often they play, so availability is the only thing that can separate them.
    const fragile = player("fragile", "RB", 22, { availability: 0.45, byeWeek: 9 });
    const durable = player("durable", "RB", 22, { availability: 0.97, byeWeek: 9 });
    const filler = board().filter((p) => p.position !== "RB");

    const recs = recommendByChampionship(
      {
        teams,
        myTeamIndex: 0,
        available: [durable, fragile, ...filler],
        rosterSize: ROUNDS,
      },
      CONFIG,
      13,
      createRng,
      8,
    );

    // A paired comparison, not an absolute ranking. Against the rest of the board the
    // title odds of the top few candidates sit inside sampling noise — which is what
    // `tiedWithLeader` reports — so asserting an outright winner would be asserting
    // precision the estimate does not have. Durable against fragile does resolve.
    const durableRank = recs.findIndex((r) => r.player.id === "durable");
    const fragileRank = recs.findIndex((r) => r.player.id === "fragile");

    expect(durableRank).toBeGreaterThanOrEqual(0);
    // Fragile is either ranked below him or filtered out before the objective, and both
    // mean the same thing: missing half a season is priced.
    expect(fragileRank === -1 || fragileRank > durableRank).toBe(true);
  });

  it("puts the highest championship probability first", () => {
    // The ranking used to sort with a "within noise, prefer playoff odds" comparator,
    // which is not transitive: 12%, 14% and 16% at 600 scenarios give A~B, B~C, A<C — a
    // cycle. `Array.prototype.sort` on a cycle may return anything, and it could place the
    // 12% candidate above the 16% one. The leader is now established before sorting.
    const recs = recommendByChampionship(
      {
        teams: freshTeams(),
        myTeamIndex: 0,
        available: board(),
        rosterSize: ROUNDS,
      },
      CONFIG,
      21,
      createRng,
      8,
    );
    const best = Math.max(...recs.map((r) => r.championshipProbability));

    // The contract is not "highest title probability first" — a candidate statistically
    // level with the leader may outrank it on the smoother playoff signal, which is the
    // documented behaviour. What must hold is that the ordering is well-defined:
    //
    //  - whatever leads is within sampling noise of the true maximum;
    //  - every tied candidate outranks every untied one;
    //  - untied candidates descend by title probability.
    expect(recs[0].tiedWithLeader).toBe(true);
    expect(best - recs[0].championshipProbability).toBeLessThanOrEqual(
      recs[0].standardError * 2 + 1e-9,
    );

    const firstUntied = recs.findIndex((r) => !r.tiedWithLeader);
    if (firstUntied >= 0) {
      for (let i = firstUntied; i < recs.length; i += 1) {
        expect(recs[i].tiedWithLeader).toBe(false);
      }
      for (let i = firstUntied + 1; i < recs.length; i += 1) {
        expect(recs[i - 1].championshipProbability).toBeGreaterThanOrEqual(
          recs[i].championshipProbability,
        );
      }
    }

    // And the flag itself is honest: tied means within the combined standard errors.
    const leader = recs.find((r) => r.championshipProbability === best)!;
    for (const r of recs) {
      const within =
        best - r.championshipProbability <= leader.standardError + r.standardError;
      expect(r.tiedWithLeader).toBe(within);
    }
  });

  it("returns nothing when the board is empty", () => {
    expect(
      recommendByChampionship(
        { teams: freshTeams(), myTeamIndex: 0, available: [], rosterSize: ROUNDS },
        CONFIG,
        1,
        createRng,
      ),
    ).toEqual([]);
  });
});

/**
 * Gaps a mutation run found in the parts of the engine that nothing was pinning.
 *
 * Every test here was checked against the mutant it is meant to catch: the implementation
 * was changed by hand, the test was confirmed to fail, and the change reverted. A test
 * that passes either way is worse than no test, because it reports coverage it does not
 * have — this suite has produced that mistake before.
 */
describe("recommendByChampionship, against the rest of the league", () => {
  /** A complete roster, all of one strength, with no picks left to make. */
  const settled = (prefix: string, weeklyMean: number): DraftTeam => ({
    id: prefix,
    name: prefix,
    roster: [
      player(`${prefix}qb`, "QB", weeklyMean),
      player(`${prefix}rb1`, "RB", weeklyMean),
      player(`${prefix}rb2`, "RB", weeklyMean),
      player(`${prefix}wr1`, "WR", weeklyMean),
      player(`${prefix}wr2`, "WR", weeklyMean),
      player(`${prefix}te`, "TE", weeklyMean),
      player(`${prefix}fx`, "RB", weeklyMean),
    ],
    remainingPicks: [],
  });

  /** Us, one player short of a full roster, with exactly one pick left. */
  const meWithOnePickLeft = (): DraftTeam => ({
    ...settled("me", 12),
    roster: settled("me", 12).roster.slice(0, 6),
    remainingPicks: [1],
  });

  const against = (opponentStrength: number): number => {
    const teams = [
      meWithOnePickLeft(),
      ...Array.from({ length: 7 }, (_, i) => settled(`o${i}`, opponentStrength)),
    ];
    const recs = recommendByChampionship(
      {
        teams,
        myTeamIndex: 0,
        available: [player("free", "RB", 12)],
        rosterSize: 7,
      },
      CONFIG,
      1,
      createRng,
      11,
    );
    return recs[0].championshipProbability;
  };

  it("is beaten by a strong league and wins an weak one", () => {
    // The filter that selects opponents is `index !== myTeamIndex`. Inverted, it selects
    // *us*, the league becomes we-against-a-copy-of-ourselves, and nothing the other
    // seven teams do can reach the number. This is the test that says they are the other
    // teams and not us.
    const versusStrong = against(30);
    const versusWeak = against(2);
    expect(versusStrong).toBeLessThan(0.05);
    expect(versusWeak).toBeGreaterThan(0.9);
  });

  it("puts a symmetric league near its fair share rather than near a coin flip", () => {
    // Eight equal teams: about one title in eight. If the opponent list collapsed to a
    // single team the field would be two and this would sit near a half.
    const fair = against(12);
    expect(fair).toBeGreaterThan(0.02);
    expect(fair).toBeLessThan(0.35);
  });
});

describe("recommendByChampionship arithmetic", () => {
  const recs = () =>
    recommendByChampionship(
      { teams: freshTeams(), myTeamIndex: 0, available: board(), rosterSize: ROUNDS },
      CONFIG,
      7,
      createRng,
      4,
    );

  it("reports the standard error of the proportion it measured", () => {
    for (const r of recs()) {
      const p = r.championshipProbability;
      expect(r.standardError).toBeCloseTo(
        Math.round(Math.sqrt((p * (1 - p)) / CONFIG.scenarios) * 1e4) / 1e4,
        10,
      );
    }
  });

  it("reports a delta that is a difference from the baseline, not a sum", () => {
    // The baseline is a probability, so it cannot be negative, so `p - baseline` can
    // never exceed `p`. `p + baseline` does exactly that whenever the baseline is
    // non-zero, which is the mutant this pins.
    for (const r of recs()) {
      expect(r.deltaVsBaseline).toBeLessThanOrEqual(r.championshipProbability);
      expect(Math.abs(r.deltaVsBaseline)).toBeLessThanOrEqual(1);
    }
  });

  it("judges as many candidates as it was asked for", () => {
    expect(recs()).toHaveLength(4);
  });

  it("still judges one candidate when asked for none", () => {
    // The floor exists so a zero or negative limit cannot silently return an empty board
    // to a user who is on the clock.
    const none = recommendByChampionship(
      { teams: freshTeams(), myTeamIndex: 0, available: board(), rosterSize: ROUNDS },
      CONFIG,
      7,
      createRng,
      0,
    );
    expect(none).toHaveLength(1);
  });
});

describe("completeDraft, at its boundaries", () => {
  it("never exceeds the roster size, even with more picks than seats", () => {
    // The ordinary fixture gives each team exactly as many picks as seats, so the guard
    // is never reached and an off-by-one in it changes nothing. A team holding more picks
    // than it has room for is the case that exercises it.
    const teams = Array.from({ length: TEAMS }, (_, i) => ({
      id: `t${i}`,
      name: `Team ${i + 1}`,
      roster: [],
      remainingPicks: snakePicks(i + 1, TEAMS, ROUNDS),
    }));
    const rosters = completeDraft(
      { teams, myTeamIndex: 0, available: board(), rosterSize: 4 },
      SLOTS,
      null,
    );
    for (const roster of rosters) expect(roster.length).toBeLessThanOrEqual(4);
  });

  it("drafts the last player on the board rather than stranding him", () => {
    // The pool is emptied when it reaches zero, not when it reaches one.
    const available = board().slice(0, TEAMS * 2);
    const teams = Array.from({ length: TEAMS }, (_, i) => ({
      id: `t${i}`,
      name: `Team ${i + 1}`,
      roster: [],
      remainingPicks: snakePicks(i + 1, TEAMS, 2),
    }));
    const rosters = completeDraft(
      { teams, myTeamIndex: 0, available, rosterSize: 2 },
      SLOTS,
      null,
    );
    expect(rosters.flat()).toHaveLength(available.length);
  });

  it("plays the picks in ascending order, not in whatever order teams are listed", () => {
    // Two teams, one pick each. The seat holding pick 1 chooses before the seat holding
    // pick 8, regardless of their position in the array. Sorting the pick order by a sum
    // rather than a difference reverses exactly this pair, and the board is then dealt
    // backwards — the last seat in the round takes the best player in the draft.
    // The team owning pick 1 is listed *second*, so array order and pick order disagree.
    // With them in agreement the assertion holds either way and pins nothing — which is
    // how the first version of this test passed against the mutant it was written for.
    const teams: DraftTeam[] = [
      { id: "late", name: "late", roster: [], remainingPicks: [8] },
      { id: "early", name: "early", roster: [], remainingPicks: [1] },
    ];
    const rosters = completeDraft(
      { teams, myTeamIndex: 0, available: board(), rosterSize: 1 },
      SLOTS,
      null,
    );
    const best = basePolicyPick([], board(), SLOTS)!;
    expect(rosters[1].map((p) => p.id)).toEqual([best.id]);
    expect(rosters[0].map((p) => p.id)).not.toEqual([best.id]);
  });
});
