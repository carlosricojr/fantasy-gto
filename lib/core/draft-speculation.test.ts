import { describe, expect, it } from "vitest";

import { buildSlots } from "../nfl/roster";
import { snakePicks } from "./draft";
import {
  type DraftPolicyState,
  type DraftTeam,
  recommendByChampionship,
} from "./draft-policy";
import {
  anticipateStates,
  canonicalizeState,
  digestIds,
  precomputeRecommendations,
  recommendWithCache,
  resolveFromCache,
  sampleFuture,
  stateSignature,
} from "./draft-speculation";
import { createRng } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import type { LeagueConfig } from "./season-sim";

/**
 * Speculative precomputation.
 *
 * These are written to break the cache rather than to demonstrate it. The failure that
 * matters is not a miss — a miss just costs time — it is a hit that is not really a hit,
 * because that serves a confident answer about a board that does not exist.
 */

const SLOTS = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
const TEAMS = 6;
const ROUNDS = 8;

const CONFIG: LeagueConfig = {
  slots: SLOTS,
  weeks: Array.from({ length: 12 }, (_, i) => i + 1),
  playoffWeeks: [13, 14],
  playoffTeams: 4,
  scenarios: 60,
  meanAbsenceWeeks: 3,
};

function player(id: string, position: string, mean: number, adp: number): PlayerRisk {
  return {
    id,
    name: id,
    position,
    weeklyMean: mean,
    p10: 0.269,
    p90: 1.901,
    byeWeek: 5 + (adp % 6),
    availability: 0.9,
    adp,
    adpStdev: 6,
  };
}

function board(): PlayerRisk[] {
  const out: PlayerRisk[] = [];
  let adp = 1;
  for (let tier = 0; tier < 12; tier += 1) {
    for (const position of ["RB", "WR", "QB", "TE"] as const) {
      out.push(player(`${position}${tier}`, position, 16 - tier * 0.8, adp));
      adp += 1;
    }
  }
  return out;
}

function teams(): DraftTeam[] {
  return Array.from({ length: TEAMS }, (_, i) => ({
    id: `t${i}`,
    name: `Team ${i + 1}`,
    roster: [],
    remainingPicks: snakePicks(i + 1, TEAMS, ROUNDS),
  }));
}

function baseState(): DraftPolicyState {
  return { teams: teams(), myTeamIndex: 0, available: board(), rosterSize: ROUNDS };
}

describe("digestIds", () => {
  it("is order-independent", () => {
    expect(digestIds(["a", "b", "c"])).toBe(digestIds(["c", "a", "b"]));
  });

  it("separates different sets, including subsets", () => {
    expect(digestIds(["a", "b"])).not.toBe(digestIds(["a", "b", "c"]));
    expect(digestIds(["a", "b"])).not.toBe(digestIds(["a"]));
    expect(digestIds([])).not.toBe(digestIds(["a"]));
  });

  it("does not confuse a join of ids with a single concatenated id", () => {
    // The classic delimiter bug: without a separator, ["ab","c"] and ["a","bc"] collide.
    expect(digestIds(["ab", "c"])).not.toBe(digestIds(["a", "bc"]));
  });
});

