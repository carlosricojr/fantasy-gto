import { type RosterSlot, solveLineup } from "./optimizer";
import type { PlayerRisk } from "./roster-utility";
import {
  type LeagueConfig,
  type TeamOutcome,
  championshipProbability,
  sampleTeamWeeklyScores,
} from "./season-sim";

/**
 * Choosing a pick.
 *
 * The objective is the probability of winning the league, evaluated by playing the season
 * out — see `season-sim.ts` for why that is the right target and not expected points.
 * Everything that used to be a weighted term is now a consequence: a bye collision, a
 * fragile starter, an empty slot, and a boom-or-bust profile all change championship odds
 * through the simulation rather than through a constant someone picked.
 *
 * ## What is guaranteed, and what is not
 *
 * Exact optimality is unavailable. A draft is a sequential game against opponents who
 * react to what you do, over a state space exponential in the player pool. Any claim of
 * global optimality here would be false.
 *
 * Three real guarantees are available and this implements the first two:
 *
 *  1. **The inner problems are exact.** The best legal lineup for a week is a
 *     maximum-weight matching, solved exactly. Standings and the bracket are played out
 *     rather than approximated.
 *  2. **One step of policy improvement, estimated by simulation.** Every candidate is
 *     evaluated by *committing to it and then finishing the draft under an explicit base
 *     policy*, and the best is taken. The policy improvement theorem is what makes this
 *     the right shape — but the theorem needs the base policy's exact action values, and
 *     these are Monte Carlo estimates over `config.scenarios` draws. Sampling noise can
 *     put a candidate on top whose true championship probability is below the base
 *     policy's own choice, which is why every recommendation carries a standard error and
 *     why candidates inside it are reported as tied rather than ranked. The guarantee
 *     belongs to the theorem; this is an estimate of it.
 *  3. **A computable optimality gap** via a perfect-information relaxation, which would
 *     bound how much better any policy could do. Not implemented; noted so its absence is
 *     visible rather than implied.
 *
 * ## Where the approximations are
 *
 * The base policy is need-aware best-available, which is a reasonable stand-in for how the
 * remaining picks go but is not how anyone actually drafts. Opponents' completions are
 * computed once from the baseline and reused across candidates, because their behaviour
 * barely depends on which player *we* take — one player fewer on a board of hundreds. That
 * is an approximation, and it is what makes evaluating candidates affordable.
 */

export interface DraftTeam {
  id: string;
  name: string;
  roster: PlayerRisk[];
  /** Overall pick numbers this team still owns, ascending. */
  remainingPicks: number[];
}

export interface DraftPolicyState {
  teams: DraftTeam[];
  /** Index into `teams` of the team being advised. */
  myTeamIndex: number;
  available: PlayerRisk[];
  /** Total roster size, starters plus bench. */
  rosterSize: number;
}

export interface ChampionshipRecommendation {
  player: PlayerRisk;
  /** Championship probability if this player is taken and the draft finishes normally. */
  championshipProbability: number;
  /** Change against taking whatever the base policy would have taken. */
  deltaVsBaseline: number;
  playoffProbability: number;
  expectedPoints: number;
  /**
   * Standard error on the championship estimate.
   *
   * Reported because it is frequently larger than the gap between the top few candidates.
   * A title is roughly a one-in-twelve event, so distinguishing 16.7% from 15.8% needs
   * far more scenarios than a draft clock allows — and presenting an ordering as though
   * it were resolved when it is not would be exactly the kind of false precision this
   * project exists to avoid. Callers should treat candidates within a couple of standard
   * errors as tied and fall back on the tiebreaks below.
   */
  standardError: number;
  /**
   * True when this candidate's title odds are inside sampling noise of the leader's.
   *
   * Without it the ordering reads as broken: a candidate showing 12.3% can rank above one
   * showing 14.7% because the two are tied and the smoother playoff signal decided
   * between them. Saying so is the honest presentation; silently sorting by a hidden key
   * is not.
   */
  tiedWithLeader: boolean;
}

/**
 * How many candidates are evaluated by simulating the league.
 *
 * Every evaluation replays a season, so the field has to be narrowed first. Ten is enough
 * that the right pick is essentially always inside it — the prefilter is a genuine
 * value estimate, not a guess — while keeping a decision inside the time a draft allows.
 */
export const CHAMPIONSHIP_CANDIDATES = 10;

