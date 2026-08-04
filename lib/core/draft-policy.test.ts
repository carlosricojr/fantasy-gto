import { describe, expect, it } from "vitest";

import { buildSlots } from "../nfl/roster";
import {
  CHAMPIONSHIP_CANDIDATES,
  type ChampionshipRecommendation,
  type DraftPolicyState,
  type DraftTeam,
  basePolicyPick,
  completeDraft,
  completeOwnRoster,
  orderRecommendations,
  recommendByChampionship,
} from "./draft-policy";
import { snakePicks } from "./draft";
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
    const first = recommendByChampionship(s, CONFIG, 3, 4);
    const second = recommendByChampionship(s, CONFIG, 3, 4);
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
      5,
    );
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) expect(r.standardError).toBeGreaterThan(0);
    // Checked against the condition, not against the ordering. `recs[0]` is the leader,
    // whose difference from itself is zero, so it is flagged tied whenever the standard
    // error is positive — which the line above already asserts. Testing that told us
    // nothing and would have survived a mutant that set the flag unconditionally.
    const best = Math.max(...recs.map((r) => r.championshipProbability));
    const leader = recs.find((r) => r.championshipProbability === best)!;
    for (const r of recs) {
      expect(r.tiedWithLeader).toBe(
        best - r.championshipProbability <= leader.standardError + r.standardError,
      );
    }
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
    // Against the implementation's own bound — the leader's standard error plus the
    // entry's — not twice the first entry's. Those differ: `standardError` is
    // sqrt(p(1-p)/n), so below a half the leader carries the larger one, and an entry the
    // implementation correctly calls tied can exceed twice its own. That the doubled form
    // passed was a fact about seed 21.
    const top = recs.find((r) => r.championshipProbability === best)!;
    expect(recs[0].tiedWithLeader).toBe(true);
    expect(best - recs[0].championshipProbability).toBeLessThanOrEqual(
      top.standardError + recs[0].standardError + 1e-9,
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
      11,
    );
    return recs[0].championshipProbability;
  };

  it("is beaten by a strong league and wins a weak one", () => {
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
      4,
    );

  it("reports the standard error of the proportion it measured", () => {
    for (const r of recs()) {
      const p = r.championshipProbability;
      // Compared at the precision the implementation reports, not at 10 digits. The
      // standard error is derived from the *unrounded* probability and then rounded, while
      // `p` here is already rounded — they differ by up to 5e-5, so a recomputation from
      // `p` lands on a different 1e-4 grid point whenever it sits near a boundary, and the
      // test would fail for a seed that changed nothing.
      // 3 digits, not 4. The implementation derives this from the unrounded probability
      // and reports it on a 1e-4 grid, so a recomputation from the rounded `p` can land a
      // whole grid step away — 4 digits is exactly at that boundary and would fail on a
      // seed change that altered nothing.
      expect(r.standardError).toBeCloseTo(
        Math.sqrt((p * (1 - p)) / CONFIG.scenarios),
        3,
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

describe("recommendByChampionship against opponents who wanted the same player", () => {
  it("does not play a candidate on our roster and an opponent's at once", () => {
    // The shortlist comes from `state.available`, and the baseline completion may already
    // have handed one of those players to an opponent. Scored against the untouched
    // baseline, taking him added his points to us without removing them from them — so he
    // scored twice, and the candidates opponents wanted were exactly the ones inflated.
    //
    // One overwhelming player on a thin board: every opponent wants him, so he is certain
    // to appear on a completed opponent roster. Double-counted, taking him barely moves
    // our odds, because the opponent who "still has him" cancels the gain.
    const star = player("STAR", "RB", 60);
    const filler = Array.from({ length: TEAMS * ROUNDS }, (_, i) =>
      player(`f${i}`, i % 2 === 0 ? "WR" : "RB", 6),
    );
    // We sit in the last seat, so an opponent holds pick 1 and takes the star in the
    // baseline completion. At seat 1 we would take him ourselves and forcing him would
    // change nothing — which is correct, and tests nothing.
    const teams: DraftTeam[] = Array.from({ length: TEAMS }, (_, i) => ({
      id: `t${i}`,
      name: `Team ${i}`,
      roster: [],
      remainingPicks: snakePicks(i === 0 ? TEAMS : i, TEAMS, ROUNDS),
    }));
    const recs = recommendByChampionship(
      {
        teams,
        myTeamIndex: 0,
        available: [star, ...filler],
        rosterSize: ROUNDS,
      },
      CONFIG,
      13,
      3,
    );
    const forStar = recs.find((r) => r.player.id === "STAR");
    expect(forStar).toBeDefined();
    // Taking the one dominant player on the board must make us clear favourites in an
    // eight-team league. Double-counted he is still on the opponent who took him, so we
    // gain him without their losing him and the odds land near a coin flip instead:
    // measured, 0.76 against 0.49 at this seed. "Better than zero" does not separate
    // those, which is why the first version of this test passed against the bug.
    expect(forStar!.championshipProbability).toBeGreaterThan(0.6);
    expect(forStar!.deltaVsBaseline).toBeGreaterThan(0.02);
  });
});

describe("completeOwnRoster", () => {
  it("stops at the roster size, not at the picks it holds", () => {
    // `completeDraft` bounds every opponent by `rosterSize`; this bounds us the same way.
    // Given more picks than seats it would otherwise build a longer roster than anyone we
    // play, and a team with an extra starter wins more titles — every candidate's odds
    // rise together, which reads as a better board rather than as a bug.
    const filled = completeOwnRoster([], 12, board(), SLOTS, null, 5);
    expect(filled).toHaveLength(5);
  });

  it("still fills only as many picks as it holds when that is the tighter bound", () => {
    expect(completeOwnRoster([], 3, board(), SLOTS, null, 10)).toHaveLength(3);
  });

  it("counts the forced pick against both bounds", () => {
    const forced = board()[0];
    const filled = completeOwnRoster([], 9, board(), SLOTS, forced, 4);
    expect(filled).toHaveLength(4);
    expect(filled.map((p) => p.id)).toContain(forced.id);
  });

  it("refuses to seat a forced pick that neither bound has room for", () => {
    // The loop stops at both bounds; the forced pick used to bypass the loop entirely, so
    // a full roster came back one longer than every opponent and a team with no picks
    // left still drafted. Both make our simulated team bigger than the ones it plays.
    const forced = board()[0];
    const full = board().slice(1, 5);
    expect(completeOwnRoster(full, 3, board(), SLOTS, forced, 4)).toHaveLength(4);
    expect(completeOwnRoster([], 0, board(), SLOTS, forced, 10)).toHaveLength(0);
  });
});

describe("recommendByChampionship input validation", () => {
  it("rejects a team index that is not in the league", () => {
    // The state crosses a `postMessage` boundary, where no local type survives. Without
    // this the failure is a TypeError from inside the simulation rather than at the caller
    // that built the state.
    for (const myTeamIndex of [-1, TEAMS, TEAMS + 3, 1.5, Number.NaN]) {
      expect(() =>
        recommendByChampionship(
          { teams: freshTeams(), myTeamIndex, available: board(), rosterSize: ROUNDS },
          CONFIG,
          7,
          2,
        ),
      ).toThrow(/not one of the/);
    }
  });
});

/**
 * The base policy, which the improvement guarantee is stated relative to.
 *
 * `completeDraft` plays it out for every team at every remaining pick, so an error here is
 * not one bad pick — it is the league the objective is measured against. A mutation run
 * found the contender window, the availability weighting and the depth tiebreak all
 * unpinned, and none of them fails loudly: they just make the simulated league wrong.
 */
describe("basePolicyPick", () => {
  it("never lets the prefilter exclude the best player on the board", () => {
    // Narrowing the field is a cost optimisation, so its whole contract is that it changes
    // nothing. Dropping the highest-projected player skips him at every pick — and because
    // he stays the best, he is skipped for ever.
    const dominant = player("STAR", "RB", 60);
    const pool = [...board(), dominant];
    expect(basePolicyPick([], pool, SLOTS)?.id).toBe("STAR");
  });

  it("takes the player who fills an empty slot over deep bench at a full one", () => {
    // The prefilter used to be the top forty by `weeklyMean * availability`, which is the
    // quantity the marginal-value objective exists to correct — so a player worth having
    // for his position rather than his projection fell out of the window and was never
    // considered. Here every slot but quarterback is filled and the only quarterback on the
    // board is sixty-first by raw projection.
    //
    // This is not a near miss. Under the window the completion below spent all three
    // remaining picks on bench backs and started the season with an empty quarterback slot,
    // in the rollout that every recommendation in this module is measured against.
    const roster = [
      player("rbA", "RB", 18),
      player("rbB", "RB", 17),
      player("wrA", "WR", 16),
      player("wrB", "WR", 15),
      player("teA", "TE", 14),
      player("flx", "RB", 13),
    ];
    const depth = Array.from({ length: 60 }, (_, i) => player(`rb${i}`, "RB", 12 - i * 0.1));
    const pool = [...depth, player("theQB", "QB", 5)];

    expect(basePolicyPick(roster, pool, SLOTS)?.id).toBe("theQB");
    const completed = completeOwnRoster(roster, 3, pool, SLOTS, null, 9);
    expect(completed.map((p) => p.id)).toContain("theQB");
  });

  it("gives the same answer with the prefilter as without it", () => {
    // The invariant that makes the optimisation safe, and the one the window did not have.
    // Asserted for an empty, a partial and a full roster, because the lineup baseline
    // changes which player wins.
    //
    // `narrowed` is the prefilter's own rule — best available at each position — so this
    // says the dominance argument holds for the boards below rather than restating it.
    const pool = board();
    const bestAt = new Map<string, PlayerRisk>();
    for (const p of pool) {
      const held = bestAt.get(p.position);
      if (held === undefined || p.weeklyMean * p.availability > held.weeklyMean * held.availability) {
        bestAt.set(p.position, p);
      }
    }
    const narrowed = pool.filter((p) => bestAt.get(p.position) === p);

    const rosters: PlayerRisk[][] = [
      [],
      [player("r1", "RB", 15), player("r2", "WR", 14)],
      [
        player("r1", "QB", 20),
        player("r2", "RB", 15),
        player("r3", "RB", 14),
        player("r4", "WR", 13),
        player("r5", "WR", 12),
        player("r6", "TE", 10),
      ],
    ];
    for (const roster of rosters) {
      expect(basePolicyPick(roster, pool, SLOTS)?.id).toBe(
        basePolicyPick(roster, narrowed, SLOTS)?.id,
      );
    }
  });

  it("prefers the durable player when the points are equal", () => {
    // Availability multiplies the projection. Dividing by it instead inverts the
    // preference everywhere at once — prefilter, base policy and shortlist all start
    // favouring the injury-prone player.
    const full = [
      player("qb", "QB", 20),
      player("rb1", "RB", 15),
      player("rb2", "RB", 14),
      player("wr1", "WR", 13),
      player("wr2", "WR", 12),
      player("te", "TE", 10),
      player("fx", "RB", 11),
    ];
    const durable = player("durable", "WR", 6, { availability: 0.95 });
    const fragile = player("fragile", "WR", 6, { availability: 0.45 });
    // Both orders, so a tie broken by argument order cannot pass this.
    expect(basePolicyPick(full, [durable, fragile], SLOTS)?.id).toBe("durable");
    expect(basePolicyPick(full, [fragile, durable], SLOTS)?.id).toBe("durable");
  });

  it("takes the better bench player when neither can start", () => {
    // The depth tiebreak. With its sign flipped, the policy takes the *worst* player on
    // the board once the lineup is full — the opposite of what it is for.
    const full = [
      player("qb", "QB", 20),
      player("rb1", "RB", 15),
      player("rb2", "RB", 14),
      player("wr1", "WR", 13),
      player("wr2", "WR", 12),
      player("te", "TE", 10),
      player("fx", "RB", 11),
    ];
    const better = player("better", "TE", 8);
    const worse = player("worse", "TE", 2);
    expect(basePolicyPick(full, [better, worse], SLOTS)?.id).toBe("better");
    expect(basePolicyPick(full, [worse, better], SLOTS)?.id).toBe("better");
  });

  it("fills every starting slot across a run of picks", () => {
    // An invalid comparator in the window leaves the top of the board unordered, which
    // shows up as a roster that never fills its slots.
    let roster: PlayerRisk[] = [];
    let pool = board();
    for (let i = 0; i < SLOTS.length; i += 1) {
      const pick = basePolicyPick(roster, pool, SLOTS)!;
      expect(pick).not.toBeNull();
      roster = [...roster, pick];
      pool = pool.filter((p) => p.id !== pick.id);
    }
    for (const slot of SLOTS) {
      expect(roster.some((p) => slot.eligiblePositions.includes(p.position))).toBe(true);
    }
  });
});

describe("the shortlist is the top of the board", () => {
  it("simulates the highest-value candidates, not an arbitrary four", () => {
    // The shortlist comparator sorts by marginal starting value. Turned into a sum it is
    // positive for every pair, so `sort` leaves the board in its original order and the
    // four players simulated are simply the first four.
    const recs = recommendByChampionship(
      { teams: freshTeams(), myTeamIndex: 0, available: board(), rosterSize: ROUNDS },
      CONFIG,
      9,
      4,
    );
    // On an empty roster every position is open, so the best of each is what a lineup
    // gains most from.
    expect(recs.map((r) => r.player.id).sort()).toEqual(["QB0", "RB0", "TE0", "WR0"]);
  });
});

describe("a forced pick is honoured when only one remains", () => {
  it("seats the candidate on the last pick of the draft", () => {
    // `picksLeft > 1` drops the forced candidate exactly when one pick is left, so every
    // candidate is scored as the roster the base policy would have built anyway — and all
    // of them come back identical.
    // Forced to a player the base policy would never choose, so "it was seated" and "the
    // policy happened to pick him" cannot be confused. The first player on the board is
    // exactly what the policy takes anyway, which is how the first version of this passed.
    const unwanted = board()[board().length - 1];
    expect(basePolicyPick([], board(), SLOTS)?.id).not.toBe(unwanted.id);
    expect(
      completeOwnRoster([], 1, board(), SLOTS, unwanted, 10).map((p) => p.id),
    ).toEqual([unwanted.id]);

    const teams = freshTeams().map((t) => ({ ...t, remainingPicks: t.remainingPicks.slice(-1) }));
    const recs = recommendByChampionship(
      { teams, myTeamIndex: 0, available: board(), rosterSize: 1 },
      CONFIG,
      17,
      3,
    );
    const probabilities = recs.map((r) => r.championshipProbability);
    expect(new Set(probabilities).size).toBeGreaterThan(1);
  });
});

/**
 * The opponent who loses the player we take.
 *
 * When a candidate is already on an opponent's simulated roster, that opponent has to be
 * re-completed without him — otherwise he is played on two teams at once. Getting that
 * wrong is silent in every direction: the wrong opponent is repaired, the right one is
 * gutted, the replacement is handed to both of us, or the whole thing throws only when the
 * board happens to be exhausted.
 *
 * Every assertion here is on an absolute probability, because the failure mode is a number
 * that is plausible but wrong — comparing two runs of the same code cannot see it.
 */
describe("re-completing the opponent who held the candidate", () => {
  /** One dominant player on a thin board, with us drafting last so an opponent takes him. */
  const starFixture = () => {
    const star = player("STAR", "RB", 60);
    const filler = Array.from({ length: TEAMS * ROUNDS }, (_, i) =>
      player(`f${i}`, i % 2 === 0 ? "WR" : "RB", 6),
    );
    return { star, available: [star, ...filler] };
  };

  /**
   * Seats every team exactly once, with `ownerIndex` on the clock first and us last.
   *
   * The first version of this assigned `i === ownerIndex ? 1 : i` and handed seat 1 to two
   * different teams — so team 1 always took the first pick regardless, the holder was
   * always the first opponent, and a mutant that finds the *wrong* opponent produced
   * identical output. I recorded that as an unclosable gap. It was a broken fixture.
   */
  const seatedSoThat = (ownerIndex: number): DraftTeam[] => {
    const seat = (i: number) =>
      i === 0 ? TEAMS : i === ownerIndex ? 1 : i === 1 ? ownerIndex : i;
    const seats = Array.from({ length: TEAMS }, (_, i) => seat(i));
    // A collision here silently changes which team is on the clock, which is the whole
    // variable these tests turn on.
    expect(new Set(seats).size).toBe(TEAMS);
    return Array.from({ length: TEAMS }, (_, i) => ({
      id: `t${i}`,
      name: `Team ${i}`,
      roster: [],
      remainingPicks: snakePicks(seats[i], TEAMS, ROUNDS),
    }));
  };

  it("repairs the opponent who actually holds him, wherever he is seated", () => {
    // The owner search matches on identity. Inverted, it matches the first opponent holding
    // any *other* player — index 0 in every ordinary state — so the real holder keeps the
    // star and we play him too.
    //
    // Seating the holder at index 4 rather than 1 is what makes "the right opponent" and
    // "the first opponent" different. Measured at seed 13: 0.7533 correct, 0.4267 with the
    // search inverted, so 0.6 separates them with room on both sides.
    const { available } = starFixture();
    const recs = recommendByChampionship(
      { teams: seatedSoThat(4), myTeamIndex: 0, available, rosterSize: ROUNDS },
      CONFIG,
      13,
      3,
    );
    expect(recs.find((r) => r.player.id === "STAR")!.championshipProbability)
      .toBeGreaterThan(0.6);
  });

  it("leaves the rest of that opponent's roster intact", () => {
    // The opponent who loses the candidate keeps everyone else. Filtering *to* him instead
    // of *away from* him gives that opponent a one-man roster while he also keeps the
    // star — both errors at once, and the result is merely a lower number rather than an
    // obviously broken one.
    //
    // The threshold is measured, not guessed: this fixture returns 0.7667 at seed 13 and
    // 0.6533 with the filter inverted. 0.70 sits between them with room on both sides.
    const { available } = starFixture();
    const recs = recommendByChampionship(
      { teams: seatedSoThat(1), myTeamIndex: 0, available, rosterSize: ROUNDS },
      CONFIG,
      13,
      3,
    );
    expect(recs.find((r) => r.player.id === "STAR")!.championshipProbability)
      .toBeGreaterThan(0.7);
  });

  it("survives a board with nothing left to replace him with", () => {
    // Exactly as many players as the opponents have picks, so `poolForUs` empties and
    // `basePolicyPick` returns null. Appending the replacement unconditionally pushes a
    // null onto a roster and the run dies inside a Monte Carlo loop instead of returning.
    const star = player("STAR", "RB", 40);
    const scarce = [star, ...Array.from({ length: 6 }, (_, i) => player(`s${i}`, "WR", 5))];
    const teams: DraftTeam[] = Array.from({ length: TEAMS }, (_, i) => ({
      id: `t${i}`,
      name: `Team ${i}`,
      roster: [],
      remainingPicks: i === 0 ? [TEAMS] : [i],
    }));
    const recs = recommendByChampionship(
      { teams, myTeamIndex: 0, available: scarce, rosterSize: 1 },
      CONFIG,
      5,
      2,
    );
    expect(recs.length).toBeGreaterThan(0);
  });

  it("does not let us draft the replacement it just gave the opponent", () => {
    // The pool filter is the only thing stopping the replacement from being drafted twice.
    // The star fixture cannot see it, because there the replacement is interchangeable
    // junk and taking it costs nothing — 0.7667 against 0.76, one scenario in 150.
    //
    // Here the replacement is decisive: we hold six starters and no tight end, so TEGOOD
    // is the only player on the board who fills a hole in our lineup. Forcing STAR hands
    // him to the opponent, and drafting him ourselves as well is worth a great deal.
    // Measured at seed 13 on this fixture: 0.2133 correct, 0.4267 with the filter
    // neutered, and 2082.97 expected points against 2471.95. The threshold sits between
    // those, and is asserted on both quantities.
    //
    // I recorded this mutant as unclosable twice, then wrote this fixture with a bound of
    // 0.5 that both sides satisfy — a third pass at the same mistake. Measure the
    // separation, then choose the threshold; never the other way round.
    const star = player("STAR", "RB", 60);
    const teGood = player("TEGOOD", "TE", 30);
    const junk = Array.from({ length: 12 }, (_, i) => player(`j${i}`, "WR", 1));

    const settled = (prefix: string): DraftTeam => ({
      id: prefix,
      name: prefix,
      roster: [
        player(`${prefix}qb`, "QB", 20),
        player(`${prefix}rb1`, "RB", 20),
        player(`${prefix}rb2`, "RB", 20),
        player(`${prefix}wr1`, "WR", 20),
        player(`${prefix}wr2`, "WR", 20),
        player(`${prefix}te`, "TE", 20),
        player(`${prefix}fx`, "RB", 20),
      ],
      remainingPicks: [],
    });

    const teams: DraftTeam[] = [
      {
        id: "me",
        name: "me",
        // Six starters and no tight end, with two picks left.
        roster: [
          player("mqb", "QB", 18),
          player("mrb1", "RB", 18),
          player("mrb2", "RB", 18),
          player("mwr1", "WR", 18),
          player("mwr2", "WR", 18),
          player("mfx", "RB", 18),
        ],
        remainingPicks: [2, 3],
      },
      { ...settled("o0"), remainingPicks: [1] },
      ...Array.from({ length: 6 }, (_, i) => settled(`o${i + 1}`)),
    ];

    const recs = recommendByChampionship(
      { teams, myTeamIndex: 0, available: [star, teGood, ...junk], rosterSize: 8 },
      CONFIG,
      13,
      3,
    );
    const forStar = recs.find((r) => r.player.id === "STAR")!;
    expect(forStar).toBeDefined();
    expect(forStar.championshipProbability).toBeLessThan(0.3);
    expect(forStar.expectedPoints).toBeLessThan(2200);
  });

  // Every mutant in this branch is now covered. The note that used to stand here recorded
  // two of them as unclosable; both claims were wrong, one because of a seat collision in
  // the fixture and one because the replacement was interchangeable. Neither was a
  // property of the code.
});

/**
 * The order the ranking comes back in.
 *
 * `recs[0]` is the headline "Take X" on the draft screen, so the comparator producing it
 * is as user-visible as any number in the product. Four mutants lived in it: dropping the
 * playoff tie-break, dropping expected points, inverting the tied/untied grouping, and
 * turning a difference into a sum so the comparator is inconsistent and the order becomes
 * whatever the engine's sort happens to do.
 *
 * All four are caught by asserting the documented contract across the whole ranking rather
 * than checking one fixture's leader — a leader can come out right by luck.
 */
describe("the ranking follows its documented order", () => {
  const riskyBoard = () =>
    board().map((p, i) => ({ ...p, availability: 0.32 + ((i * 37) % 68) / 100 }));

  const rankingOn = (available: PlayerRisk[], seed: number, limit: number) =>
    recommendByChampionship(
      { teams: freshTeams(), myTeamIndex: 0, available, rosterSize: ROUNDS },
      CONFIG,
      seed,
      limit,
    );

  // Computed once and shared. Each of these is a full championship simulation per
  // candidate, so recomputing them per test pushed the file past its budget.
  const rankings = [rankingOn(riskyBoard(), 7, 5), rankingOn(board(), 21, 5)];

  it("puts every tied candidate above every untied one", () => {
    for (const recs of rankings) {
      const firstUntied = recs.findIndex((r) => !r.tiedWithLeader);
      if (firstUntied === -1) continue;
      for (let i = firstUntied; i < recs.length; i += 1) {
        expect(recs[i].tiedWithLeader).toBe(false);
      }
    }
  });

  it("orders the tied group by playoff odds, then points, then id", () => {
    for (const recs of rankings) {
      const tied = recs.filter((r) => r.tiedWithLeader);
      expect(tied.length).toBeGreaterThan(1);
      for (let i = 1; i < tied.length; i += 1) {
        const a = tied[i - 1];
        const b = tied[i];
        expect(a.playoffProbability).toBeGreaterThanOrEqual(b.playoffProbability);
        if (a.playoffProbability === b.playoffProbability) {
          expect(a.expectedPoints).toBeGreaterThanOrEqual(b.expectedPoints);
          if (a.expectedPoints === b.expectedPoints) {
            expect(a.player.id < b.player.id).toBe(true);
          }
        }
      }
    }
  });

  it("returns a completely tied field in id order, not input order", () => {
    // Three candidates who can never score: every probability and total is identical, so
    // only the final id tiebreak decides. Listed id-descending, so input order disagrees.
    const full = [
      player("s1", "QB", 20),
      player("s2", "RB", 15),
      player("s3", "RB", 14),
      player("s4", "WR", 13),
      player("s5", "WR", 12),
      player("s6", "TE", 10),
      player("s7", "RB", 11),
    ];
    const teams = freshTeams().map((t, i) =>
      i === 0 ? { ...t, roster: full, remainingPicks: [1] } : t,
    );
    const recs = recommendByChampionship(
      {
        teams,
        myTeamIndex: 0,
        available: [player("cc", "TE", 0), player("bb", "TE", 0), player("aa", "TE", 0)],
        rosterSize: 8,
      },
      CONFIG,
      4,
      3,
    );
    expect(recs.map((r) => r.player.id)).toEqual(["aa", "bb", "cc"]);
  });
});

describe("the base policy's tie-break", () => {
  it("takes the first of the tied maxima, not the last", () => {
    // On an empty roster QB0, RB0, WR0 and TE0 add exactly the same lineup value, so this
    // is purely about which tied maximum wins. Ties are the normal case on a real board,
    // so flipping `>` to `>=` changes essentially every pick in every completion.
    expect(basePolicyPick([], board(), SLOTS)?.id).toBe("QB0");
  });

  it("weights a projection by availability, not against it", () => {
    // Every player on the standard board shares one availability, which makes `mean *
    // avail` and `mean / avail` order-identically — so the window comparator could invert
    // the weighting entirely and nothing noticed. This board has a real spread.
    const risky = board().map((p, i) => ({
      ...p,
      availability: 0.32 + ((i * 37) % 68) / 100,
    }));
    expect(basePolicyPick([], risky, SLOTS)?.id).toBe("TE1");
  });
});

/**
 * The ordering rule, on its own.
 *
 * Reaching these branches through `recommendByChampionship` means finding a roster and a
 * seed whose simulated title odds happen to land in the arrangement under test. The
 * fixtures above do that for the common cases and cannot do it for the rest — a mutation
 * run left the whole final comparator standing, because the boards it was run against
 * never produced two candidates that were both outside the noise band and disagreed about
 * which was better.
 */
describe("orderRecommendations", () => {
  const rec = (
    id: string,
    championshipProbability: number,
    standardError: number,
    playoffProbability = 0.5,
    expectedPoints = 100,
  ): ChampionshipRecommendation => ({
    player: player(id, "RB", 10),
    championshipProbability,
    deltaVsBaseline: 0,
    playoffProbability,
    expectedPoints,
    standardError,
    tiedWithLeader: false,
  });

  it("returns an empty board unchanged", () => {
    expect(orderRecommendations([])).toEqual([]);
  });

  it("flags a lone candidate as tied with the leader, because it is the leader", () => {
    // The early return is for the empty case. Moved by one it also catches a
    // single-candidate board, which then reports `tiedWithLeader: false` — a candidate
    // presented as measurably worse than itself.
    const [only] = orderRecommendations([rec("solo", 0.2, 0.01)]);
    expect(only.tiedWithLeader).toBe(true);
  });

  it("orders two candidates outside the noise band by title odds, not by playoff odds", () => {
    // The branch that decides the untied group. `a || b` becoming `a && b` reads as
    // "whenever the title odds differ, ignore them and use the smoother signal", which is
    // the exact inverse of the rule; a sum in place of the difference is positive for every
    // pair and makes the comparator inconsistent.
    //
    // Three candidates, because two is not enough: the leader is always tied with itself,
    // so a board of two never has two untied entries to compare. Playoff odds are set
    // against title odds so the two rules disagree.
    // Given with the two untied candidates the wrong way round. A comparator that returns
    // a positive number for every pair — which a sum in place of the difference does —
    // never moves anything left, so an input that already reads correctly would pass.
    const ordered = orderRecommendations([
      rec("leader", 0.5, 0.001, 0.99, 300),
      rec("worse", 0.1, 0.001, 0.9, 200),
      rec("better", 0.3, 0.001, 0.1, 100),
    ]);
    expect(ordered.map((r) => r.player.id)).toEqual(["leader", "better", "worse"]);
    expect(ordered.map((r) => r.tiedWithLeader)).toEqual([true, false, false]);
  });

  it("puts the tied group above the untied one whatever order they arrive in", () => {
    // Given in the wrong order on purpose. A comparator that returns zero for a
    // tied-versus-untied pair leaves a stable sort exactly as it found it, so a fixture
    // that was already in the right order would pass against it.
    const ordered = orderRecommendations([
      rec("untied", 0.1, 0.001),
      rec("tied", 0.5, 0.001),
    ]);
    expect(ordered.map((r) => r.player.id)).toEqual(["tied", "untied"]);
  });

  it("counts a candidate exactly on the edge of the band as tied", () => {
    // `<=`, not `<`. The values are powers of two so the comparison is exact rather than
    // nearly exact: the gap is 0.5 − 0.25 = 0.25 and the two standard errors sum to
    // exactly the same 0.25. Every other fixture here sits clear of the edge, which is why
    // nothing noticed the boundary could move.
    //
    // Which way it should fall is a judgement, and it is made in the candidate's favour:
    // the flag says "this may not be distinguishable from the leader", so the doubtful
    // case belongs inside it.
    const ordered = orderRecommendations([
      rec("lead", 0.5, 0.125),
      rec("edge", 0.25, 0.125),
    ]);
    expect(ordered.map((r) => r.tiedWithLeader)).toEqual([true, true]);
  });

  it("orders the tied group by playoff odds, then points, then id", () => {
    // All three within one standard error of the leader, so every one of them is tied and
    // the title odds are not consulted at all.
    const ordered = orderRecommendations([
      rec("c", 0.2, 0.5, 0.4, 100),
      rec("b", 0.2, 0.5, 0.6, 100),
      rec("a", 0.2, 0.5, 0.6, 120),
    ]);
    expect(ordered.map((r) => r.player.id)).toEqual(["a", "b", "c"]);
    expect(ordered.every((r) => r.tiedWithLeader)).toBe(true);
  });

  it("breaks a total tie by id, so the order does not depend on the input order", () => {
    const ordered = orderRecommendations([
      rec("zz", 0.2, 0.5),
      rec("aa", 0.2, 0.5),
      rec("mm", 0.2, 0.5),
    ]);
    expect(ordered.map((r) => r.player.id)).toEqual(["aa", "mm", "zz"]);
  });

  it("measures the noise band against the leader, not against the neighbour", () => {
    // The band is `leader − candidate <= leaderError + candidateError`. With errors of
    // 0.02 each it is 0.04 wide: 0.32 is inside it and 0.29 is not — but 0.29 *is* within
    // 0.04 of 0.32, so a band measured from the neighbour instead of the leader would call
    // it tied. That reading is the intransitive one the partition exists to avoid.
    //
    // The gaps are 0.02 and 0.05 rather than anything landing on 0.04, because these are
    // binary floats: `0.34 - 0.3` is 0.040000000000000036, which is not `<= 0.04`. A
    // fixture sitting on the boundary would be testing the representation.
    const ordered = orderRecommendations([
      rec("lead", 0.34, 0.02),
      rec("inside", 0.32, 0.02),
      rec("outside", 0.29, 0.02),
    ]);
    expect(ordered.map((r) => r.tiedWithLeader)).toEqual([true, true, false]);
  });
});

describe("the depth tiebreak inside the prefilter", () => {
  it("prices a bench candidate below anyone who improves the lineup", () => {
    // `after - before + mean * availability * 1e-3`. The scale matters: at 1e-2 a bench
    // player projected at 20 is worth 0.18, which beats a starter who adds 0.15 to the
    // solved lineup — so the filter would rank depth above the starting eleven. At 1e-3 it
    // is worth 0.018 and cannot.
    const roster = [
      player("qb", "QB", 20),
      player("rb1", "RB", 19),
      player("rb2", "RB", 18),
      player("wr1", "WR", 17),
      player("wr2", "WR", 16),
      player("te1", "TE", 15),
      player("flex", "RB", 14.9),
    ];
    // `bench` cannot crack the lineup: every slot he is eligible for holds someone better.
    // `starter` beats the weakest flex by a tenth of a point, so he improves it barely.
    const bench = player("bench", "RB", 14.8);
    const starter = player("starter", "RB", 15.0);
    expect(basePolicyPick(roster, [bench, starter], SLOTS)?.id).toBe("starter");
  });

  it("separates bench candidates by projection when none of them can start", () => {
    // With the tiebreak removed every one of these scores exactly zero, the sort is stable,
    // and the shortlist is whatever arrived first — so the objective would never be shown
    // the best player available and the recommendation would be an artefact of board order.
    //
    // Asserted through the shortlist rather than through `basePolicyPick`, because the
    // prefilter there keeps one player per position and two bench backs never meet. The
    // shortlist ranks the whole board, which is where this term does its work.
    const roster = [
      player("qb", "QB", 20),
      player("rb1", "RB", 19),
      player("rb2", "RB", 18),
      player("wr1", "WR", 17),
      player("wr2", "WR", 16),
      player("te1", "TE", 15),
      player("flex", "RB", 14.9),
    ];
    const teams = freshTeams().map((t, i) =>
      i === 0 ? { ...t, roster, remainingPicks: [1] } : t,
    );
    // Every one of these is behind the flex, so none of them changes the solved lineup.
    // Listed weakest-first, so board order disagrees with projection order.
    const bench = Array.from({ length: 6 }, (_, i) => player(`b${i}`, "RB", 5 + i));
    const recs = recommendByChampionship(
      { teams, myTeamIndex: 0, available: bench, rosterSize: 8 },
      CONFIG,
      17,
      1,
    );
    expect(recs.map((r) => r.player.id)).toEqual(["b5"]);
  });
});

describe("a forced pick cannot overfill a roster", () => {
  const full = () => [
    player("f1", "QB", 20),
    player("f2", "RB", 19),
    player("f3", "RB", 18),
  ];

  it("refuses to seat one into a team already at its roster size", () => {
    // The forced branch skips the pick loop, so every bound the loop applies has to be
    // repeated here or it is not applied at all. Seated anyway, the team fields more
    // players than the teams it plays for the whole simulated season.
    const teams = freshTeams().map((t, i) =>
      i === 0 ? { ...t, roster: full(), remainingPicks: [] } : t,
    );
    const rosters = completeDraft(
      { teams, myTeamIndex: 0, available: board(), rosterSize: 3 },
      SLOTS,
      player("EXTRA", "WR", 30),
    );
    expect(rosters[0]).toHaveLength(3);
    expect(rosters[0].map((p) => p.id)).not.toContain("EXTRA");
  });

  it("still seats one when there is room, so the bound is not simply refusing", () => {
    // The other side of the same boundary. Without this the guard could reject everything
    // and the test above would still pass.
    const teams = freshTeams().map((t, i) =>
      i === 0 ? { ...t, roster: full(), remainingPicks: [] } : t,
    );
    const rosters = completeDraft(
      { teams, myTeamIndex: 0, available: board(), rosterSize: 4 },
      SLOTS,
      player("EXTRA", "WR", 30),
    );
    expect(rosters[0].map((p) => p.id)).toContain("EXTRA");
  });

  it("refuses to seat a player the team already holds", () => {
    const held = full();
    const teams = freshTeams().map((t, i) =>
      i === 0 ? { ...t, roster: held, remainingPicks: [] } : t,
    );
    const rosters = completeDraft(
      { teams, myTeamIndex: 0, available: board(), rosterSize: 6 },
      SLOTS,
      held[1],
    );
    expect(rosters[0].filter((p) => p.id === held[1].id)).toHaveLength(1);
  });
});

describe("the shortlist is exactly as long as it says", () => {
  it("returns the number of candidates it was asked for", () => {
    // `candidateLimit` is what keeps a recommendation inside a draft clock — every entry
    // is a full season simulation. Nothing pinned the count, so it could quietly evaluate
    // one more or one fewer than asked.
    const state: DraftPolicyState = {
      teams: freshTeams(),
      myTeamIndex: 0,
      available: board(),
      rosterSize: ROUNDS,
    };
    expect(recommendByChampionship(state, CONFIG, 3, 1)).toHaveLength(1);
    expect(recommendByChampionship(state, CONFIG, 3, 4)).toHaveLength(4);
  });

  it("evaluates at least one candidate however small the limit is", () => {
    // `Math.max(limit, 1)`: a zero or negative limit returns no recommendation at all,
    // which reads on screen as "there is nothing worth taking".
    const state: DraftPolicyState = {
      teams: freshTeams(),
      myTeamIndex: 0,
      available: board(),
      rosterSize: ROUNDS,
    };
    expect(recommendByChampionship(state, CONFIG, 3, 0)).toHaveLength(1);
    expect(recommendByChampionship(state, CONFIG, 3, -5)).toHaveLength(1);
  });

  it("cannot return more candidates than the board holds", () => {
    const teams = freshTeams();
    const state: DraftPolicyState = {
      teams,
      myTeamIndex: 0,
      available: [player("a", "RB", 10), player("b", "WR", 9)],
      rosterSize: ROUNDS,
    };
    expect(recommendByChampionship(state, CONFIG, 3, 8)).toHaveLength(2);
  });
});

describe("the prefilter's own boundaries", () => {
  it("keeps the first of two exactly tied players at a position", () => {
    // The prefilter takes one player per position, so which of several exact ties it keeps
    // is the pick. Evaluating the whole board would have kept the first; keeping the last
    // instead makes the answer depend on the order the board arrived in.
    expect(
      basePolicyPick([], [player("first", "RB", 10), player("second", "RB", 10)], SLOTS)
        ?.id,
    ).toBe("first");
  });

  it("scales the depth tiebreak so it cannot outweigh a real lineup gain", () => {
    // `mean * availability * 1e-3`. The multiplier has to be small enough that depth never
    // beats the starting eleven and large enough to separate two bench players, and only
    // the second half of that was pinned.
    //
    // This roster fills every slot. `starter` improves the flex by 0.05 of a point;
    // `bench` is a second quarterback who cannot start at all but is projected at 20. At
    // 1e-3 the tiebreak is worth 0.02 and `starter` wins on the 0.05 he adds. At 1e-2 it is
    // worth 0.2, and a player who cannot get on the field outranks one who improves it —
    // measured, not assumed: with the constant changed this fixture returns `bench`.
    const roster = [
      player("qb", "QB", 20, { availability: 1 }),
      player("rb1", "RB", 19, { availability: 1 }),
      player("rb2", "RB", 18, { availability: 1 }),
      player("wr1", "WR", 17, { availability: 1 }),
      player("wr2", "WR", 16, { availability: 1 }),
      player("te1", "TE", 15, { availability: 1 }),
      player("flx", "RB", 14.0, { availability: 1 }),
    ];
    const starter = player("starter", "RB", 14.05, { availability: 1 });
    const bench = player("bench", "QB", 20.0, { availability: 1 });
    expect(basePolicyPick(roster, [bench, starter], SLOTS)?.id).toBe("starter");
  });
});

const RECOMMENDATION: Omit<ChampionshipRecommendation, "player"> = {
  championshipProbability: 0.2,
  deltaVsBaseline: 0,
  playoffProbability: 0.5,
  expectedPoints: 100,
  standardError: 0.001,
  tiedWithLeader: false,
};

describe("orderRecommendations leaves its argument alone", () => {
  it("does not sort or flag the list it was given", () => {
    // It is exported, so a caller can hold its own reference. It used to write
    // `tiedWithLeader` onto the caller's objects and sort the caller's array in place.
    const given = [
      { ...RECOMMENDATION, player: player("low", "RB", 1), championshipProbability: 0.1 },
      { ...RECOMMENDATION, player: player("high", "RB", 1), championshipProbability: 0.5 },
    ];
    const before = given.map((r) => `${r.player.id}:${String(r.tiedWithLeader)}`);
    const ordered = orderRecommendations(given);

    expect(ordered.map((r) => r.player.id)).toEqual(["high", "low"]);
    expect(given.map((r) => `${r.player.id}:${String(r.tiedWithLeader)}`)).toEqual(before);
  });
});

describe("availability is priced into the lineup, not just into the shortlist", () => {
  it("prefers the durable player when the fragile one is a bigger name", () => {
    // `toCompetitor` values a player at `weeklyMean * availability` — his contribution to a
    // week he might not play. Dividing instead inverts that: a player who plays half the
    // season becomes worth *double*, and the boom-or-bust injury risk on every board goes
    // from a discount to a premium.
    //
    // The prefilter uses the same expression, so both candidates have to be at different
    // positions for this to be visible at all — otherwise only one of them is a contender
    // and the lineup solve never compares them. Measured: multiplied gives `durableOk`,
    // divided gives `fragileStar`.
    //
    // 20 x 0.5 = 10 against 12 x 0.95 = 11.4, but 20 / 0.5 = 40 against 12 / 0.95 = 12.6.
    const roster = [
      player("qb", "QB", 20, { availability: 1 }),
      player("rb1", "RB", 19, { availability: 1 }),
      player("rb2", "RB", 18, { availability: 1 }),
      player("wr1", "WR", 17, { availability: 1 }),
      player("wr2", "WR", 16, { availability: 1 }),
      player("te1", "TE", 15, { availability: 1 }),
    ];
    const fragileStar = player("fragileStar", "RB", 20, { availability: 0.5 });
    const durableOk = player("durableOk", "WR", 12, { availability: 0.95 });
    expect(basePolicyPick(roster, [fragileStar, durableOk], SLOTS)?.id).toBe("durableOk");
  });
});

describe("the default candidate limit", () => {
  it("evaluates ten candidates when the caller names no limit", () => {
    // `CHAMPIONSHIP_CANDIDATES` is what a caller gets by saying nothing, and every one of
    // those is a full season simulation — so it is simultaneously the answer's breadth and
    // the recommendation's cost. Nothing pinned it.
    const recs = recommendByChampionship(
      { teams: freshTeams(), myTeamIndex: 0, available: board(), rosterSize: ROUNDS },
      { ...CONFIG, scenarios: 20 },
      3,
    );
    expect(CHAMPIONSHIP_CANDIDATES).toBe(10);
    expect(recs).toHaveLength(CHAMPIONSHIP_CANDIDATES);
  });
});
