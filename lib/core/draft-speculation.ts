import { type Rng, standardNormal } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import type { LeagueConfig } from "./season-sim";
import { UNRANKED_ADP_PADDING, adpDispersion } from "./draft";
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
 * So that two ways of writing down the same position produce the same signature, and
 * therefore hit the same cache entry. That is the whole of it, and it is worth being exact
 * because this used to claim more: that roster order determines the order random draws are
 * consumed, so the same roster in a different order scores differently. That stopped being
 * true when `playerStream` began keying each player's stream on his own id — order changes
 * nothing about the simulation, only about the signature. Asserted in the tests, so the
 * claim fails rather than rots if the streams ever change.
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
  return digestStrings(ids);
}

/**
 * Digest of a player's identity *and* the numbers the simulation reads from him.
 *
 * Keying a memo on ids alone is not enough: the board is rebuilt twice a day through the
 * preseason, and a rebuild that moves a player's price, variance, availability or ADP
 * without changing who is on the board produces an identical key. The cached answer is
 * then served for a board that no longer exists, labelled as cached.
 */
export function digestPlayers(players: readonly PlayerRisk[]): string {
  return digestStrings(players.map(playerFingerprint));
}

/**
 * One player's identity and every number the simulation reads from him.
 *
 * Extracted so the exact path and the approximate path agree on what "the same player"
 * means. They used to disagree: the signature digested these fields, while `contextOf`
 * recorded ids alone, so a rebuilt board was refused by one and accepted by the other.
 */
export function playerFingerprint(p: PlayerRisk): string {
  // Position is in here because it decides which slots a player is eligible for, and
  // preseason rebuilds do reclassify people — a tight end listed as a receiver changes
  // every recommendation while leaving every other field alone.
  return (
    `${p.id}:${p.position}:${p.weeklyMean.toFixed(4)}:${p.p10}:${p.p90}:` +
    `${p.byeWeek ?? "-"}:${p.availability.toFixed(4)}:${p.adp ?? "-"}:` +
    `${p.adpStdev ?? "-"}`
  );
}

function digestStrings(ids: readonly string[]): string {
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
 *
 * Each roster is digested by the same rule, rather than listed by id. Drafted players
 * drive the simulation as directly as undrafted ones — `sampleTeamWeeklyScores` reads
 * their projections from our roster and from every opponent's — so a rebuild that moved a
 * drafted player's numbers without changing who holds him produced an identical signature
 * and an exact hit computed against the old projections.
 */
export function stateSignature(state: CanonicalState): string {
  const teams = state.teams
    .map((team, index) => {
      const roster = digestPlayers(team.roster);
      const picks = team.remainingPicks.join(",");
      return `${index}:${roster}|${picks}`;
    })
    .join(";");
  const pool = digestPlayers(state.available);
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
  /**
   * The position this entry answers, kept so a near-match can be judged against the real
   * state rather than against its own output.
   *
   * Without it the approximate branch could only ask "are the players I would recommend
   * still on the board?", which is true of an answer computed for a different team, a
   * different roster size, or a different set of opponents. It served one manager's
   * ranking to another.
   */
  context: {
    myTeamIndex: number;
    rosterSize: number;
    rosterSignatures: string[];
    availableIds: string[];
    /**
     * Fingerprint per player the entry was computed against, drafted or not.
     *
     * The id lists above say who was where; these say what the numbers were. Without them
     * the approximate branch compared ids only, so a board rebuilt against a newer market
     * looked identical to it and its answer was served as an approximation of a position
     * it never described. The exact path already refused that; this is the same rule on
     * the other path.
     */
    fingerprints: Record<string, string>;
  };
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
    // `??` and `||` are indistinguishable here, and for a stated reason rather than a
    // failure to find one: they differ only when `adp` is 0, and `parseAdp` drops any row
    // with `adp <= 0` before it can reach a board (lib/sources/adp.ts). A caller could
    // still construct one by hand, which is why this is `??` — it is the form that stays
    // correct if that invariant ever moves.
    const adp = player.adp ?? maxAdp + unrankedPadding;
    const stdev = adpDispersion(player.adpStdev);
    perceived.set(player.id, adp + stdev * standardNormal(rng));
  }

  // Three things here cannot be told apart from their alternatives, for reasons rather than
  // for want of a fixture. `maxAdp` above is read only as a number, so which of several
  // players holding the largest ADP the reduce settles on is immaterial, and its seed can
  // be anything at or below the smallest ADP a board can carry — `parseAdp` drops rows at
  // or under zero. `standardNormal` is symmetric about zero, so subtracting the deviate
  // samples the same distribution as adding it: different individual futures under a given
  // seed, the same set of futures with the same probabilities. And the `?? 0` below never
  // fires, because every player in `available` was just written into `perceived`.
  const order = [...state.available].sort(
    (a, b) => (perceived.get(a.id) ?? 0) - (perceived.get(b.id) ?? 0),
  );

  const teams = state.teams.map((team) => ({ ...team, roster: [...team.roster] }));
  let cursor = 0;
  for (const { team } of picksBeforeMyTurn) {
    // `picksBeforeMyTurn` is caller-supplied and `anticipateStates` forwards it without
    // looking at it, so an out-of-range seat surfaced as `undefined.roster` from inside the
    // sampling loop rather than at the call site that supplied it.
    if (!Number.isInteger(team) || team < 0 || team >= teams.length) {
      throw new Error(
        `Pick attributed to seat index ${team}, which is not one of the ` +
          `${teams.length} teams in this draft.`,
      );
    }
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
    // Signatures are the map's own keys, so no two are equal and the `1` arm is only ever
    // reached as "greater". Replacing it with `0` leaves a comparator that is not
    // antisymmetric — the specification permits any result — and `Array.prototype.sort`
    // orders it correctly regardless, because it only ever needs the "strictly less"
    // signal. Same shape as `byId` above, and equally untestable.
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
      // Sealed on insert, the way the memo store seals what it holds. Both caches feed the
      // same worker and the same interface, and copying the array alone still lets a
      // caller write through a recommendation — or its `player` — into the entry.
      recommendations: compute(candidate.state, config, seed, candidateLimit).map((r) =>
        Object.freeze({ ...r, player: Object.freeze({ ...r.player }) }),
      ),
      context: contextOf(candidate.state),
    });
  }

  return { builtFrom: stateSignature(canonicalizeState(state)), entries };
}

