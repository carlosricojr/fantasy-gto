import { describe, expect, it } from "vitest";

import { buildSlots } from "../nfl/roster";
import { snakePicks } from "./draft";
import {
  type DraftPolicyState,
  type DraftTeam,
  recommendByChampionship,
} from "./draft-policy";
import {
  LruMemoStore,
  leagueFingerprint,
  memoizedCompute,
  memoKey,
  recommendMemoized,
} from "./draft-memo";
import {
  anticipateStates,
  canonicalizeState,
  precomputeRecommendations,
} from "./draft-speculation";
import { createRng } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import type { LeagueConfig } from "./season-sim";

/**
 * Memoisation.
 *
 * A memo that returns the wrong answer quickly is far worse than no memo. Every test here
 * is an attempt to get a hit that should have been a miss — a different league, a
 * different seed, a different rule — because that is the only failure mode with real cost.
 */

const SLOTS = buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
const TEAMS = 6;
const ROUNDS = 6;

const CONFIG: LeagueConfig = {
  slots: SLOTS,
  weeks: Array.from({ length: 12 }, (_, i) => i + 1),
  playoffWeeks: [13, 14],
  playoffTeams: 4,
  scenarios: 40,
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
  for (let tier = 0; tier < 10; tier += 1) {
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

const rec = (r: { player: PlayerRisk }[]) => r.map((x) => x.player.id);

describe("leagueFingerprint separates leagues that are genuinely different", () => {
  const base = leagueFingerprint(CONFIG, 1);

  it("separates a superflex league from a single-quarterback one", () => {
    const superflex: LeagueConfig = {
      ...CONFIG,
      slots: buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1 }),
    };
    expect(leagueFingerprint(superflex, 1)).not.toBe(base);
  });

  it("separates slots that share an id but accept different positions", () => {
    // The collision the previous test does *not* catch, and the one that would actually
    // bite. `buildSlots` gives a superflex a different id from a flex, so an identity
    // built from ids alone happens to separate those two — but `LeagueConfig.slots` is an
    // arbitrary list, and a caller assembling slots by hand can easily produce the same
    // id with different eligibility. That must not share a memo, and nothing about the
    // slot's name says so.
    const permissive: LeagueConfig = {
      ...CONFIG,
      slots: SLOTS.map((slot) =>
        slot.id === "flex"
          ? { ...slot, eligiblePositions: ["QB", "RB", "WR", "TE"] }
          : slot,
      ),
    };
    expect(leagueFingerprint(permissive, 1)).not.toBe(base);
  });

  it("is not fooled by the order slots are listed in", () => {
    // Slot order is presentational. Two identical leagues must share a memo.
    const reordered: LeagueConfig = { ...CONFIG, slots: [...SLOTS].reverse() };
    expect(leagueFingerprint(reordered, 1)).toBe(base);
  });

  it("separates a different number of starting slots", () => {
    const threeWr: LeagueConfig = {
      ...CONFIG,
      slots: buildSlots({ QB: 1, RB: 2, WR: 3, TE: 1, FLEX: 1 }),
    };
    expect(leagueFingerprint(threeWr, 1)).not.toBe(base);
  });

  it("separates different playoff shapes", () => {
    expect(leagueFingerprint({ ...CONFIG, playoffTeams: 6 }, 1)).not.toBe(base);
    expect(leagueFingerprint({ ...CONFIG, playoffWeeks: [13, 14, 15] }, 1)).not.toBe(base);
  });

  it("separates different season lengths", () => {
    expect(
      leagueFingerprint({ ...CONFIG, weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, 1),
    ).not.toBe(base);
  });

  it("separates different simulation settings", () => {
    // Two scenario counts give genuinely different estimates of the same quantity.
    expect(leagueFingerprint({ ...CONFIG, scenarios: 80 }, 1)).not.toBe(base);
    expect(leagueFingerprint({ ...CONFIG, meanAbsenceWeeks: 2 }, 1)).not.toBe(base);
  });

  it("separates leagues whose weeks differ in identity, not just in count", () => {
    // A bye lands inside one league's schedule and outside another's, which is the exact
    // collision the objective exists to price. Recording only the count made playoffs in
    // weeks 15-17 and 14-16 the same problem.
    expect(
      leagueFingerprint({ ...CONFIG, playoffWeeks: [12, 13] }, 1),
    ).not.toBe(base);
    expect(
      leagueFingerprint(
        { ...CONFIG, weeks: Array.from({ length: 12 }, (_, i) => i + 2) },
        1,
      ),
    ).not.toBe(base);
  });

  it("separates different shortlist lengths", () => {
    // `candidateLimit` changes both how many recommendations come back and which, so an
    // answer computed for three must not be served to a request for ten.
    expect(leagueFingerprint(CONFIG, 1, 3)).not.toBe(leagueFingerprint(CONFIG, 1, 10));
  });

  it("separates different seeds", () => {
    expect(leagueFingerprint(CONFIG, 2)).not.toBe(base);
  });

  it("is stable for identical configuration", () => {
    expect(leagueFingerprint({ ...CONFIG, slots: [...SLOTS] }, 1)).toBe(base);
  });
});

describe("memoKey", () => {
  it("combines the league and the position", () => {
    const a = memoKey(CONFIG, 1, baseState());
    const b = memoKey(CONFIG, 1, baseState());
    expect(a).toBe(b);
  });

  it("changes when the position changes", () => {
    const later = baseState();
    later.teams[1].roster = [board()[0]];
    later.available = board().slice(1);
    expect(memoKey(CONFIG, 1, later)).not.toBe(memoKey(CONFIG, 1, baseState()));
  });

  it("changes when the league changes, at an identical position", () => {
    const superflex: LeagueConfig = {
      ...CONFIG,
      slots: buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1 }),
    };
    expect(memoKey(superflex, 1, baseState())).not.toBe(memoKey(CONFIG, 1, baseState()));
  });
});

