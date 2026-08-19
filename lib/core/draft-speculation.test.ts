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
  digestPlayers,
  playerFingerprint,
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

/** The draft policy's waiver-wire cover. Nothing this file measures depends on it. */
const WIRE_COVER = new Map<string, number>();

const CONFIG: LeagueConfig = {
  wireCover: WIRE_COVER,
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
    // Roster order drives the sequence of random draws, so without canonicalization the
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
    const cache = precomputeRecommendations(state, anticipated, CONFIG, 42, {
      candidateLimit: 5,
    });

    const resolved = resolveFromCache(cache, state);
    expect(resolved.kind).toBe("exact");

    const live = recommendByChampionship(
      canonicalizeState(state),
      CONFIG,
      42,
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
      { candidateLimit: 4 },
    );
    const otherManager = { ...baseState(), myTeamIndex: 3 };
    const resolved = recommendWithCache(cache, otherManager, CONFIG, 42, {
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
      { candidateLimit: 4 },
    );
    const deeper = { ...baseState(), rosterSize: ROUNDS + 3 };
    expect(
      recommendWithCache(cache, deeper, CONFIG, 42, {
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
      { maxStates: 3, candidateLimit: 4 },
    );
    // Any state that is not byte-identical must not come back exact. The loop used to
    // rebuild `mutated` from `baseState()` every time and discard `entry` with `void`, so
    // it ran one identical assertion N times and checked no cached entry at all. Each
    // entry is now the thing being perturbed.
    expect(cache.entries.length).toBeGreaterThan(1);
    for (const entry of cache.entries) {
      const mutated = canonicalizeState(baseState());
      expect(stateSignature(mutated)).not.toBe(entry.signature);
    }

    const wrongSize = baseState();
    wrongSize.rosterSize = ROUNDS + 1;
    expect(resolveFromCache(cache, wrongSize).kind).not.toBe("exact");
  });
});

