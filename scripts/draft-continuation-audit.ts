/** Frozen live-state diagnostics only. No provider I/O, picks, or historical holdout. */
import { cpus, platform, arch } from "node:os";
import fixture from "../tests/fixtures/sleeper-pick16-continuation.json";
import { basePolicyPick, completeDraft, recommendByChampionship, trimDraftRoster, type DraftPolicyState } from "../lib/core/draft-policy";
import { leagueUnfilledSlots } from "../lib/core/draft-replacement";
import type { PlayerRisk } from "../lib/core/roster-utility";
import { sampleTeamWeeklyScores, simulateLeague, type LeagueConfig } from "../lib/core/season-sim";
import { RECOMMEND_SEED, RECOMMEND_SCENARIOS, RECOMMEND_CANDIDATES } from "../lib/nfl/draft/engine-config";

const distributions: Record<string, number[]> = fixture.distributions;
const hydrate = (player: PlayerRisk): PlayerRisk => ({
  ...player,
  ...(distributions[player.position] === undefined ? {} : { weeklyOutcomeRatios: distributions[player.position] }),
});
const state: DraftPolicyState = {
  ...fixture.state,
  available: fixture.state.available.map(hydrate),
  teams: fixture.state.teams.map((team) => ({ ...team, roster: team.roster.map(hydrate) })),
};
const config: LeagueConfig = {
  ...fixture.config,
  scenarios: RECOMMEND_SCENARIOS,
  wireCover: new Map(fixture.config.wireCover as [string, number][]),
  unprojectedPositions: new Set(fixture.config.unprojectedPositions),
};
const choices = ["Drake London", "Garrett Wilson", "Malik Nabers"];
const seeds = [RECOMMEND_SEED, 7319, 7320];
const playerFor = (name: string) => state.available.find((player) => player.name === name)!;

// Same strict ADP opponent assumption as draft-mock. This deliberately different
// policy is a sensitivity check, not a fitted model of these actual managers.
function marketOpponentCompletion(forced: PlayerRisk): PlayerRisk[][] {
  const rosters = state.teams.map((team) => [...team.roster]);
  let pool = [...state.available];
  let firstOwn = true;
  const order = state.teams.flatMap((team, index) => team.remainingPicks.map((pick) => ({ pick, team: index }))).sort((a, b) => a.pick - b.pick);
  for (const square of order) {
    if (rosters[square.team].length >= (state.teams[square.team].draftRosterSize ?? state.rosterSize)) continue;
    const pick = square.team === state.myTeamIndex
      ? firstOwn ? pool.find((player) => player.id === forced.id) : basePolicyPick(
        rosters[square.team], pool, config,
        leagueUnfilledSlots(rosters.map((roster) => roster.map((player) => ({ position: player.position, value: player.weeklyMean * player.availability }))), config.slots),
      )
      : [...pool].sort((a, b) => (a.adp ?? Infinity) - (b.adp ?? Infinity) || a.id.localeCompare(b.id))[0];
    if (square.team === state.myTeamIndex) firstOwn = false;
    if (pick == null) throw new Error("Diagnostic continuation ran out of players.");
    rosters[square.team].push(pick);
    pool = pool.filter((player) => player.id !== pick.id);
  }
  return rosters;
}

console.log(JSON.stringify({ diagnosticOnly: true, provenance: fixture.provenance, runtime: process.version, platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model, scenarios: config.scenarios, candidates: RECOMMEND_CANDIDATES }));
for (const seed of seeds) {
  const start = performance.now();
  const advice = recommendByChampionship(state, config, seed, RECOMMEND_CANDIDATES);
  console.log(JSON.stringify({ kind: "production-policy", seed, milliseconds: Math.round(performance.now() - start), advice: advice.map((entry) => ({ name: entry.player.name, title: entry.championshipProbability, playoffs: entry.playoffProbability, delta: entry.deltaVsBaseline })) }));
}
for (const policy of ["responsive-greedy", "strict-adp-opponents"] as const) {
  for (const name of choices) {
    const rosters = policy === "responsive-greedy" ? completeDraft(state, config, playerFor(name)) : marketOpponentCompletion(playerFor(name));
    const ids = rosters.flat().map((player) => player.id);
    if (new Set(ids).size !== ids.length || rosters.some((roster, index) => roster.length !== (state.teams[index].draftRosterSize ?? state.rosterSize))) throw new Error("Invalid diagnostic draft accounting.");
    const outcomes = seeds.map((seed) => simulateLeague(rosters.map((roster, index) => sampleTeamWeeklyScores(trimDraftRoster(roster, state.rosterSize, config.slots), config, index === 0 ? seed : seed + 999 + index)), config)[0]);
    console.log(JSON.stringify({ kind: "opponent-policy-sensitivity", policy, name, ownRoster: rosters[0].map((player) => player.name), meanTitle: outcomes.reduce((sum, row) => sum + row.championshipProbability, 0) / seeds.length, meanPlayoffs: outcomes.reduce((sum, row) => sum + row.playoffProbability, 0) / seeds.length }));
  }
}
