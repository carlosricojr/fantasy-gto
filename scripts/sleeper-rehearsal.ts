/** Read-only live-source rehearsal. Never posts picks or changes a Sleeper league. */
import { SleeperDraftProvider, resolveSleeperDraftId } from "../lib/sources/sleeper";
import { importSleeperSetup } from "../lib/nfl/draft/sleeper-import";
import { sleeperPickOwnership } from "../lib/nfl/draft/sleeper-ownership";
import { reconcileSleeperDraft } from "../lib/nfl/draft/sleeper-sync";
import { isRecommendationEligible } from "../lib/nfl/draft/status";
import { perGameRate } from "../lib/nfl/draft/value";
import { slotsForTemplate, waiverWireCover, UNPROJECTED_POSITIONS } from "../lib/nfl/roster";
import { completeDraft, trimDraftRoster, recommendByChampionship, type DraftPolicyState } from "../lib/core/draft-policy";
import { fantasySeasonWeeks, sampleTeamWeeklyScores, simulateLeague, type LeagueConfig } from "../lib/core/season-sim";
import type { PlayerRisk } from "../lib/core/roster-utility";
import type { RosterStatus } from "../lib/nfl/weekly-roster";
import { customBoardBlock } from "../lib/nfl/draft/custom-board-readiness";

interface Row {
  playerId: string; sleeperId?: string; name: string; position: string; team: string | null;
  blendedPoints: number | null; availability: number | null; p10: number; p90: number;
  weeklyStdDev?: number; byeWeek: number | null; adp: number | null; adpStdev: number | null;
  weeklyOutcomeRatios?: number[];
  rosterStatus: RosterStatus | null; historicalScoringSource?: string;
}