/**
 * How many of the best available players the base policy considers at each pick.
 *
 * The base policy takes the best available, and a player outside the top of the board by
 * raw scoring cannot be that. Widening this does not change the completion; narrowing it
 * far would, because a position run can push a genuinely good player down the list.
 */
export const BASE_POLICY_WIDTH = 40;

/**
 * Marginal starting-lineup value, used only to narrow the field.
 *
 * Deliberately cheap and deliberately not the objective. It ranks by what a player adds to
 * the best legal lineup right now, which is a good enough filter to find the handful of
 * picks worth simulating properly.
 */
function toCompetitor(p: PlayerRisk) {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    projectedPoints: p.weeklyMean * p.availability,
    availability: "active" as const,
  };
}

function prefilterValue(
  roster: readonly PlayerRisk[],
  candidate: PlayerRisk,
  slots: readonly RosterSlot[],
  baseline?: number,
): number {
  // `baseline` is the roster's own lineup value, which does not depend on the candidate.
  // Solving it once per pick rather than once per contender halves the rollout.
  const before = baseline ?? solveLineup(slots, roster.map(toCompetitor)).totalPoints;
  const after = solveLineup(
    slots,
    [...roster, candidate].map(toCompetitor),
  ).totalPoints;
  // A player who does not crack the lineup still has worth as depth; the tiny tiebreak
  // keeps the filter from discarding every bench candidate before the objective is
  // consulted, which is where depth is actually priced.
  return after - before + candidate.weeklyMean * candidate.availability * 1e-3;
}

/**
 * The base policy: take the best available by marginal starting value.
 *
 * Explicit because the improvement guarantee is relative to it. A vague or hidden base
 * policy would make "no worse than the base policy" an empty statement.
 */
export function basePolicyPick(
  roster: readonly PlayerRisk[],
  available: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
): PlayerRisk | null {
  // Only the strongest players on the board can win a base-policy pick, so the rest are
  // not evaluated. Without this the completion solves a lineup for every one of several
  // hundred players at each of a hundred-odd remaining picks, for every candidate — which
  // was the whole cost of a recommendation.
  const contenders =
    available.length <= BASE_POLICY_WIDTH
      ? available
      : [...available]
          .sort((a, b) => b.weeklyMean * b.availability - a.weeklyMean * a.availability)
          .slice(0, BASE_POLICY_WIDTH);

  const baseline = solveLineup(slots, roster.map(toCompetitor)).totalPoints;
  let best: PlayerRisk | null = null;
  let bestValue = -Infinity;
  for (const candidate of contenders) {
    const value = prefilterValue(roster, candidate, slots, baseline);
    if (value > bestValue) {
      bestValue = value;
      best = candidate;
    }
  }
  return best;
}

/**
 * Finishes the draft from the current state under the base policy.
 *
 * Picks are taken in overall order across every team, so a team's choices depend on what
 * the teams picking before it have already taken — which is the part a per-team
 * simulation would get wrong.
 */
/**
 * Completes one team's roster, given what the rest of the league is expected to take.
 *
 * Evaluating a candidate only ever reads our own finished roster — the opponents come from
 * the baseline rollout, which is computed once. Rolling the whole league forward per
 * candidate therefore did twelve times the necessary work and discarded eleven twelfths of
 * it, and that was the dominant cost of a recommendation.
 *
 * The approximation this shares with the cached opponent scores: if we take a player an
 * opponent would have taken, that opponent's alternative is not recomputed. One player out
 * of a board of hundreds cannot move a season simulation.
 */
export function completeOwnRoster(
  roster: readonly PlayerRisk[],
  ownRemainingPicks: number,
  pool: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
  forcedFirstPick: PlayerRisk | null,
  rosterSize?: number,
): PlayerRisk[] {
  const out = [...roster];
  const taken = new Set(out.map((p) => p.id));
  let available = pool.filter((p) => !taken.has(p.id));

  let picksLeft = ownRemainingPicks;
  // The forced pick goes through both bounds the loop below enforces. Seating it
  // unconditionally is the same failure the loop guard exists to prevent, on the one path
  // that bypasses the loop: a roster already at `rosterSize` came back one player longer
  // than every opponent, and `ownRemainingPicks === 0` seated a candidate anyway and left
  // `picksLeft` at -1.
  const roomForForced =
    picksLeft > 0 && (rosterSize === undefined || out.length < rosterSize);
  if (forcedFirstPick !== null && roomForForced) {
    out.push(forcedFirstPick);
    taken.add(forcedFirstPick.id);
    available = available.filter((p) => p.id !== forcedFirstPick.id);
    picksLeft -= 1;
  }

  for (let i = 0; i < picksLeft; i += 1) {
    // Bounded by the roster as well as by the picks, the way `completeDraft` bounds every
    // opponent. The two limits are equal in an ordinary draft, but they are supplied
    // independently, and a team holding more picks than seats would otherwise be simulated
    // with a longer roster than anyone it plays — which lifts every candidate's title odds
    // together and reads as a better board rather than as a bug.
    if (rosterSize !== undefined && out.length >= rosterSize) break;
    const pick = basePolicyPick(out, available, slots);
    if (pick === null) break;
    out.push(pick);
    available = available.filter((p) => p.id !== pick.id);
  }
  return out;
}

