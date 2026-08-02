import type { LeagueConfig } from "./season-sim";
import {
  type ChampionshipRecommendation,
  type DraftPolicyState,
  recommendByChampionship,
} from "./draft-policy";
import { canonicalizeState, stateSignature } from "./draft-speculation";

/**
 * Remembering positions that have already been solved.
 *
 * A draft position is a pure input: the same board, the same rosters, the same league
 * rules and the same seed give the same answer every time. So a position solved once never
 * needs solving again — and early-round positions repeat constantly, both within a league
 * and across every league drafting from the same board. The first three rounds of a
 * twelve-team PPR draft are close to stereotyped.
 *
 * ## What the key has to cover, and why that is the hard part
 *
 * A memo is only safe if the key captures everything the answer depends on. Getting that
 * wrong does not produce a slow tool, it produces a confidently wrong one — an answer
 * computed for somebody else's league, served as though it were yours.
 *
 * So the key is the league fingerprint *and* the state signature, and the fingerprint
 * covers every field of the configuration that can change a result: the starting slots and
 * their eligibility, the weeks played, the playoff shape, the scenario count, the injury
 * model, and the seed. Two leagues that differ in any of those are different problems, and
 * a superflex league must never be served a single-quarterback answer.
 *
 * The state signature covers the rosters, the remaining picks, and a digest of the pool —
 * see `draft-speculation.ts`.
 */

/**
 * Identity of the problem being solved, excluding the position itself.
 *
 * Slot eligibility is folded in rather than just slot count: `FLEX` accepting a
 * quarterback is a different league from one where it does not, and the two must not share
 * a memo. The seed is included because two seeds give genuinely different estimates of the
 * same quantity, and silently mixing them would make results irreproducible.
 */
export function leagueFingerprint(
  config: LeagueConfig,
  seed: number,
  candidateLimit?: number,
): string {
  // Sorted, because slot order does not change the answer — verified by computing a
  // recommendation against a reversed slot list and getting an identical result. Leaving
  // it order-sensitive would cost hits for nothing. Eligibility is folded in rather than
  // just the slot id: a caller assembling `LeagueConfig.slots` by hand can produce the
  // same id accepting different positions, and those are different leagues.
  const slots = [...config.slots]
    .map((slot) => `${slot.id}:${[...slot.eligiblePositions].sort().join("/")}`)
    .sort()
    .join(",");
  return [
    // Embedded rather than digested. `digestIds` is a 32-bit hash, and a collision here is
    // exactly the failure this fingerprint exists to prevent — a superflex answer served
    // to a single-quarterback league. The pool is digested because it is hundreds of ids
    // long; a slot list is a few dozen characters and saves nothing worth that risk.
    `slots=${slots}`,
    // Which weeks, not how many. A bye lands inside one league's schedule and outside
    // another's, and that is exactly the collision the objective exists to price — two
    // leagues with playoffs in weeks 15-17 and 14-16 are both "3" but are not the same
    // problem.
    `weeks=${config.weeks.join("-")}`,
    `po=${config.playoffTeams}/${config.playoffWeeks.join("-")}`,
    `scen=${config.scenarios}`,
    `absence=${config.meanAbsenceWeeks}`,
    `seed=${seed}`,
    // The shortlist length changes both how many recommendations come back and which,
    // so an answer computed for three candidates must not be served to a request for ten.
    `cand=${candidateLimit ?? "default"}`,
  ].join(";");
}

/** The full memo key: which problem, and which position within it. */
export function memoKey(
  config: LeagueConfig,
  seed: number,
  state: DraftPolicyState,
  candidateLimit?: number,
): string {
  return `${leagueFingerprint(config, seed, candidateLimit)}||${stateSignature(
    canonicalizeState(state),
  )}`;
}

export interface MemoStore {
  get(key: string): ChampionshipRecommendation[] | undefined;
  set(key: string, value: ChampionshipRecommendation[]): void;
  readonly size: number;
}

export interface MemoStats {
  hits: number;
  misses: number;
  /** Entries evicted because the store was full. */
  evictions: number;
}

/**
 * A bounded in-memory store, least-recently-used first out.
 *
 * Bounded because a draft board of several hundred players generates unboundedly many
 * positions, and a process that remembers all of them eventually falls over. LRU because
 * the positions worth keeping are the ones being revisited, which is exactly what recency
 * measures.
 */
export class LruMemoStore implements MemoStore {
  private readonly entries = new Map<string, ChampionshipRecommendation[]>();
  readonly stats: MemoStats = { hits: 0, misses: 0, evictions: 0 };

  constructor(private readonly capacity = 512) {
    if (capacity < 1) throw new Error("memo capacity must be at least 1");
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): ChampionshipRecommendation[] | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      this.stats.misses += 1;
      return undefined;
    }
    // Re-insert so this key becomes the most recently used. `Map` preserves insertion
    // order, which is what makes the oldest key the first one iteration yields.
    this.entries.delete(key);
    this.entries.set(key, value);
    this.stats.hits += 1;
    // Copied on the way out, and on the way in below. The cached array is handed to the
    // worker and on to the UI, and a caller that sorts or splices what it was given would
    // otherwise be editing the cache in place — every later hit returning the mutated
    // ranking until eviction, with nothing to suggest the answer had changed.
    return [...value];
  }

  set(key: string, value: ChampionshipRecommendation[]): void {
    if (this.entries.has(key)) this.entries.delete(key);
    // The array is copied and each recommendation frozen. Copying the array alone stops a
    // caller reordering the cache; it does not stop one writing to a recommendation object,
    // which is shared by reference with every future hit.
    this.entries.set(key, value.map((r) => Object.freeze({ ...r })));
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
      this.stats.evictions += 1;
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface MemoizedResult {
  recommendations: ChampionshipRecommendation[];
  /** True when the answer came from the store rather than being computed. */
  cached: boolean;
  key: string;
}

/**
 * Recommends, consulting the store first and populating it on a miss.
 *
 * The stored value is returned as-is on a hit, which is sound precisely because the key
 * covers every input: the computation is deterministic, so recomputing would produce the
 * identical array. `draft-memo.test.ts` asserts that rather than assuming it.
 */
export function recommendMemoized(
  store: MemoStore,
  state: DraftPolicyState,
  config: LeagueConfig,
  seed: number,
  candidateLimit?: number,
): MemoizedResult {
  const key = memoKey(config, seed, state, candidateLimit);
  const hit = store.get(key);
  if (hit !== undefined) return { recommendations: hit, cached: true, key };

  const recommendations = recommendByChampionship(
    canonicalizeState(state),
    config,
    seed,
    candidateLimit,
  );
  store.set(key, recommendations);
  // A miss hands back the same guarantees a hit does — a separate array of frozen
  // recommendations. Returning the raw computed array meant the first caller held
  // references the cache also held, and only later callers were protected. Not read back
  // through `store.get`, which would count a hit that did not happen.
  return {
    recommendations: recommendations.map((r) => Object.freeze({ ...r })),
    cached: false,
    key,
  };
}

/**
 * A `compute` function for `precomputeRecommendations`, backed by a store.
 *
 * Speculation and memoisation solve different halves of the same problem — one prepares
 * futures that have not happened, the other remembers positions that have. Composed, a
 * future prepared for an earlier pick, or solved in somebody else's league, is free.
 */
export function memoizedCompute(store: MemoStore) {
  return (
    state: DraftPolicyState,
    config: LeagueConfig,
    seed: number,
      candidateLimit?: number,
  ): ChampionshipRecommendation[] =>
    recommendMemoized(store, state, config, seed, candidateLimit)
      .recommendations;
}
