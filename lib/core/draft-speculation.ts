import { type Rng, standardNormal } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import type { LeagueConfig } from "./season-sim";
import { DEFAULT_ADP_STDEV, UNRANKED_ADP_PADDING } from "./draft";
import {
  type ChampionshipRecommendation,
  type DraftPolicyState,
  type DraftTeam,
  recommendByChampionship,
} from "./draft-policy";

/**
 * Speculative precomputation between your picks.
 *
 * A recommendation costs on the order of a second, which is affordable against a draft
 * clock but only if it does not begin when the clock does. The obvious idea — start early,
 * because you know when you pick — does not work: you know the pick *number*, not the
 * state at it. Who is available depends on what the teams in front of you do, and their
 * rosters feed the simulation directly.
 *
 * So instead of precomputing *the* answer, this precomputes answers for the futures most
 * likely to happen. Opponent picks between now and your turn are sampled from the same ADP
 * dispersion the survival model already uses, the resulting states are deduplicated, and
 * the most frequent ones are evaluated in order of likelihood until the budget runs out.
 * When your turn arrives the real state is looked up.
 *
 * ## The contract, which is the whole point
 *
 * A cached answer is served **only when the cached state is identical to the real one**,
 * and identical is checked rather than assumed. The signature covers everything the
 * recommendation reads, and states are canonicalised first so that two orderings of the
 * same roster cannot masquerade as different futures — roster order is meaningless in
 * fantasy but it drives the random draws, so without canonicalisation an identical
 * position could miss, and worse, a differently-ordered one could be treated as a match
 * and return different numbers.
 *
 * Anything else is reported as a miss. A near-match is never quietly served as though it
 * were exact: the outcome is always one of `exact`, `approximate`, or `miss`, and an
 * approximate answer carries what differs. Serving a stale recommendation as a fresh one
 * would be worse than being slow, because the whole product is a claim about a specific
 * board.
 */

/** Canonical form of a state: rosters and pool sorted, so order cannot vary the result. */
export interface CanonicalState {
  teams: DraftTeam[];
  myTeamIndex: number;
  available: PlayerRisk[];
  rosterSize: number;
}

/**
 * Puts a state into a form where equal positions are literally equal.
 *
 * Roster order carries no meaning in fantasy, but it determines the order random draws are
 * consumed in, so the same roster in a different order scores differently. Sorting first
 * makes the simulation a function of the position rather than of how the position was
 * assembled, which is both correct and what allows a cache hit to be exact.
 */
export function canonicalizeState(state: DraftPolicyState): CanonicalState {
  const byId = (a: PlayerRisk, b: PlayerRisk) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    teams: state.teams.map((team) => ({
      ...team,
      roster: [...team.roster].sort(byId),
      remainingPicks: [...team.remainingPicks].sort((a, b) => a - b),
    })),
    myTeamIndex: state.myTeamIndex,
    available: [...state.available].sort(byId),
    rosterSize: state.rosterSize,
  };
}

/**
 * A short, order-independent digest of a set of ids. FNV-1a, 32-bit.
 *
 * Used so a signature can include the whole remaining pool without being enormous. A
 * collision would produce a wrong cache hit, which is why the pool is digested rather than
 * truncated — truncation collides systematically, a hash does not.
 */