describe("canonicalizeState and stateSignature", () => {
  it("makes roster order irrelevant", () => {
    // Roster order drives the sequence of random draws, so without canonicalisation the
    // same position computes differently depending on the order picks arrived in.
    const a = baseState();
    const b = baseState();
    const pool = board();
    a.teams[0].roster = [pool[0], pool[1], pool[2]];
    b.teams[0].roster = [pool[2], pool[0], pool[1]];
    expect(stateSignature(canonicalizeState(a))).toBe(stateSignature(canonicalizeState(b)));
  });

  it("distinguishes which team holds a player", () => {
    // The same players gone, distributed differently, is a genuinely different position:
    // opponents field their own lineups.
    const a = baseState();
    const b = baseState();
    const pool = board();
    a.teams[0].roster = [pool[0]];
    a.teams[1].roster = [pool[1]];
    b.teams[0].roster = [pool[1]];
    b.teams[1].roster = [pool[0]];
    expect(stateSignature(canonicalizeState(a))).not.toBe(
      stateSignature(canonicalizeState(b)),
    );
  });

  it("distinguishes whose turn it is", () => {
    const a = baseState();
    const b = { ...baseState(), myTeamIndex: 1 };
    expect(stateSignature(canonicalizeState(a))).not.toBe(
      stateSignature(canonicalizeState(b)),
    );
  });

  it("distinguishes a different remaining pool", () => {
    // A board rebuilt against a newer market has different players on it. Two positions
    // with identical rosters are still different problems if the pool differs.
    const a = baseState();
    const b = baseState();
    b.available = b.available.slice(0, b.available.length - 1);
    expect(stateSignature(canonicalizeState(a))).not.toBe(
      stateSignature(canonicalizeState(b)),
    );
  });

  it("distinguishes remaining picks", () => {
    const a = baseState();
    const b = baseState();
    b.teams[0].remainingPicks = b.teams[0].remainingPicks.slice(1);
    expect(stateSignature(canonicalizeState(a))).not.toBe(
      stateSignature(canonicalizeState(b)),
    );
  });
});

describe("sampleFuture", () => {
  it("removes exactly one player per intervening pick", () => {
    const state = canonicalizeState(baseState());
    const picks = [{ team: 1 }, { team: 2 }, { team: 3 }];
    const future = sampleFuture(state, picks, createRng(1));
    expect(future.available).toHaveLength(state.available.length - picks.length);
  });

  it("gives each intervening pick to the right team", () => {
    const state = canonicalizeState(baseState());
    const future = sampleFuture(state, [{ team: 1 }, { team: 1 }, { team: 2 }], createRng(2));
    expect(future.teams[1].roster).toHaveLength(2);
    expect(future.teams[2].roster).toHaveLength(1);
    expect(future.teams[0].roster).toHaveLength(0);
  });

  it("consumes the picking teams' remaining picks", () => {
    const state = canonicalizeState(baseState());
    const before = state.teams[1].remainingPicks.length;
    const future = sampleFuture(state, [{ team: 1 }], createRng(3));
    expect(future.teams[1].remainingPicks).toHaveLength(before - 1);
  });

  it("never assigns the same player twice", () => {
    const state = canonicalizeState(baseState());
    const picks = Array.from({ length: 20 }, (_, i) => ({ team: i % TEAMS }));
    const future = sampleFuture(state, picks, createRng(4));
    const drafted = future.teams.flatMap((t) => t.roster.map((p) => p.id));
    expect(new Set(drafted).size).toBe(drafted.length);
  });

  it("survives being asked for more picks than there are players", () => {
    const state = canonicalizeState({
      teams: teams(),
      myTeamIndex: 0,
      available: board().slice(0, 3),
      rosterSize: ROUNDS,
    });
    const picks = Array.from({ length: 50 }, (_, i) => ({ team: i % TEAMS }));
    const future = sampleFuture(state, picks, createRng(5));
    expect(future.available).toHaveLength(0);
  });

  it("mostly follows the market but does not always", () => {
    // If futures were deterministic there would be nothing to speculate about; if they
    // were uniform, speculation would never pay. Both extremes are checked.
    const state = canonicalizeState(baseState());
    const outcomes = new Set<string>();
    for (let seed = 0; seed < 40; seed += 1) {
      outcomes.add(stateSignature(sampleFuture(state, [{ team: 1 }, { team: 2 }], createRng(seed))));
    }
    expect(outcomes.size).toBeGreaterThan(1);
    expect(outcomes.size).toBeLessThan(40);
  });
});

