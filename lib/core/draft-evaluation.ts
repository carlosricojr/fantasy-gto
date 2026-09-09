import { guardDraftCompletion, filledStarterCount } from "./draft-feasibility";
import { basePolicyPick, recommendByChampionship, trimDraftRoster, type DraftPolicyState } from "./draft-policy";
import { leagueUnfilledSlots } from "./draft-replacement";
import { solveLineup } from "./optimizer";
import { createRng, standardNormal } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import { sampleTeamWeeklyScores, simulateLeagueScenarios, type LeagueConfig } from "./season-sim";

export type EvaluationStrategy = "rollout" | "greedy" | "adp" | "roster-needs";
export type EvaluationOpponent = "strict-adp" | "needs-adp" | "noisy-adp";

function keyedSeed(seed: number, key: string): number {
  let hash = seed >>> 0;
  for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function adpOrder(pool: readonly PlayerRisk[], seed?: number): PlayerRisk[] {
  const price = (player: PlayerRisk) => (player.adp ?? 1e6) + (seed === undefined ? 0 :
    standardNormal(createRng(keyedSeed(seed, player.id))) * (player.adpStdev ?? 8));
  return [...pool].sort((a, b) => price(a) - price(b) || a.id.localeCompare(b.id));
}

/** Actual replay, separate from the policy's hypothetical completion. No outcomes enter it. */
export function replayDraftStrategy(
  initial: DraftPolicyState,
  config: LeagueConfig,
  strategy: EvaluationStrategy,
  opponent: EvaluationOpponent,
  selectionSeed: number,
  opponentSeed: number,
  candidateLimit = 10,
): { rosters: PlayerRisk[][]; picks: { overall: number; team: number; playerId: string }[]; missingStarters: number[] } {
  let state: DraftPolicyState = {
    ...initial, available: [...initial.available],
    teams: initial.teams.map((team) => ({ ...team, roster: [...team.roster], remainingPicks: [...team.remainingPicks].sort((a, b) => a - b) })),
  };
  const held = new Set(state.teams.flatMap((team) => team.roster.map((player) => player.id)));
  state.available = state.available.filter((player) => !held.has(player.id));
  const order = state.teams.flatMap((team, index) => team.remainingPicks.map((overall) => ({ overall, team: index }))).sort((a, b) => a.overall - b.overall);
  const picks: { overall: number; team: number; playerId: string }[] = [];
  for (const square of order) {
    const team = state.teams[square.team];
    const room = (team.draftRosterSize ?? state.rosterSize) - team.roster.length;
    if (room <= 0 || state.available.length === 0) {
      team.remainingPicks = team.remainingPicks.filter((pick) => pick !== square.overall);
      continue;
    }
    const nextOwn = team.remainingPicks[1] ?? Infinity;
    const opponentsBeforeNext = order.filter((pick) => pick.overall > square.overall && pick.overall < nextOwn && pick.team !== square.team).length;
    const turn = { picksRemaining: Math.min(room, team.remainingPicks.length), opponentsBeforeNext };
    const guard = guardDraftCompletion(team.roster, state.available, config.slots, turn.picksRemaining, opponentsBeforeNext);
    const mine = square.team === state.myTeamIndex;
    let pick: PlayerRisk | null | undefined;
    if (mine && strategy === "rollout") {
      pick = recommendByChampionship(state, config, selectionSeed, candidateLimit)[0]?.player;
    } else if (mine && strategy === "greedy") {
      pick = basePolicyPick(team.roster, state.available, config, leagueUnfilledSlots(
        state.teams.map((entry) => entry.roster.map((player) => ({ position: player.position, value: player.weeklyMean * player.availability }))), config.slots,
      ), turn);
    } else {
      let candidates = !mine && opponent === "strict-adp" ? state.available : guard.candidates;
      if ((mine && strategy === "roster-needs") || (!mine && opponent === "needs-adp")) {
        const filled = filledStarterCount(team.roster, config.slots);
        const needs = candidates.filter((player) => filledStarterCount([...team.roster, player], config.slots) > filled);
        if (needs.length > 0) candidates = needs;
      }
      pick = adpOrder(candidates, !mine && opponent === "noisy-adp" ? keyedSeed(opponentSeed, String(square.overall)) : undefined)[0];
    }
    if (pick == null || !state.available.some((player) => player.id === pick.id)) throw new Error(`No available policy pick at ${square.overall}.`);
    picks.push({ ...square, playerId: pick.id });
    team.roster.push(pick);
    team.remainingPicks = team.remainingPicks.filter((overall) => overall !== square.overall);
    state = { ...state, available: state.available.filter((player) => player.id !== pick.id) };
  }
  const rosters = state.teams.map((team) => trimDraftRoster(team.roster, state.rosterSize, config.slots));
  return { rosters, picks, missingStarters: rosters.map((roster) => config.slots.length - filledStarterCount(roster, config.slots)) };
}

/** Held-out draws share each player's world across owners and competing strategies. */
export function evaluateSimulatedDraft(rosters: readonly PlayerRisk[][], config: LeagueConfig, evaluationSeed: number) {
  return simulateLeagueScenarios(rosters.map((roster) => sampleTeamWeeklyScores(roster, config, evaluationSeed)), config);
}

/**
 * Independent outcome path: select starters using preseason means and known byes,
 * then read external realized PPR points. It never chooses a lineup on actual scores.
 * No hindsight injury replacement, waiver moves, or target-season projection updates.
 * Missing outcome identities are an error, not an invented zero.
 */
export function evaluateRecordedDraft(
  rosters: readonly PlayerRisk[][],
  config: LeagueConfig,
  actualByPlayer: ReadonlyMap<string, ReadonlyMap<number, number>>,
) {
  const weeks = [...config.weeks, ...config.playoffWeeks];
  const scores = rosters.map((roster) => [weeks.map((week) => {
    const eligible = roster.filter((player) => player.byeWeek !== week);
    const bonus = 1 + 2 * eligible.reduce((sum, player) => sum + Math.abs(player.weeklyMean * player.availability), 0);
    const starters = solveLineup(config.slots, eligible.map((player) => ({
      id: player.id, name: player.name, position: player.position, availability: "active" as const,
      projectedPoints: bonus + player.weeklyMean * player.availability,
    }))).assignments;
    return starters.reduce((sum, assignment) => {
      if (assignment.competitorId === null) return sum;
      const actual = actualByPlayer.get(assignment.competitorId);
      if (actual === undefined) throw new Error(`Unresolved external outcomes: ${assignment.competitorId}`);
      return sum + (actual.get(week) ?? 0);
    }, 0);
  })]);
  return simulateLeagueScenarios(scores, { ...config, scenarios: 1 });
}