describe("LruMemoStore", () => {
  it("returns what it stored", () => {
    const store = new LruMemoStore(4);
    expect(store.get("a")).toBeUndefined();
    store.set("a", []);
    expect(store.get("a")).toEqual([]);
  });

  it("evicts the least recently used, not the least recently written", () => {
    const store = new LruMemoStore(2);
    store.set("a", []);
    store.set("b", []);
    store.get("a"); // "a" is now the most recent
    store.set("c", []); // evicts "b"
    expect(store.get("a")).toBeDefined();
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
  });

  it("never exceeds its capacity", () => {
    const store = new LruMemoStore(3);
    for (let i = 0; i < 50; i += 1) store.set(`k${i}`, []);
    expect(store.size).toBe(3);
    expect(store.stats.evictions).toBe(47);
  });

  it("overwrites rather than duplicating an existing key", () => {
    const store = new LruMemoStore(2);
    store.set("a", []);
    store.set("a", []);
    expect(store.size).toBe(1);
  });

  it("counts hits and misses", () => {
    const store = new LruMemoStore(2);
    store.get("nope");
    store.set("a", []);
    store.get("a");
    expect(store.stats).toMatchObject({ hits: 1, misses: 1 });
  });

  it("refuses a capacity that cannot hold anything", () => {
    expect(() => new LruMemoStore(0)).toThrow();
  });
});

