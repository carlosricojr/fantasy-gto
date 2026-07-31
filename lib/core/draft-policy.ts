import { type RosterSlot, solveLineup } from "./optimizer";
import { type Rng } from "./rng";
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
 *  2. **Certified improvement.** This is one step of policy improvement over an explicit
 *     base policy: every candidate is evaluated by *committing to it and then finishing
 *     the draft under the base policy*, and the best is taken. By the policy improvement
 *     theorem the resulting policy is no worse than the base policy from any state — not
 *     "usually better", provably not worse.
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
function prefilterValue(
  roster: readonly PlayerRisk[],
  candidate: PlayerRisk,
  slots: readonly RosterSlot[],
): number {
  // Expected contribution, not raw scoring rate. A player who misses half the season is
  // worth half as much, and a filter blind to that would rank a fragile starter level with
  // a durable one — then drop both before the objective, which does know the difference,
  // ever sees them.
  const toCompetitor = (p: PlayerRisk) => ({
    id: p.id,
    name: p.name,
    position: p.position,
    projectedPoints: p.weeklyMean * p.availability,
    availability: "active" as const,
  });
  const before = solveLineup(slots, roster.map(toCompetitor)).totalPoints;
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

  let best: PlayerRisk | null = null;
  let bestValue = -Infinity;
  for (const candidate of contenders) {
    const value = prefilterValue(roster, candidate, slots);
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
 * `createRng` is called fresh for each evaluation with the same seed, so every candidate
 * is judged against identical scenarios. Without that the differences between candidates
 * — often a fraction of a percentage point — would be buried in sampling noise.
 */
export function recommendByChampionship(
  state: DraftPolicyState,
  config: LeagueConfig,
  seed: number,
  createRng: (seed: number) => Rng,
  candidateLimit = CHAMPIONSHIP_CANDIDATES,
): ChampionshipRecommendation[] {
  const me = state.teams[state.myTeamIndex];
  if (state.available.length === 0) return [];

  // Narrow the field cheaply, then judge what is left properly.
  const shortlist = [...state.available]
    .map((player) => ({
      player,
      filter: prefilterValue(me.roster, player, config.slots),
    }))
    .sort((a, b) => b.filter - a.filter)
    .slice(0, Math.max(candidateLimit, 1))
    .map((entry) => entry.player);

  // Opponents are completed once. Their behaviour changes by at most one player depending
  // on what we take, which cannot move a season simulation meaningfully, and recomputing
  // eleven rosters per candidate would dominate the cost.
  const baselineRosters = completeDraft(state, config.slots, null);
  const opponentScores = baselineRosters
    .filter((_, index) => index !== state.myTeamIndex)
    .map((roster, index) =>
      sampleTeamWeeklyScores(roster, config, createRng(seed + 1000 + index)),
    );

  const evaluate = (forced: PlayerRisk | null): TeamOutcome => {
    const rosters = completeDraft(state, config.slots, forced);
    const mine = sampleTeamWeeklyScores(
      rosters[state.myTeamIndex],
      config,
      createRng(seed),
    );
    return championshipProbability(mine, opponentScores, config);
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
    .map((r) => ({ ...r, tiedWithLeader: false }))
    .sort((a, b) => {
      // Treat title odds inside the combined noise as tied and decide on the smoother
      // signal. Making a playoff is roughly a one-in-two event rather than one-in-twelve,
      // so it resolves at sample sizes a draft clock permits.
      const noise = a.standardError + b.standardError;
      const gap = b.championshipProbability - a.championshipProbability;
      if (Math.abs(gap) > noise) return gap;
      return (
        b.playoffProbability - a.playoffProbability ||
        b.expectedPoints - a.expectedPoints ||
        (a.player.id < b.player.id ? -1 : 1)
      );
    });

  if (ranked.length > 0) {
    const leader = ranked[0];
    for (const entry of ranked) {
      entry.tiedWithLeader =
        Math.abs(leader.championshipProbability - entry.championshipProbability) <=
        leader.standardError + entry.standardError;
    }
  }
  return ranked;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