describe("anticipateStates", () => {
  it("returns the current state with certainty when our turn is now", () => {
    const state = baseState();
    const anticipated = anticipateStates(state, [], 50, createRng(1));
    expect(anticipated).toHaveLength(1);
    expect(anticipated[0].probability).toBe(1);
    expect(anticipated[0].signature).toBe(stateSignature(canonicalizeState(state)));
  });

  it("orders futures by likelihood and the probabilities sum to one", () => {
    const anticipated = anticipateStates(
      baseState(),
      [{ team: 1 }, { team: 2 }],
      200,
      createRng(7),
    );
    const total = anticipated.reduce((s, a) => s + a.probability, 0);
    expect(total).toBeCloseTo(1, 6);
    for (let i = 1; i < anticipated.length; i += 1) {
      expect(anticipated[i - 1].probability).toBeGreaterThanOrEqual(
        anticipated[i].probability,
      );
    }
  });

  it("produces distinct signatures", () => {
    const anticipated = anticipateStates(baseState(), [{ team: 1 }], 100, createRng(8));
    const signatures = anticipated.map((a) => a.signature);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("is deterministic for a seed", () => {
    const first = anticipateStates(baseState(), [{ team: 1 }], 50, createRng(9));
    const second = anticipateStates(baseState(), [{ team: 1 }], 50, createRng(9));
    expect(first.map((a) => a.signature)).toEqual(second.map((a) => a.signature));
  });
});

describe("the cache contract", () => {
  it("an exact hit returns exactly what computing live would return", () => {
    // The load-bearing guarantee. If this ever diverges, the cache is serving a different
    // answer under the same name, which is worse than not caching at all.
    const state = baseState();
    const anticipated = anticipateStates(state, [], 10, createRng(1));
    const cache = precomputeRecommendations(state, anticipated, CONFIG, 42, createRng, {
      candidateLimit: 5,
    });

    const resolved = resolveFromCache(cache, state);
    expect(resolved.kind).toBe("exact");

    const live = recommendByChampionship(
      canonicalizeState(state),
      CONFIG,
      42,
      createRng,
      5,
    );
    expect(resolved.recommendations).toEqual(live);
  });

  it("a hit survives the same position arriving in a different roster order", () => {
    const pool = board();
    const built = baseState();
    built.teams[1].roster = [pool[0], pool[1]];
    const cache = precomputeRecommendations(
      built,
      anticipateStates(built, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );

    const reordered = baseState();
    reordered.teams[1].roster = [pool[1], pool[0]];
    reordered.available = built.available;
    expect(resolveFromCache(cache, reordered).kind).toBe("exact");
  });

  it("does not serve an answer computed for a different team's turn", () => {
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );
    const otherTurn = { ...baseState(), myTeamIndex: 1 };
    expect(resolveFromCache(cache, otherTurn).kind).not.toBe("exact");
  });

  it("does not serve an answer when a player has since been taken", () => {
    // The most dangerous near-miss: the cached ranking's leader is already gone.
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );
    const leader = cache.entries[0].recommendations[0].player.id;

    const later = baseState();
    later.teams[1].roster = [board().find((p) => p.id === leader)!];
    later.available = board().filter((p) => p.id !== leader);

    const resolved = resolveFromCache(cache, later);
    expect(resolved.kind).not.toBe("exact");
    // And it must not be offered as an approximation either, because the player it would
    // recommend is unavailable.
    expect(resolved.kind).toBe("miss");
  });

  it("refuses to approximate one manager's position with another's answer", () => {
    // The worst failure this module can have. An entry computed for team 0 recommends
    // players who are all still on the board, so a check that looked only at its own
    // output happily served team 0's ranking — with team 0's roster and team 0's
    // remaining picks behind every number — to team 3.
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );
    const otherManager = { ...baseState(), myTeamIndex: 3 };
    const resolved = recommendWithCache(cache, otherManager, CONFIG, 42, createRng, {
      candidateLimit: 4,
      allowApproximate: true,
    });
    expect(resolved.kind).toBe("miss");
  });

  it("refuses to approximate across a different roster size", () => {
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );
    const deeper = { ...baseState(), rosterSize: ROUNDS + 3 };
    expect(
      recommendWithCache(cache, deeper, CONFIG, 42, createRng, {
        candidateLimit: 4,
        allowApproximate: true,
      }).kind,
    ).toBe("miss");
  });

  it("populates what differs when it does approximate", () => {
    // The `differences` field was previously unreachable: the filter above it guaranteed
    // both lists were empty, so it always reported that nothing differed.
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [{ team: 1 }, { team: 2 }], 60, createRng(1)),
      CONFIG,
      42,
      createRng,
      { maxStates: 6, candidateLimit: 4 },
    );

    // A real future: two opponents have picked, but not the ones any entry predicted.
    const actual = baseState();
    const pool = board();
    const takenA = pool[pool.length - 1];
    const takenB = pool[pool.length - 2];
    actual.teams[1].roster = [takenA];
    actual.teams[2].roster = [takenB];
    actual.teams[1].remainingPicks = actual.teams[1].remainingPicks.slice(1);
    actual.teams[2].remainingPicks = actual.teams[2].remainingPicks.slice(1);
    actual.available = pool.filter((p) => p.id !== takenA.id && p.id !== takenB.id);

    // Asserted unconditionally. The previous form branched on the resolution and, in the
    // `else`, asserted that a miss is a miss — so a regression that stopped populating
    // `differences`, the field this test exists for, would resolve as a miss and pass.
    //
    // The two players taken are the last on the board, which a `candidateLimit: 4`
    // ranking cannot contain, so every recommended player is still available and this
    // must resolve as approximate.
    const resolved = resolveFromCache(cache, actual);
    expect(resolved.kind).toBe("approximate");
    const diff = resolved.differences!;
    expect(diff.missingFromCache.length + diff.extraInCache.length).toBeGreaterThan(0);
  });

  it("reports a miss on an empty cache rather than an empty ranking", () => {
    const resolved = resolveFromCache({ builtFrom: "x", entries: [] }, baseState());
    expect(resolved.kind).toBe("miss");
    expect(resolved.recommendations).toEqual([]);
  });

  it("never labels an approximation as exact", () => {
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [{ team: 1 }, { team: 2 }], 60, createRng(1)),
      CONFIG,
      42,
      createRng,
      { maxStates: 3, candidateLimit: 4 },
    );
    // Any state that is not byte-identical must not come back exact.
    for (const entry of cache.entries) {
      const mutated = baseState();
      mutated.rosterSize = ROUNDS + 1;
      const resolved = resolveFromCache(cache, mutated);
      expect(resolved.kind).not.toBe("exact");
      void entry;
    }
  });
});