describe("recommendMemoized", () => {
  it("computes on a miss and serves the identical array on a hit", () => {
    // The guarantee that makes memoisation sound: the computation is a pure function of
    // the key, so a hit is not merely similar to recomputing, it is the same result.
    const store = new LruMemoStore(8);
    const state = baseState();

    const first = recommendMemoized(store, state, CONFIG, 42, 4);
    expect(first.cached).toBe(false);

    const second = recommendMemoized(store, state, CONFIG, 42, 4);
    expect(second.cached).toBe(true);
    expect(second.recommendations).toEqual(first.recommendations);

    const live = recommendByChampionship(canonicalizeState(state), CONFIG, 42, 4);
    expect(second.recommendations).toEqual(live);
  });

  it("hits across two different orderings of the same position", () => {
    // The point of canonicalisation: how a roster was assembled is not part of the
    // position, so the second arrangement must not pay to solve it again.
    const store = new LruMemoStore(8);
    const pool = board();

    const a = baseState();
    a.teams[1].roster = [pool[0], pool[3]];
    a.available = pool.filter((p) => p.id !== pool[0].id && p.id !== pool[3].id);
    recommendMemoized(store, a, CONFIG, 42, 4);

    const b = baseState();
    b.teams[1].roster = [pool[3], pool[0]];
    b.available = a.available;
    expect(recommendMemoized(store, b, CONFIG, 42, 4).cached).toBe(true);
  });

  it("does NOT serve a superflex answer to a single-quarterback league", () => {
    // The collision that would matter most in practice, since the slot counts match.
    const store = new LruMemoStore(8);
    const superflex: LeagueConfig = {
      ...CONFIG,
      slots: buildSlots({ QB: 1, RB: 2, WR: 2, TE: 1, SUPERFLEX: 1 }),
    };
    const state = baseState();

    const first = recommendMemoized(store, state, superflex, 42, 4);
    const second = recommendMemoized(store, state, CONFIG, 42, 4);

    expect(second.cached).toBe(false);
    // And the answers genuinely differ, so serving one for the other would be wrong,
    // not merely impure.
    expect(rec(second.recommendations)).not.toEqual(rec(first.recommendations));
  });

  it("does not serve a three-candidate answer to a request for twelve", () => {
    const store = new LruMemoStore(8);
    const state = baseState();
    const first = recommendMemoized(store, state, CONFIG, 42, 3);
    const second = recommendMemoized(store, state, CONFIG, 42, 12);
    expect(second.cached).toBe(false);
    expect(second.recommendations.length).toBeGreaterThan(first.recommendations.length);
  });

  it("does not serve an answer computed under a different seed", () => {
    const store = new LruMemoStore(8);
    const state = baseState();
    recommendMemoized(store, state, CONFIG, 1, 4);
    expect(recommendMemoized(store, state, CONFIG, 2, 4).cached).toBe(false);
  });

  it("does not serve an answer computed at a different scenario count", () => {
    const store = new LruMemoStore(8);
    const state = baseState();
    recommendMemoized(store, state, CONFIG, 42, 4);
    expect(
      recommendMemoized(store, state, { ...CONFIG, scenarios: 80 }, 42, 4)
        .cached,
    ).toBe(false);
  });

  it("does not serve an answer from a board that has since changed", () => {
    // A rebuilt board has different players on it, so an identical set of rosters is a
    // different problem.
    const store = new LruMemoStore(8);
    recommendMemoized(store, baseState(), CONFIG, 42, 4);

    const rebuilt = baseState();
    rebuilt.available = [...rebuilt.available, player("NEW", "WR", 15, 999)];
    expect(recommendMemoized(store, rebuilt, CONFIG, 42, 4).cached).toBe(false);
  });

  it("does not serve one team's answer to another team", () => {
    const store = new LruMemoStore(8);
    recommendMemoized(store, baseState(), CONFIG, 42, 4);
    const other = { ...baseState(), myTeamIndex: 2 };
    expect(recommendMemoized(store, other, CONFIG, 42, 4).cached).toBe(false);
  });

  it("recomputes after the entry has been evicted", () => {
    const store = new LruMemoStore(1);
    const a = baseState();
    const b = baseState();
    b.teams[1].roster = [board()[0]];
    b.available = board().slice(1);

    recommendMemoized(store, a, CONFIG, 42, 4);
    recommendMemoized(store, b, CONFIG, 42, 4); // evicts a
    expect(recommendMemoized(store, a, CONFIG, 42, 4).cached).toBe(false);
  });
});

describe("composed with speculation", () => {
  it("reuses a future that a previous pick already prepared", () => {
    // The two caches solve different halves: speculation prepares futures that have not
    // happened, the memo remembers positions that have. Composed, preparing the same
    // future twice costs nothing the second time.
    const store = new LruMemoStore(64);
    const state = baseState();
    const anticipated = anticipateStates(state, [{ team: 1 }], 40, createRng(1));

    precomputeRecommendations(state, anticipated, CONFIG, 42, {
      maxStates: 3,
      candidateLimit: 3,
      compute: memoizedCompute(store),
    });
    const afterFirst = { ...store.stats };
    expect(afterFirst.misses).toBeGreaterThan(0);

    precomputeRecommendations(state, anticipated, CONFIG, 42, {
      maxStates: 3,
      candidateLimit: 3,
      compute: memoizedCompute(store),
    });
    expect(store.stats.hits).toBeGreaterThan(afterFirst.hits);
    expect(store.stats.misses).toBe(afterFirst.misses);
  });

  it("produces the same cache whether or not a memo is used", () => {
    // Memoisation must be invisible in the output. If layering a store changed an answer,
    // the key would not be covering everything the computation reads.
    const state = baseState();
    const anticipated = anticipateStates(state, [{ team: 1 }], 30, createRng(2));
    const options = { maxStates: 2, candidateLimit: 3 } as const;

    const plain = precomputeRecommendations(state, anticipated, CONFIG, 42, options);
    const memoised = precomputeRecommendations(state, anticipated, CONFIG, 42, {
      ...options,
      compute: memoizedCompute(new LruMemoStore(64)),
    });
    expect(memoised.entries).toEqual(plain.entries);
  });
});