export function completeDraft(
  state: DraftPolicyState,
  slots: readonly RosterSlot[],
  forcedFirstPick: PlayerRisk | null,
): PlayerRisk[][] {
  const rosters = state.teams.map((t) => [...t.roster]);
  const taken = new Set(rosters.flat().map((p) => p.id));
  if (forcedFirstPick !== null) {
    rosters[state.myTeamIndex].push(forcedFirstPick);
    taken.add(forcedFirstPick.id);
  }

  // Every remaining pick in the draft, in order, tagged with the team that owns it.
  const order: Array<{ pick: number; team: number }> = [];
  state.teams.forEach((team, index) => {
    for (const pick of team.remainingPicks) order.push({ pick, team: index });
  });
  order.sort((a, b) => a.pick - b.pick);

  let pool = state.available.filter((p) => !taken.has(p.id));
  for (const { team } of order) {
    if (rosters[team].length >= state.rosterSize) continue;
    if (pool.length === 0) break;
    const pick = basePolicyPick(rosters[team], pool, slots);
    if (pick === null) break;
    rosters[team].push(pick);
    pool = pool.filter((p) => p.id !== pick.id);
  }
  return rosters;
}

/**
 * Ranks candidate picks by the championship probability they lead to.
 *
 * Every candidate is judged against identical scenarios: `seed` is passed unchanged into
 * `sampleTeamWeeklyScores` for each one, and each player's stream is derived from his own
 * id, so the same player draws the same numbers whichever candidate roster he sits in.
 * Without that the differences between candidates — often a fraction of a percentage
 * point — would be buried in sampling noise.
 */