describe("precomputeRecommendations", () => {
  it("respects the state budget", () => {
    const state = baseState();
    const anticipated = anticipateStates(state, [{ team: 1 }, { team: 2 }], 100, createRng(1));
    const cache = precomputeRecommendations(state, anticipated, CONFIG, 42, createRng, {
      maxStates: 2,
      candidateLimit: 3,
    });
    expect(cache.entries).toHaveLength(2);
  });

  it("stops when the clock says to", () => {
    // The budget that matters is time until the pick, which only the caller knows.
    let calls = 0;
    const cache = precomputeRecommendations(
      baseState(),
      anticipateStates(baseState(), [{ team: 1 }], 60, createRng(1)),
      CONFIG,
      42,
      createRng,
      {
        maxStates: 8,
        candidateLimit: 3,
        shouldContinue: () => {
          calls += 1;
          return calls <= 2;
        },
      },
    );
    expect(cache.entries).toHaveLength(2);
  });

  it("records the state it was built from, so staleness is detectable", () => {
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 3 },
    );
    expect(cache.builtFrom).toBe(stateSignature(canonicalizeState(state)));
  });
});

describe("recommendWithCache", () => {
  it("computes when there is no cache at all", () => {
    const result = recommendWithCache(null, baseState(), CONFIG, 42, createRng, {
      candidateLimit: 4,
    });
    expect(result.kind).toBe("miss");
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("serves an exact hit without recomputing", () => {
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );
    const result = recommendWithCache(cache, state, CONFIG, 42, createRng, {
      candidateLimit: 4,
    });
    expect(result.kind).toBe("exact");
  });

  it("refuses an approximation unless asked for one", () => {
    // Default behaviour is to pay for a correct answer. A caller who would rather have a
    // stale one instantly has to say so.
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      createRng,
      { candidateLimit: 4 },
    );
    const changed = baseState();
    changed.teams[1].roster = [board()[40]];
    changed.available = board().filter((p) => p.id !== board()[40].id);

    const strict = recommendWithCache(cache, changed, CONFIG, 42, createRng, {
      candidateLimit: 4,
    });
    expect(strict.kind).toBe("miss");
    expect(strict.recommendations.length).toBeGreaterThan(0);
  });
});