/** The parts of a state a near-match has to agree about. */
function contextOf(state: CanonicalState): SpeculativeEntry["context"] {
  const fingerprints: Record<string, string> = {};
  for (const player of [...state.available, ...state.teams.flatMap((t) => t.roster)]) {
    fingerprints[player.id] = playerFingerprint(player);
  }
  return {
    myTeamIndex: state.myTeamIndex,
    rosterSize: state.rosterSize,
    rosterSignatures: state.teams.map(
      (team) => `${team.roster.map((p) => p.id).join(",")}|${team.remainingPicks.join(",")}`,
    ),
    availableIds: state.available.map((p) => p.id),
    fingerprints,
  };
}

/**
 * Whether two contexts describe the same board, for every player they both know about.
 *
 * The pools are *expected* to differ — that is what makes a hit approximate. What may not
 * differ is any player's numbers, because an entry computed against other projections is
 * not a nearby answer to this question, it is an answer to a different one.
 */
function sameBoard(
  a: SpeculativeEntry["context"],
  b: SpeculativeEntry["context"],
): boolean {
  for (const [id, fingerprint] of Object.entries(a.fingerprints)) {
    const other = b.fingerprints[id];
    if (other !== undefined && other !== fingerprint) return false;
  }
  return true;
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
    // Copied, like the memo store. Both caches hand their arrays to the same worker and
    // the same interface, and a caller that sorts or splices what it was given would
    // otherwise edit the cache in place — every later hit returning the mutated ranking.
    return { kind: "exact", recommendations: [...exact.recommendations] };
  }

  // A near miss is still useful, but only when it is a near miss about the *same
  // question*. An entry computed for another manager, another roster size, or a league
  // whose other teams drafted differently is not an approximation of this position — it is
  // an answer to a different one, and returning it because its recommendations happen to
  // still be available would be the worst failure this module can have.
  const here = contextOf(canonical);
  const actualIds = new Set(here.availableIds);
  let best: { entry: SpeculativeEntry; distance: number } | null = null;

  for (const entry of cache.entries) {
    const context = entry.context;
    if (context.myTeamIndex !== here.myTeamIndex) continue;
    if (context.rosterSize !== here.rosterSize) continue;
    // Our own roster and remaining picks must match exactly: they are the position.
    if (
      context.rosterSignatures[here.myTeamIndex] !==
      here.rosterSignatures[here.myTeamIndex]
    ) {
      continue;
    }
    // Refused when any player they both know about carries different numbers — see
    // `sameBoard`. This is issue #4: the signature covered the pool's numbers and this
    // path covered ids alone, so a rebuild slipped through here.
    if (!sameBoard(here, context)) continue;
    if (entry.recommendations.length === 0) continue;
    // Every player it would recommend must still be on the board.
    if (entry.recommendations.some((r) => !actualIds.has(r.player.id))) continue;

    // What is left may differ only in how the other teams' picks fell. Rank by how far
    // apart the two boards are, so the closest future wins.
    const cachedPool = new Set(context.availableIds);
    const distance =
      here.availableIds.filter((id) => !cachedPool.has(id)).length +
      context.availableIds.filter((id) => !actualIds.has(id)).length;

    if (best === null || distance < best.distance) best = { entry, distance };
  }

  if (best !== null) {
    const cachedPool = new Set(best.entry.context.availableIds);
    return {
      kind: "approximate",
      recommendations: [...best.entry.recommendations],
      differences: {
        // Available now but the cache thought gone, and vice versa. Genuinely populated,
        // unlike the earlier version where the filter above guaranteed both were empty.
        missingFromCache: here.availableIds.filter((id) => !cachedPool.has(id)),
        extraInCache: best.entry.context.availableIds.filter((id) => !actualIds.has(id)),
      },
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
      options.candidateLimit,
    ),
  };
}
