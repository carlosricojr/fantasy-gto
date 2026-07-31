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