async function main(): Promise<void> {
  const [reference, userId, deployment = "https://limitless-elk-261.convex.cloud"] = process.argv.slice(2);
  if (!reference || !userId) throw new Error("Usage: pnpm exec tsx scripts/sleeper-rehearsal.ts <league-or-draft-URL> <Sleeper-user-id> [Convex-URL]");
  const resolved = await resolveSleeperDraftId(reference);
  if (!resolved.ok) throw new Error(resolved.reason);
  const provider = new SleeperDraftProvider();
  const source = await provider.settings(resolved.data, String(Date.now()));
  if (!source.ok) throw new Error(source.reason);
  const imported = importSleeperSetup(source.data);
  if (!imported.exact || imported.settings === null || imported.settings.seasonRules === undefined) throw new Error(`League import is not exact: ${imported.unsupported.join(", ")}`);
  const setup = imported.settings;
  const seasonRules = setup.seasonRules!;
  const slot = source.data.draftOrder[userId];
  if (!Number.isInteger(slot)) throw new Error("User has no verified draft seat.");
  const [picks, trades] = await Promise.all([provider.picks(resolved.data, setup.teams), provider.tradedPicks(resolved.data)]);
  if (!picks.ok || !trades.ok) throw new Error("Live pick or ownership fetch failed.");
  const ownership = sleeperPickOwnership({ ...setup, userSlot: slot, slotToRosterId: source.data.slotToRosterId, tradedPicks: trades.data });
  if (!ownership.exact) throw new Error(ownership.unsupported.join(", "));
  // Source draft metadata, not the local clock, identifies the season being tested.
  const draft = await (await fetch(`https://api.sleeper.app/v1/draft/${encodeURIComponent(resolved.data)}`)).json() as { season?: string };
  const season = Number(draft.season);
  if (!Number.isInteger(season) || season < 2000) throw new Error("Missing source draft season.");
  const response = await fetch(`${deployment}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "draft:board", args: { season, teams: setup.teams, scoringId: setup.scoringId }, format: "json" }) });
  const result = await response.json() as { status: string; value?: Row[] };
  if (!response.ok || result.status !== "success" || !Array.isArray(result.value) || result.value.length === 0) throw new Error("No published board for this exact custom scoring profile.");
  const rows = result.value;
  const block = customBoardBlock(setup.scoringId, rows);
  if (block !== null) throw new Error(block);
  if (new Set(rows.map((r) => r.playerId)).size !== rows.length) throw new Error("Duplicate board identities.");
  if (new Set(rows.filter((r) => r.position === "DST").map((r) => r.sleeperId)).size !== 32) throw new Error("Custom board does not represent all 32 defenses.");
  const reconciliation = reconcileSleeperDraft({
    prior: { providerPicks: [], repairs: [] }, incoming: picks.data,
    board: rows.map((r) => ({ id: r.playerId, providerId: r.sleeperId ?? null, name: r.name, position: r.position, team: r.team, rookie: false })),
    localPicks: {}, expectedPickCount: setup.teams * setup.rounds, providerStatus: source.data.status,
  });
  if (reconciliation.unresolvedCount || reconciliation.conflicts.length || reconciliation.rejectedRepairs.length) throw new Error("Live picks do not reconcile exactly.");
  const valued = rows.filter((r) => r.blendedPoints !== null && r.availability !== null && isRecommendationEligible(r.rosterStatus));
  if (valued.some((r) => r.historicalScoringSource !== "sleeper-custom-stats")) throw new Error("Mixed preset and custom-scored valuations.");
  const risks = new Map<string, PlayerRisk>(valued.map((r) => [r.playerId, {
    id: r.playerId, name: r.name, position: r.position, weeklyMean: perGameRate(r.blendedPoints!, r.availability!),
    p10: r.p10, p90: r.p90, weeklyStdDev: r.weeklyStdDev, weeklyOutcomeRatios: r.weeklyOutcomeRatios, availability: r.availability!, byeWeek: r.byeWeek, adp: r.adp, adpStdev: r.adpStdev,
  }]));
  const taken = new Set(Object.values(reconciliation.acceptedPicks));
  for (const id of taken) if (!risks.has(id)) throw new Error(`Recorded player ${id} has no active valuation; review explicitly before interpreting estimates.`);
  const state: DraftPolicyState = { myTeamIndex: 0, rosterSize: setup.rounds, available: [...risks.values()].filter((p) => !taken.has(p.id)), teams: Array.from({ length: setup.teams }, (_, index) => ({
    id: String(index), name: `Team ${index}`, draftRosterSize: [...ownership.owners.values()].filter((owner) => owner === index).length,
    roster: Object.entries(reconciliation.acceptedPicks).filter(([pick]) => ownership.owners.get(Number(pick)) === index).map(([, id]) => risks.get(id)!),
    remainingPicks: [...ownership.owners].filter(([pick, owner]) => owner === index && reconciliation.acceptedPicks[pick] === undefined).map(([pick]) => pick).sort((a, b) => a - b),
  })) };
  const slots = slotsForTemplate(setup.templateId);
  const config: LeagueConfig = { slots, ...fantasySeasonWeeks(seasonRules.championshipWeek, seasonRules.playoffTeams), ...seasonRules, scenarios: 32, meanAbsenceWeeks: 3, wireCover: waiverWireCover(setup.teams, slots), unprojectedPositions: UNPROJECTED_POSITIONS };
  const completed = completeDraft(state, config, null);
  if (completed.some((roster, index) => roster.length !== state.teams[index].draftRosterSize)) throw new Error("Draft completion did not consume every owned pick.");
  const ids = completed.flat().map((p) => p.id);
  if (new Set(ids).size !== ids.length) throw new Error("Rehearsal duplicated a drafted player.");
  const seasonRosters = completed.map((roster) => trimDraftRoster(roster, state.rosterSize, slots));
  const outcomes = simulateLeague(seasonRosters.map((roster) => sampleTeamWeeklyScores(roster, config, 7319)), config);
  const total = outcomes.reduce((sum, item) => sum + item.championshipProbability, 0);
  if (Math.abs(total - 1) > 1e-9 || outcomes.some((item) => !Number.isFinite(item.expectedWins))) throw new Error("Invalid simulated league outcomes.");
  const advice = state.teams[0].remainingPicks.length === 0 ? [] : recommendByChampionship(state, config, 7319, 3);
  if (state.teams[0].remainingPicks.length > 0 && advice.length === 0) throw new Error("No recommendations despite remaining owned picks.");
  if (advice.some((r) => taken.has(r.player.id))) throw new Error("Optimizer recommended a drafted player.");
  console.log(JSON.stringify({ readOnly: true, draftId: resolved.data, season, seat: slot, teams: setup.teams, rounds: setup.rounds, ...seasonRules, sourcePicks: picks.data.length, reconciledPicks: taken.size, keeperCount: picks.data.filter((p) => p.isKeeper).length, tradedSquares: ownership.reassignedPicks.length, ownedPickCounts: state.teams.map((t) => t.draftRosterSize), ownRemainingPicks: state.teams[0].remainingPicks.length, customValuedPlayers: valued.length, draftRosterSizes: completed.map((r) => r.length), simulatedRosterSizes: seasonRosters.map((r) => r.length), normalizedTitleProbabilities: Math.abs(total - 1) < 1e-9, recommendationCount: advice.length }, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