export function digestIds(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2c;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Everything the recommendation depends on, as a comparable string.
 *
 * Deliberately includes each team's roster *separately* rather than the set of drafted
 * players. Two futures in which the same players are gone but distributed differently are
 * genuinely different: opponents field their own lineups, so who holds a player changes
 * the simulation. Collapsing them would produce cache hits that are not hits.
 *
 * The available pool is digested in as well. Within a single draft it is implied by the
 * rosters, but a signature is also used to recognise a position seen in an *earlier*
 * draft, and a board rebuilt against a newer market has different players on it. Without
 * the pool, an answer computed for last week's board would be served for this one.
 */
export function stateSignature(state: CanonicalState): string {
  const teams = state.teams
    .map((team, index) => {
      const ids = team.roster.map((p) => p.id).join(",");
      const picks = team.remainingPicks.join(",");
      return `${index}:${ids}|${picks}`;
    })
    .join(";");
  const pool = digestIds(state.available.map((p) => p.id));
  return `me=${state.myTeamIndex};size=${state.rosterSize};pool=${pool};${teams}`;
}

/** A future worth precomputing, with how often it came up in sampling. */
export interface AnticipatedState {
  state: CanonicalState;
  signature: string;
  /** Share of sampled futures that produced this exact state. */
  probability: number;
}

export interface SpeculativeEntry {
  signature: string;
  probability: number;
  recommendations: ChampionshipRecommendation[];
}

export interface SpeculativeCache {
  /** Signature of the state the cache was built from, so a stale cache is detectable. */
  builtFrom: string;
  entries: SpeculativeEntry[];
}

export type ResolutionKind = "exact" | "approximate" | "miss";

export interface Resolution {
  kind: ResolutionKind;
  recommendations: ChampionshipRecommendation[];
  /**
   * Set on an approximate hit: the players the cached state disagreed about. Present so a
   * caller can show what it is trading accuracy for, rather than being told a number is
   * fresh when it is not.
   */
  differences?: { missingFromCache: string[]; extraInCache: string[] };
}

/**
 * Samples one plausible future: who the teams in front of us take before our turn.
 *
 * Draft slots are drawn as `adp + N(0, stdev)`, which is exactly the model
 * `survivalProbability` integrates. Using anything else here would make the futures we
 * prepare for inconsistent with the probabilities we quote.
 */
export function sampleFuture(
  state: CanonicalState,
  picksBeforeMyTurn: readonly { team: number }[],
  rng: Rng,
  unrankedPadding = UNRANKED_ADP_PADDING,
): CanonicalState {
  const maxAdp = state.available.reduce(
    (max, p) => (p.adp != null && p.adp > max ? p.adp : max),
    0,
  );
  const perceived = new Map<string, number>();
  for (const player of state.available) {
    const adp = player.adp ?? maxAdp + unrankedPadding;
    const stdev = Math.max(player.adpStdev ?? DEFAULT_ADP_STDEV, 0.5);
    perceived.set(player.id, adp + stdev * standardNormal(rng));
  }

  const order = [...state.available].sort(
    (a, b) => (perceived.get(a.id) ?? 0) - (perceived.get(b.id) ?? 0),
  );

  const teams = state.teams.map((team) => ({ ...team, roster: [...team.roster] }));
  let cursor = 0;
  for (const { team } of picksBeforeMyTurn) {
    if (cursor >= order.length) break;
    const player = order[cursor];
    cursor += 1;
    teams[team].roster.push(player);
    teams[team] = {
      ...teams[team],
      remainingPicks: teams[team].remainingPicks.slice(1),
    };
  }

  const taken = new Set(order.slice(0, cursor).map((p) => p.id));
  return canonicalizeState({
    teams,
    myTeamIndex: state.myTeamIndex,
    available: state.available.filter((p) => !taken.has(p.id)),
    rosterSize: state.rosterSize,
  });
}

/**
 * The futures most likely to be the real one, most likely first.
 *
 * Deduplicated by signature, so `probability` is the share of sampled futures that landed
 * on exactly that state — which is also the chance that precomputing it pays off.
 */
export function anticipateStates(
  state: DraftPolicyState,
  picksBeforeMyTurn: readonly { team: number }[],
  samples: number,
  rng: Rng,
): AnticipatedState[] {
  const canonical = canonicalizeState(state);
  if (picksBeforeMyTurn.length === 0) {
    return [{ state: canonical, signature: stateSignature(canonical), probability: 1 }];
  }

  const counts = new Map<string, { state: CanonicalState; count: number }>();
  for (let i = 0; i < samples; i += 1) {
    const future = sampleFuture(canonical, picksBeforeMyTurn, rng);
    const signature = stateSignature(future);
    const existing = counts.get(signature);
    if (existing) existing.count += 1;
    else counts.set(signature, { state: future, count: 1 });
  }

  return [...counts.entries()]
    .map(([signature, { state: s, count }]) => ({
      state: s,
      signature,
      probability: count / samples,
    }))
    .sort((a, b) => b.probability - a.probability || (a.signature < b.signature ? -1 : 1));
}

/**
 * Precomputes recommendations for the likeliest futures, within a budget.
 *
 * `shouldContinue` is consulted between states so the caller can stop on a clock rather
 * than on a count — the budget that matters is how long until the pick, and that is the
 * caller's to know.
 */
export function precomputeRecommendations(
  state: DraftPolicyState,
  anticipated: readonly AnticipatedState[],
  config: LeagueConfig,
  seed: number,
  createRng: (seed: number) => Rng,
  options: {
    maxStates?: number;
    candidateLimit?: number;
    shouldContinue?: () => boolean;
    /**
     * How a single state is solved.
     *
     * Injectable so a memo can be layered underneath: a future we prepared for last pick,
     * or one another league already solved, costs nothing to prepare again. Passed in
     * rather than imported so this module stays independent of the store — the memo needs
     * this module's canonicalisation, and the dependency cannot run both ways.
     */
    compute?: (
      state: CanonicalState,
      config: LeagueConfig,
      seed: number,
      createRng: (seed: number) => Rng,
      candidateLimit?: number,
    ) => ChampionshipRecommendation[];
  } = {},
): SpeculativeCache {
  const {
    maxStates = 8,
    candidateLimit,
    shouldContinue,
    compute = recommendByChampionship,
  } = options;
  const entries: SpeculativeEntry[] = [];

  for (const candidate of anticipated.slice(0, Math.max(maxStates, 0))) {
    if (shouldContinue !== undefined && !shouldContinue()) break;
    entries.push({
      signature: candidate.signature,
      probability: candidate.probability,
      recommendations: compute(candidate.state, config, seed, createRng, candidateLimit),
    });
  }

  return { builtFrom: stateSignature(canonicalizeState(state)), entries };
}

/**
 * Looks the real state up, and says honestly what it found.
 *
 * An exact match returns the cached answer, which is the same answer computing live would
 * produce because the inputs are identical and the computation is deterministic given the
 * seed. Anything else is labelled. Nothing here silently substitutes one board for
 * another.
 */
export function resolveFromCache(
  cache: SpeculativeCache,
  actual: DraftPolicyState,
): Resolution {
  const canonical = canonicalizeState(actual);
  const signature = stateSignature(canonical);

  const exact = cache.entries.find((entry) => entry.signature === signature);
  if (exact !== undefined) {
    return { kind: "exact", recommendations: exact.recommendations };
  }

  // A near miss is still useful, but only if the caller is told. The comparison is on the
  // players actually available, because that is what decides which candidate is taken.
  const actualIds = new Set(canonical.available.map((p) => p.id));
  let best: { entry: SpeculativeEntry; overlap: number; diff: Resolution["differences"] } | null =
    null;

  for (const entry of cache.entries) {
    const cachedIds = new Set(
      entry.recommendations.map((r) => r.player.id).filter((id) => id.length > 0),
    );
    if (cachedIds.size === 0) continue;
    // Every recommendation the cache would offer must still be on the board; if one has
    // been taken, that cached ranking is answering a question about a player who is gone.
    const missingFromCache = [...cachedIds].filter((id) => !actualIds.has(id));
    const overlap = cachedIds.size - missingFromCache.length;
    if (missingFromCache.length > 0) continue;
    if (best === null || overlap > best.overlap) {
      best = {
        entry,
        overlap,
        diff: { missingFromCache, extraInCache: [] },
      };
    }
  }

  if (best !== null) {
    return {
      kind: "approximate",
      recommendations: best.entry.recommendations,
      differences: best.diff,
    };
  }

  return { kind: "miss", recommendations: [] };
}

/**
 * The whole flow: serve from cache when the state matches, otherwise compute.
 *
 * `allowApproximate` defaults to false. The safe behaviour is to pay for a correct answer,
 * and a caller who would rather have a slightly stale one instantly has to ask.
 */
export function recommendWithCache(
  cache: SpeculativeCache | null,
  actual: DraftPolicyState,
  config: LeagueConfig,
  seed: number,
  createRng: (seed: number) => Rng,
  options: { candidateLimit?: number; allowApproximate?: boolean } = {},
): Resolution {
  if (cache !== null) {
    const resolved = resolveFromCache(cache, actual);
    if (resolved.kind === "exact") return resolved;
    if (resolved.kind === "approximate" && options.allowApproximate === true) {
      return resolved;
    }
  }
  return {
    kind: "miss",
    recommendations: recommendByChampionship(
      canonicalizeState(actual),
      config,
      seed,
      createRng,
      options.candidateLimit,
    ),
  };
}