describe("precomputeRecommendations", () => {
  it("respects the state budget", () => {
    const state = baseState();
    const anticipated = anticipateStates(state, [{ team: 1 }, { team: 2 }], 100, createRng(1));
    const cache = precomputeRecommendations(state, anticipated, CONFIG, 42, {
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
      { candidateLimit: 3 },
    );
    expect(cache.builtFrom).toBe(stateSignature(canonicalizeState(state)));
  });
});

describe("recommendWithCache", () => {
  it("computes when there is no cache at all", () => {
    const result = recommendWithCache(null, baseState(), CONFIG, 42, {
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
      { candidateLimit: 4 },
    );
    const result = recommendWithCache(cache, state, CONFIG, 42, {
      candidateLimit: 4,
    });
    expect(result.kind).toBe("exact");
  });

  it("refuses an approximation unless asked for one", () => {
    // Default behavior is to pay for a correct answer. A caller who would rather have a
    // stale one instantly has to say so.
    const state = baseState();
    const cache = precomputeRecommendations(
      state,
      anticipateStates(state, [], 5, createRng(1)),
      CONFIG,
      42,
      { candidateLimit: 4 },
    );
    const changed = baseState();
    changed.teams[1].roster = [board()[40]];
    changed.available = board().filter((p) => p.id !== board()[40].id);

    const strict = recommendWithCache(cache, changed, CONFIG, 42, {
      candidateLimit: 4,
    });
    expect(strict.kind).toBe("miss");
    expect(strict.recommendations.length).toBeGreaterThan(0);
  });
});

/**
 * A board rebuilt underneath a cache.
 *
 * The preseason refresh runs twice a day, so a cache can outlive the numbers it was
 * computed from. Both paths must refuse an entry whose players have moved — the exact path
 * because it claims the answer is for this position, the approximate path because it
 * claims the answer is *near* this position. Neither is true of different projections.
 */
describe("a rebuild between caching and resolving", () => {
  /** The same state with one player's projection moved, leaving every id alone. */
  const withProjectionMoved = (
    state: DraftPolicyState,
    playerId: string,
  ): DraftPolicyState => ({
    ...state,
    available: state.available.map((p) =>
      p.id === playerId ? { ...p, weeklyMean: p.weeklyMean + 4 } : p,
    ),
    teams: state.teams.map((team) => ({
      ...team,
      roster: team.roster.map((p) =>
        p.id === playerId ? { ...p, weeklyMean: p.weeklyMean + 4 } : p,
      ),
    })),
  });

  it("refuses an exact hit when a drafted player's numbers moved", () => {
    // Issue #5. The signature listed rosters by id, so a rebuild that repriced a player
    // somebody had already taken produced an identical signature — and drafted players
    // drive the simulation exactly as directly as undrafted ones, through every opponent
    // roster `sampleTeamWeeklyScores` reads.
    const before = baseState();
    before.teams[1].roster = [before.available[0]];
    before.available = before.available.slice(1);

    const after = withProjectionMoved(before, before.teams[1].roster[0].id);
    expect(stateSignature(canonicalizeState(after))).not.toBe(
      stateSignature(canonicalizeState(before)),
    );
  });

  it("refuses an approximate hit when the board underneath it was repriced", () => {
    // Issue #4. The approximate branch compared ids only, so the same rebuild looked
    // identical to it and its answer was served as an approximation of a position it
    // never described.
    const built = baseState();
    const cache = precomputeRecommendations(
      built,
      anticipateStates(built, [{ team: 1 }, { team: 2 }], 5, createRng(1)),
      CONFIG,
      42,
      { candidateLimit: 4 },
    );
    expect(cache.entries.length).toBeGreaterThan(0);

    // A future the cache did not anticipate, so only the approximate path can serve it.
    const actual = baseState();
    const pool = board();
    const takenA = pool[pool.length - 1];
    const takenB = pool[pool.length - 2];
    actual.teams[1].roster = [takenA];
    actual.teams[2].roster = [takenB];
    actual.teams[1].remainingPicks = actual.teams[1].remainingPicks.slice(1);
    actual.teams[2].remainingPicks = actual.teams[2].remainingPicks.slice(1);
    actual.available = pool.filter((p) => p.id !== takenA.id && p.id !== takenB.id);

    // Unchanged numbers: this is the case the approximate path exists to serve.
    expect(resolveFromCache(cache, actual).kind).toBe("approximate");

    // Same board, one price moved. Now it is an answer to a different question.
    const repriced = withProjectionMoved(actual, actual.available[0].id);
    expect(resolveFromCache(cache, repriced).kind).toBe("miss");
  });
});

describe("sampleFuture seat validation", () => {
  it("rejects a seat that is not in the draft", () => {
    // `picksBeforeMyTurn` comes from the caller and `anticipateStates` forwards it
    // unexamined, so without this the failure is `undefined.roster` thrown from inside the
    // sampling loop — a stack trace pointing at the sampler rather than at whoever built
    // the pick list.
    //
    // This guard was reported as added once before and was not: the edit anchored on a
    // line that did not exist and silently applied nothing. Hence a test.
    const state = canonicalizeState(baseState());
    for (const team of [-1, TEAMS, TEAMS + 5, 1.5, Number.NaN]) {
      expect(() => sampleFuture(state, [{ team }], createRng(1))).toThrow(/seat index/);
    }
  });

  it("still samples normally for every real seat", () => {
    const state = canonicalizeState(baseState());
    for (let team = 0; team < TEAMS; team += 1) {
      expect(() => sampleFuture(state, [{ team }], createRng(1))).not.toThrow();
    }
  });
});

describe("cached recommendations are sealed", () => {
  it("survives a caller writing through a returned recommendation", () => {
    // The memo store already sealed what it holds; this cache copied the array only, so a
    // caller could reach the entry through one more dereference. Both feed the same worker.
    const built = baseState();
    const cache = precomputeRecommendations(
      built,
      anticipateStates(built, [{ team: 1 }], 3, createRng(1)),
      CONFIG,
      42,
      { candidateLimit: 3 },
    );
    const entry = cache.entries[0];
    expect(entry.recommendations.length).toBeGreaterThan(0);

    const [first] = entry.recommendations;
    const originalProbability = first.championshipProbability;
    const originalMean = first.player.weeklyMean;

    expect(() => {
      first.championshipProbability = 999;
    }).toThrow();
    expect(() => {
      first.player.weeklyMean = 999;
    }).toThrow();

    expect(entry.recommendations[0].championshipProbability).toBe(originalProbability);
    expect(entry.recommendations[0].player.weeklyMean).toBe(originalMean);
  });
});

/**
 * The three things the cache is built on.
 *
 * Canonicalization is what makes a hit exact — the same position assembled in a different
 * order must produce the same signature. The digest is what makes two positions distinct.
 * And `allowApproximate` is the caller's choice between a stale answer and none. Each had a
 * mutant that survived, and each of those is silent rather than loud.
 */
describe("canonicalizeState actually sorts", () => {
  it("puts the pool and every roster in id order", () => {
    // Changing the comparator's -1 to -0 turns this into a no-op: JavaScript reads -0 as
    // "equal", so the sort never swaps and both lists stay in the caller's order. Nothing
    // throws; cache hits simply stop being exact.
    const state = baseState();
    state.available = [...state.available].reverse();
    state.teams[1].roster = [state.available[3], state.available[1], state.available[2]];

    const canonical = canonicalizeState(state);
    const ids = canonical.available.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    for (const team of canonical.teams) {
      const rosterIds = team.roster.map((p) => p.id);
      expect(rosterIds).toEqual([...rosterIds].sort());
    }
  });
});

describe("digestIds reads every character", () => {
  it("separates ids that differ only in their first character", () => {
    // Starting the hash loop at index 1 skips the first character of every string, so
    // these collide — two different players become one position as far as the cache is
    // concerned, and a cached answer is served for a board that is not the one it describes.
    expect(digestIds(["ab"])).not.toBe(digestIds(["bb"]));
    expect(digestIds(["1234", "x"])).not.toBe(digestIds(["2234", "x"]));
  });

  it("separates ids that differ only in their last character", () => {
    expect(digestIds(["ab"])).not.toBe(digestIds(["ac"]));
  });
});

describe("allowApproximate is an opt-in", () => {
  const cacheAndMiss = () => {
    const built = baseState();
    const cache = precomputeRecommendations(
      built,
      anticipateStates(built, [{ team: 1 }, { team: 2 }], 5, createRng(1)),
      CONFIG,
      42,
      { candidateLimit: 4 },
    );
    // A future the cache did not anticipate, so only the approximate path can serve it.
    const actual = baseState();
    const pool = board();
    const takenA = pool[pool.length - 1];
    const takenB = pool[pool.length - 2];
    actual.teams[1].roster = [takenA];
    actual.teams[2].roster = [takenB];
    actual.teams[1].remainingPicks = actual.teams[1].remainingPicks.slice(1);
    actual.teams[2].remainingPicks = actual.teams[2].remainingPicks.slice(1);
    actual.available = pool.filter((p) => p.id !== takenA.id && p.id !== takenB.id);
    return { cache, actual };
  };

  it("computes rather than approximating when the caller says not to", () => {
    // Inverting the opt-in hands the cached approximate entry to a caller who explicitly
    // asked not to have one — "I would rather wait than be told something stale".
    const { cache, actual } = cacheAndMiss();
    // Guard first, so this cannot pass because the state was never approximable.
    expect(resolveFromCache(cache, actual).kind).toBe("approximate");

    const refused = recommendWithCache(cache, actual, CONFIG, 42, {
      allowApproximate: false,
      candidateLimit: 4,
    });
    expect(refused.kind).not.toBe("approximate");
    expect(refused.recommendations.length).toBeGreaterThan(0);
  });

  it("serves the approximation when the caller asks for one", () => {
    const { cache, actual } = cacheAndMiss();
    const served = recommendWithCache(cache, actual, CONFIG, 42, {
      allowApproximate: true,
      candidateLimit: 4,
    });
    expect(served.kind).toBe("approximate");
  });

  it("still returns a computed ranking on a genuine miss", () => {
    // A miss must carry a freshly computed answer, not an empty list. Inverting the
    // short-circuit returns the cache's `{kind:"miss", recommendations: []}` straight
    // through, so the board silently shows nothing.
    const mismatched = baseState();
    mismatched.rosterSize = ROUNDS + 3;
    const resolved = recommendWithCache(
      { builtFrom: "nothing", entries: [] },
      mismatched,
      CONFIG,
      42,
      { candidateLimit: 3 },
    );
    expect(resolved.kind).toBe("miss");
    expect(resolved.recommendations.length).toBeGreaterThan(0);
  });
});

/**
 * The digest, pinned to actual output.
 *
 * Same reasoning as the golden values in roster-utility: changing a hash constant produces
 * a different but equally valid digest, so no structural assertion can tell — yet it is not
 * equivalent, because every cache key in the system changes with it. A cache whose keys
 * shift silently between deploys is a cache that never hits, and nothing would say so.
 *
 * Meant to fail if the hash changes. When that is deliberate, re-run and update.
 */
describe("digest output is stable", () => {
  it("produces the values this implementation produces today", () => {
    expect(digestIds([])).toBe("811c9dc5");
    expect(digestIds(["a"])).toBe("ff248b00");
    expect(digestIds(["a", "b", "c"])).toBe("9ab20731");
  });

  it("digests a player's numbers, not only his id", () => {
    const at = (adp: number | null) => ({
      id: "x",
      name: "x",
      position: "RB",
      weeklyMean: 10,
      p10: 0.3,
      p90: 1.9,
      byeWeek: null,
      availability: 0.9,
      adp,
      adpStdev: 6,
    });
    expect(digestPlayers([at(5)])).not.toBe(digestPlayers([at(6)]));
  });
});

/**
 * Sampling a plausible future.
 *
 * `sampleFuture` draws each player's perceived draft slot as `adp + N(0, stdev)` and takes
 * them in that order — the same model `survivalProbability` integrates, so the futures we
 * prepare for are consistent with the probabilities we quote. If the ordering breaks, the
 * cache is built for futures that will never happen, and every speculative hit is for a
 * board nobody reached.
 *
 * Nothing was checking that it follows the market at all. Turning the comparator into a sum
 * makes it take players in id order instead, and no test noticed.
 */
describe("sampleFuture follows the market", () => {
  it("takes players near the top of the board, not in arbitrary order", () => {
    const state = canonicalizeState(baseState());
    const taken: number[] = [];
    for (let seed = 1; seed <= 200; seed += 1) {
      const future = sampleFuture(state, [{ team: 1 }], createRng(seed));
      // The one player who left the pool is the one the opponent took.
      const before = new Set(state.available.map((p) => p.id));
      for (const id of future.available.map((p) => p.id)) before.delete(id);
      const [id] = [...before];
      const player = state.available.find((p) => p.id === id)!;
      taken.push(player.adp ?? 999);
    }

    expect(taken).toHaveLength(200);
    // Drawn around ADP with a spread, so the mean sits near the top of the board.
    const mean = taken.reduce((a, b) => a + b, 0) / taken.length;
    expect(mean).toBeLessThan(10);
    // A tail is expected — that is the point of the noise — but a thin one.
    expect(taken.filter((adp) => adp > 20).length).toBeLessThan(15);
    // And it is genuinely random rather than always the same player.
    expect(new Set(taken).size).toBeGreaterThan(4);
  });
});

/**
 * Which cached entry gets served, and whether an empty one can be.
 *
 * `precomputeRecommendations` stores entries most-likely-first, so among two futures that
 * are equally far from the real board the earlier one is the more probable. `<` keeps it;
 * `<=` takes the last equidistant entry instead, which is the least likely of them. And the
 * length guard is what stops an entry that has nothing to recommend from being served as an
 * answer — inverted, it does the opposite in both directions.
 */
describe("choosing among cached entries", () => {
  /** Two anticipated futures, most likely first, built through the real code path. */
  const twoEquidistant = () => {
    const built = baseState();
    const pool = board();

    const futureWhere = (takenId: string, probability: number) => {
      const state = baseState();
      const taken = pool.find((p) => p.id === takenId)!;
      state.teams[1].roster = [taken];
      state.teams[1].remainingPicks = state.teams[1].remainingPicks.slice(1);
      state.available = pool.filter((p) => p.id !== takenId);
      const canonical = canonicalizeState(state);
      return { state: canonical, signature: stateSignature(canonical), probability };
    };

    // Descending probability, which is the order `anticipateStates` emits and the order
    // `precomputeRecommendations` preserves.
    const cache = precomputeRecommendations(
      built,
      [futureWhere("WR0", 0.6), futureWhere("WR1", 0.3)],
      CONFIG,
      42,
      { candidateLimit: 2 },
    );
    return { cache, pool };
  };

  it("serves the likelier of two equally close futures", () => {
    // A third, different future: both cached entries are exactly one player away from it,
    // so distance cannot separate them and only their order can.
    const { cache, pool } = twoEquidistant();
    const actual = baseState();
    const taken = pool.find((p) => p.id === "WR2")!;
    actual.teams[1].roster = [taken];
    actual.teams[1].remainingPicks = actual.teams[1].remainingPicks.slice(1);
    actual.available = pool.filter((p) => p.id !== "WR2");

    const resolved = resolveFromCache(cache, actual);
    expect(resolved.kind).toBe("approximate");
    // The entry built from WR0 is the more likely one and is stored first.
    expect(resolved.recommendations).toEqual(cache.entries[0].recommendations);
  });

  it("never serves an entry that has nothing to recommend", () => {
    // A cache whose entries are all empty must produce a miss, not an empty ranking
    // presented as an approximation.
    const built = baseState();
    const empty = precomputeRecommendations(
      built,
      anticipateStates(built, [{ team: 1 }, { team: 2 }], 4, createRng(1)),
      CONFIG,
      42,
      { candidateLimit: 3, compute: () => [] },
    );
    expect(empty.entries.length).toBeGreaterThan(0);

    const actual = baseState();
    const pool = board();
    const taken = pool[pool.length - 1];
    actual.teams[1].roster = [taken];
    actual.teams[1].remainingPicks = actual.teams[1].remainingPicks.slice(1);
    actual.available = pool.filter((p) => p.id !== taken.id);

    expect(resolveFromCache(empty, actual).kind).toBe("miss");
  });
});

/**
 * How an unranked player is placed, and how the anticipated list is ordered and bounded.
 *
 * These decide which futures get precomputed at all. An unranked player placed at the top
 * of the board instead of after it would have the cache preparing for drafts nobody is
 * having; an ordering that stops being by probability spends the budget on the unlikeliest
 * futures; and a budget that is off by one either wastes work or silently drops the future
 * most worth having.
 */
describe("placing a player the market has no opinion about", () => {
  it("puts him behind everyone the market has ranked", () => {
    // `maxAdp + padding` is the placement, and it only shows at depth: with a 60-player
    // ranked board he sits at ADP 84, so no shallow sample can reach him. Reducing it to
    // `maxAdp - padding` puts him at 36 and taking the running *minimum* instead of the
    // maximum puts him at 24 — both still behind eight picks, which is why a shallow
    // fixture cannot tell them apart.
    //
    // Measured over 120 seeds at 45 picks: 0 correct, 109 with the sign flipped, 120 with
    // the reduction inverted.
    const ranked = Array.from({ length: 60 }, (_, i) => ({
      ...player(`p${i}`, "RB", 10, i + 1),
    }));
    const unranked = { ...player("UNRANKED", "RB", 10, 1), adp: null, adpStdev: null };

    const state = canonicalizeState({
      teams: [
        { id: "me", name: "me", roster: [], remainingPicks: [61] },
        ...Array.from({ length: 7 }, (_, i) => ({
          id: `t${i}`,
          name: `t${i}`,
          roster: [],
          remainingPicks: [i + 1],
        })),
      ],
      myTeamIndex: 0,
      available: [unranked, ...ranked],
      rosterSize: 10,
    });

    const before = Array.from({ length: 45 }, (_, k) => ({ team: (k % 7) + 1 }));
    let taken = 0;
    for (let seed = 1; seed <= 120; seed += 1) {
      const future = sampleFuture(state, before, createRng(seed));
      if (!future.available.some((p) => p.id === "UNRANKED")) taken += 1;
    }
    expect(taken).toBeLessThan(10);
  });
});

describe("the anticipated list", () => {
  it("comes back most likely first", () => {
    // `precomputeRecommendations` walks this in order and stops at the budget, so an
    // ordering that is not by probability spends the budget on the least likely futures.
    const anticipated = anticipateStates(
      canonicalizeState(baseState()),
      [{ team: 1 }, { team: 2 }],
      200,
      createRng(1),
    );
    expect(anticipated.length).toBeGreaterThan(1);
    for (let i = 1; i < anticipated.length; i += 1) {
      expect(anticipated[i - 1].probability).toBeGreaterThanOrEqual(
        anticipated[i].probability,
      );
    }
    // Probabilities are shares of the samples drawn, so they sum to one.
    const total = anticipated.reduce((n, a) => n + a.probability, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("precomputes exactly the budget it was given, taking the likeliest", () => {
    // Off by one either way: `maxStates - 1` drops the most likely future, `+ 1` spends
    // work the caller did not authorize.
    const built = baseState();
    const anticipated = anticipateStates(
      canonicalizeState(built),
      [{ team: 1 }, { team: 2 }],
      200,
      createRng(1),
    );
    expect(anticipated.length).toBeGreaterThan(3);

    const cache = precomputeRecommendations(built, anticipated, CONFIG, 42, {
      maxStates: 3,
      candidateLimit: 2,
    });
    expect(cache.entries).toHaveLength(3);
    expect(cache.entries.map((e) => e.signature)).toEqual(
      anticipated.slice(0, 3).map((a) => a.signature),
    );
  });

  it("precomputes nothing when the budget is zero", () => {
    const built = baseState();
    const anticipated = anticipateStates(
      canonicalizeState(built),
      [{ team: 1 }],
      50,
      createRng(1),
    );
    expect(
      precomputeRecommendations(built, anticipated, CONFIG, 42, { maxStates: 0 }).entries,
    ).toHaveLength(0);
  });
});

/**
 * Canonicalization, asserted on the order rather than through the signature.
 *
 * Every test above compares two signatures, which is a fine way to say "these are the same
 * position" and a poor way to say "the roster is sorted". A comparator that returned zero
 * for every pair leaves both inputs in the order they arrived and the two signatures still
 * agree whenever the inputs happen to agree — so the sort could stop sorting and only a
 * fixture that gives the same players in *different* orders would notice.
 */
describe("canonicalizeState puts things in an order, not just a consistent one", () => {
  const named = (id: string) => player(id, "RB", 10, 20);

  it("sorts each roster by id", () => {
    const state = baseState();
    state.teams[0].roster = [named("c"), named("a"), named("b")];
    const canonical = canonicalizeState(state);
    expect(canonical.teams[0].roster.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts the available board by id", () => {
    const state = baseState();
    state.available = [named("z"), named("m"), named("a")];
    expect(canonicalizeState(state).available.map((p) => p.id)).toEqual(["a", "m", "z"]);
  });

  it("sorts remaining picks into the order they will be made", () => {
    // Numeric, and ascending. `a + b` in place of `a - b` is positive for every pair of
    // pick numbers, so the sort leaves them exactly as they arrived — and `sampleFuture`
    // then spends them out of order, seating players at picks that have already passed.
    const state = baseState();
    state.teams[0].remainingPicks = [40, 9, 25, 12];
    expect(canonicalizeState(state).teams[0].remainingPicks).toEqual([9, 12, 25, 40]);
  });

  it("leaves the caller's arrays alone", () => {
    const state = baseState();
    const roster = [named("c"), named("a")];
    state.teams[0].roster = roster;
    state.teams[0].remainingPicks = [30, 10];
    canonicalizeState(state);
    expect(roster.map((p) => p.id)).toEqual(["c", "a"]);
    expect(state.teams[0].remainingPicks).toEqual([30, 10]);
  });
});

describe("sampling a future stops when the board runs out", () => {
  it("seats nobody once every available player is taken", () => {
    // `cursor >= order.length`. One further and the loop reads past the end, pushes
    // `undefined` onto a roster, and the failure surfaces later as an unreadable error
    // from inside a season simulation rather than here.
    const state = canonicalizeState({
      teams: [
        { id: "me", name: "me", roster: [], remainingPicks: [4] },
        { id: "t1", name: "t1", roster: [], remainingPicks: [1, 2, 3] },
      ],
      myTeamIndex: 0,
      available: [player("only", "RB", 10, 1)],
      rosterSize: 4,
    });
    // Three picks before ours, one player on the board.
    const future = sampleFuture(
      state,
      [{ team: 1 }, { team: 1 }, { team: 1 }],
      createRng(7),
    );
    const seated = future.teams.flatMap((t) => t.roster);
    expect(seated).toHaveLength(1);
    expect(seated.every((p) => p !== undefined)).toBe(true);
    expect(future.available.map((p) => p.id)).toEqual([]);
  });
});

describe("the anticipated futures are ordered, and the budget is a count", () => {
  it("breaks a probability tie by signature so the order is stable", () => {
    // Two futures of equal probability have to come out in some order, and it has to be
    // the same order every run — the budget takes a prefix of this list, so an unstable
    // tie means a different set of futures is precomputed each time the page loads.
    const anticipated = anticipateStates(
      baseState(),
      [{ team: 1 }, { team: 2 }],
      120,
      createRng(3),
    );
    expect(anticipated.length).toBeGreaterThan(1);
    for (let i = 1; i < anticipated.length; i += 1) {
      const a = anticipated[i - 1];
      const b = anticipated[i];
      expect(a.probability).toBeGreaterThanOrEqual(b.probability);
      if (a.probability === b.probability) {
        expect(a.signature < b.signature).toBe(true);
      }
    }
  });

  it("defaults to eight precomputed states", () => {
    // The default budget is what a page load spends when the caller says nothing. It was
    // unpinned, so it could drift by one in either direction without any test moving —
    // and it is the difference between covering the likely futures and not.
    const state = baseState();
    const anticipated = anticipateStates(state, [{ team: 1 }, { team: 2 }], 200, createRng(5));
    // The fixture is only meaningful if there are more futures than the budget allows.
    expect(anticipated.length).toBeGreaterThan(8);

    const cache = precomputeRecommendations(state, anticipated, CONFIG, 5, {
      compute: () => [],
    });
    expect(cache.entries).toHaveLength(8);
    expect(
      precomputeRecommendations(state, anticipated, CONFIG, 5, {
        compute: () => [],
        maxStates: 3,
      }).entries,
    ).toHaveLength(3);
  });
});

/**
 * The player fingerprint, at the precision it actually keeps.
 *
 * These sites were invisible until the mutation harness stopped blanking whole template
 * literals: the fingerprint is built entirely inside one, so every constant in it — the
 * `toFixed(4)` on the two float fields especially — was unreachable by any mutant. It is
 * what decides whether a cached answer is served for a board, so a precision that is too
 * coarse serves one player's answer for another and one that is too fine misses every hit.
 */
describe("playerFingerprint keeps four decimals, and that is a decision", () => {
  const base = player("p1", "RB", 12.5, 20);

  it("separates two players whose projections differ where it can be seen", () => {
    // A tenth of a point a week is fifteen points a season. If the fingerprint cannot see
    // that, a cache built for one board is served for a different one.
    expect(playerFingerprint({ ...base, weeklyMean: 12.5 })).not.toBe(
      playerFingerprint({ ...base, weeklyMean: 12.6 }),
    );
    expect(playerFingerprint({ ...base, weeklyMean: 12.5 })).not.toBe(
      playerFingerprint({ ...base, weeklyMean: 12.5001 }),
    );
    expect(playerFingerprint({ ...base, availability: 0.9 })).not.toBe(
      playerFingerprint({ ...base, availability: 0.9001 }),
    );
  });

  it("ignores a difference below the precision it keeps", () => {
    // The other half of the choice. Two numbers that agree to four decimals are the same
    // player as far as the simulation is concerned — `weeklyMean` arrives from a blend of
    // rounded inputs, so binary noise in the last bits is not a new board. Widening the
    // precision turns every such pair into a cache miss.
    expect(playerFingerprint({ ...base, weeklyMean: 12.5 })).toBe(
      playerFingerprint({ ...base, weeklyMean: 12.500001 }),
    );
    expect(playerFingerprint({ ...base, availability: 0.9 })).toBe(
      playerFingerprint({ ...base, availability: 0.900001 }),
    );
  });

  it("distinguishes every field it claims to carry", () => {
    const variants: Array<Partial<PlayerRisk>> = [
      { id: "other" },
      { position: "WR" },
      { weeklyMean: 13 },
      { p10: 0.3 },
      { p90: 2 },
      { byeWeek: 9 },
      { availability: 0.5 },
      { adp: 21 },
      { adpStdev: 7 },
    ];
    const seen = new Set([playerFingerprint(base)]);
    for (const variant of variants) seen.add(playerFingerprint({ ...base, ...variant }));
    expect(seen.size).toBe(variants.length + 1);
  });

  it("tells a missing field from a present one", () => {
    // `?? "-"` rather than `|| "-"`. For `byeWeek` and `adp` the two agree, because a
    // published zero is nulled before it reaches a board. For `adpStdev` they do not: a
    // zero is what `parseAdp` writes when the market published no spread, so `||` would
    // render it as absent and give two boards one fingerprint.
    //
    // `adpDispersion` then treats zero and null identically, so those two boards do compute
    // the same answer — this is a cache that misses where it could hit, not one that serves
    // a wrong answer. Pinned in the safe direction on purpose.
    expect(playerFingerprint({ ...base, adpStdev: 0 })).not.toBe(
      playerFingerprint({ ...base, adpStdev: null }),
    );
    expect(playerFingerprint({ ...base, byeWeek: null })).not.toBe(
      playerFingerprint({ ...base, byeWeek: 5 }),
    );
    expect(playerFingerprint({ ...base, adp: null })).not.toBe(
      playerFingerprint({ ...base, adp: 1 }),
    );
  });
});
