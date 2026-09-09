/** Offline paired decision audit. No target outcomes enter any draft policy. */
import { cpus } from "node:os";
import { pickOwnership } from "../lib/core/draft";
import { evaluateRecordedDraft, evaluateSimulatedDraft, replayDraftStrategy, type EvaluationOpponent, type EvaluationStrategy } from "../lib/core/draft-evaluation";
import type { DraftPolicyState } from "../lib/core/draft-policy";
import type { PlayerRisk } from "../lib/core/roster-utility";
import type { LeagueConfig } from "../lib/core/season-sim";
import { pairedOutcomeComparison } from "../lib/core/stats";
import live from "../tests/fixtures/sleeper-pick16-continuation.json";
import historical from "../tests/fixtures/draft-evaluation-2024.json";

// Declared before looking at results. Selection and evaluation streams never overlap.
const SELECTION_SEED = 20260731;
const EVALUATION_SEEDS = [19092026, 29092026, 39092026];
const OPPONENT_SEED = 9021026;
const scenarios = process.argv.includes("--quick") ? 60 : 600;
const candidates = process.argv.includes("--quick") ? 4 : 10;
const evaluationScenarios = process.argv.includes("--quick") ? 100 : 1000;
const strategies: EvaluationStrategy[] = ["adp", "roster-needs", "greedy", "rollout"];
const opponents: EvaluationOpponent[] = ["strict-adp", "needs-adp", "noisy-adp"];
const hydrate = (player: PlayerRisk, distributions: Record<string, number[]>) => ({ ...player, weeklyOutcomeRatios: distributions[player.position] });
const liveState: DraftPolicyState = { ...live.state, available: live.state.available.map((player) => hydrate(player, live.distributions)), teams: live.state.teams.map((team) => ({ ...team, roster: team.roster.map((player) => hydrate(player, live.distributions)) })) };
const liveConfig: LeagueConfig = { ...live.config, scenarios, wireCover: new Map(live.config.wireCover as [string, number][]), unprojectedPositions: new Set(live.config.unprojectedPositions) };
const historicalConfig: LeagueConfig = {
  slots: ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"].map((position, i) => ({ id: `${position}:${i}`, label: position, eligiblePositions: position === "FLEX" ? ["RB", "WR", "TE"] : [position] })),
  weeks: Array.from({ length: 14 }, (_, i) => i + 1), playoffWeeks: [15, 16, 17], playoffTeams: 6,
  scenarios, meanAbsenceWeeks: 3, wireCover: new Map([["QB", 1]]), unprojectedPositions: new Set(),
};
const historyState = (seat: number): DraftPolicyState => {
  const ownership = [...pickOwnership(10, seat, 12)];
  return { myTeamIndex: 0, rosterSize: 12, available: historical.rows.map((row) => hydrate(row.player, historical.distributions)),
    teams: Array.from({ length: 10 }, (_, index) => ({ id: String(index), name: String(index), roster: [], remainingPicks: ownership.filter(([, team]) => team === index).map(([pick]) => pick).sort((a, b) => a - b) })) };
};
const cases = [
  { name: "live-20-keepers-pick16", state: liveState, config: liveConfig, external: false },
  { name: "historical-2024-seat1", state: historyState(1), config: historicalConfig, external: true },
  { name: "historical-2024-seat10", state: historyState(10), config: historicalConfig, external: true },
];
const actual = new Map(historical.rows.filter((row) => row.actual !== null).map((row) => [row.player.id, new Map(Object.entries(row.actual!).map(([week, points]) => [Number(week), points]))]));
console.log(JSON.stringify({ kind: "protocol", diagnosticOnly: true, cpu: cpus()[0]?.model, runtime: process.version,
  selectionSeed: SELECTION_SEED, evaluationSeeds: EVALUATION_SEEDS, opponentSeed: OPPONENT_SEED, scenarios, candidates, evaluationScenarios,
  note: "Conditional simulator uncertainty only. Three reused board cases are not independent leagues. Historical actual scoring is one observed season, no probability interval. No reserved 2025 outcome evaluation; live inputs retain frozen production distributions. Raw strict-ADP opponents are a stress test, not a quality claim." }));
for (const entry of cases) for (const opponent of opponents) {
  let baseline: boolean[] | undefined;
  let needsBaseline: boolean[] | undefined;
  let externalAdpPoints: number | undefined;
  let externalNeedsPoints: number | undefined;
  for (const strategy of strategies) {
    const start = performance.now();
    const replay = replayDraftStrategy(entry.state, entry.config, strategy, opponent, SELECTION_SEED, OPPONENT_SEED, candidates);
    const draftMilliseconds = Math.round(performance.now() - start);
    if (replay.missingStarters[0] !== 0) throw new Error(`Required starter missing: ${entry.name}/${opponent}/${strategy}`);
    const outcomes = EVALUATION_SEEDS.map((seed) => evaluateSimulatedDraft(replay.rosters, { ...entry.config, scenarios: evaluationScenarios }, seed));
    const title = outcomes.flatMap((outcome) => outcome.championByScenario.map((team) => team === entry.state.myTeamIndex));
    if (strategy === "adp") baseline = title;
    if (strategy === "roster-needs") needsBaseline = title;
    const external = entry.external ? evaluateRecordedDraft(replay.rosters, entry.config, actual).outcomes[0] : null;
    if (strategy === "adp") externalAdpPoints = external?.expectedPoints;
    if (strategy === "roster-needs") externalNeedsPoints = external?.expectedPoints;
    console.log(JSON.stringify({ kind: "paired-result", case: entry.name, opponent, strategy, draftMilliseconds,
      missingStarters: replay.missingStarters, ownRoster: replay.rosters[0].map((player) => player.name),
      title: title.filter(Boolean).length / title.length, pairedVsAdp: pairedOutcomeComparison(title, baseline!),
      pairedVsRosterNeeds: needsBaseline === undefined ? null : pairedOutcomeComparison(title, needsBaseline),
      meanSeasonPoints: outcomes.reduce((sum, result) => sum + result.outcomes[0].expectedPoints, 0) / outcomes.length,
      actual2024: external,
      actualPointsVsAdp: external === null ? null : external.expectedPoints - externalAdpPoints!,
      actualPointsVsRosterNeeds: external === null || externalNeedsPoints === undefined ? null : external.expectedPoints - externalNeedsPoints }));
  }
}