export function recommendByChampionship(
  state: DraftPolicyState,
  config: LeagueConfig,
  seed: number,
  candidateLimit = CHAMPIONSHIP_CANDIDATES,
): ChampionshipRecommendation[] {
  const me = state.teams[state.myTeamIndex];
  if (state.available.length === 0) return [];

  // Narrow the field cheaply, then judge what is left properly.
  // The roster's own lineup value does not depend on the candidate, so it is solved once
  // rather than once per player on a board of several hundred.
  const rosterBaseline = solveLineup(
    config.slots,
    me.roster.map(toCompetitor),
  ).totalPoints;
  const shortlist = [...state.available]
    .map((player) => ({
      player,
      filter: prefilterValue(me.roster, player, config.slots, rosterBaseline),
    }))
    .sort((a, b) => b.filter - a.filter)
    .slice(0, Math.max(candidateLimit, 1))
    .map((entry) => entry.player);

  // Opponents are completed once. Their behaviour changes by at most one player depending
  // on what we take, which cannot move a season simulation meaningfully, and recomputing
  // eleven rosters per candidate would dominate the cost.
  const baselineRosters = completeDraft(state, config.slots, null);
  const opponentRosters = baselineRosters.filter(
    (_, index) => index !== state.myTeamIndex,
  );
  const baselineOpponentScores = opponentRosters.map((roster, index) =>
    sampleTeamWeeklyScores(roster, config, seed + 1000 + index),
  );

  // What the rest of the league is expected to take, so our own rollout draws from the
  // board they leave behind rather than from the whole pool.
  const claimedByOthers = new Set(opponentRosters.flat().map((p) => p.id));
  const poolForUs = state.available.filter((p) => !claimedByOthers.has(p.id));
  const ownPicksLeft = me.remainingPicks.length;

  /**
   * Opponent scores for a world in which we take `forced`.
   *
   * The shortlist is drawn from `state.available`, and the baseline completion may already
   * have given one of those players to an opponent — so scoring a candidate against the
   * untouched baseline played him on two teams at once, adding his points to ours without
   * removing them from theirs. That inflates exactly the candidates an opponent wanted,
   * which is the ordering this function exists to get right.
   *
   * At most one opponent can hold him, since `completeDraft` never deals a player twice.
   * That opponent is re-completed with the next player the base policy would have taken,
   * because leaving the hole open would understate them by a whole roster spot — the
   * mirror of the same error.
   */
  const opponentScoresFor = (
    forced: PlayerRisk | null,
  ): { scores: number[][][]; replacementId: string | null } => {
    if (forced === null) {
      return { scores: baselineOpponentScores, replacementId: null };
    }
    const owner = opponentRosters.findIndex((roster) =>
      roster.some((p) => p.id === forced.id),
    );
    if (owner === -1) return { scores: baselineOpponentScores, replacementId: null };

    // `forced` is on an opponent roster in this branch, so `claimedByOthers` already kept
    // it out of `poolForUs` and no further filtering is needed here.
    const without = opponentRosters[owner].filter((p) => p.id !== forced.id);
    const replacement = basePolicyPick(without, poolForUs, config.slots);
    const scores = [...baselineOpponentScores];
    scores[owner] = sampleTeamWeeklyScores(
      replacement === null ? without : [...without, replacement],
      config,
      seed + 1000 + owner,
    );
    return { scores, replacementId: replacement?.id ?? null };
  };

  const evaluate = (forced: PlayerRisk | null): TeamOutcome => {
    const { scores, replacementId } = opponentScoresFor(forced);
    // The replacement has to leave our pool as well. Both selections run `basePolicyPick`
    // over the same `poolForUs`, so they routinely land on the same player — which put him
    // on the opponent's roster and ours in one scenario. That is the very double-count
    // this branch was added to remove, reintroduced one step later, and it fires only for
    // candidates an opponent held, which is precisely the set the branch exists for.
    const mineRoster = completeOwnRoster(
      me.roster,
      ownPicksLeft,
      replacementId === null
        ? poolForUs
        : poolForUs.filter((p) => p.id !== replacementId),
      config.slots,
      forced,
      state.rosterSize,
    );
    const mine = sampleTeamWeeklyScores(mineRoster, config, seed);
    return championshipProbability(mine, scores, config);
  };

  const baseline = evaluate(null);

  const ranked = shortlist
    .map((player) => {
      const outcome = evaluate(player);
      const p = outcome.championshipProbability;
      return {
        player,
        championshipProbability: p,
        deltaVsBaseline: round4(p - baseline.championshipProbability),
        playoffProbability: outcome.playoffProbability,
        expectedPoints: outcome.expectedPoints,
        standardError: round4(Math.sqrt((p * (1 - p)) / config.scenarios)),
      };
    })
    .map((r) => ({ ...r, tiedWithLeader: false }));

  if (ranked.length === 0) return ranked;

  // Partition against the true maximum rather than sorting with the tie rule directly.
  //
  // "Within noise, prefer the smoother signal" is not a transitive relation, so it is not
  // a valid comparator: with title odds of 12.0%, 14.0% and 16.0% at 600 scenarios, the
  // first two are tied, the last two are tied, but the first and third are not — a cycle.
  // `Array.prototype.sort` given a cycle may return anything, and it could put the 12%
  // candidate first while the 16% one placed third. Establishing the leader first makes
  // the comparison well-defined.
  const best = ranked.reduce((a, b) =>
    b.championshipProbability > a.championshipProbability ? b : a,
  );
  for (const entry of ranked) {
    entry.tiedWithLeader =
      best.championshipProbability - entry.championshipProbability <=
      best.standardError + entry.standardError;
  }

  // Everything statistically level with the leader is ordered by playoff probability,
  // which is roughly a coin flip rather than a one-in-twelve event and so resolves at the
  // sample sizes a draft clock allows. Everything below it is ordered on title odds.
  const bySmootherSignal = (a: ChampionshipRecommendation, b: ChampionshipRecommendation) =>
    b.playoffProbability - a.playoffProbability ||
    b.expectedPoints - a.expectedPoints ||
    (a.player.id < b.player.id ? -1 : 1);

  return ranked.sort((a, b) => {
    if (a.tiedWithLeader !== b.tiedWithLeader) return a.tiedWithLeader ? -1 : 1;
    if (a.tiedWithLeader) return bySmootherSignal(a, b);
    return (
      b.championshipProbability - a.championshipProbability || bySmootherSignal(a, b)
    );
  });
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
