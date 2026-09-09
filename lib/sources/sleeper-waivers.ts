import type { WeeklyLineupSnapshot, WeeklyPlayer } from "../nfl/weekly-lineup";
import { parseWaiverOwnership, type WaiverOwnership } from "../nfl/waiver-pool";
import { WAIVER_CANDIDATE_LIMIT, WAIVER_ROSTER_LIMIT, WAIVER_SLOT_LIMIT, type WaiverComparisonInput } from "../nfl/waiver-planner";
import { applyWeeklyModel } from "../nfl/weekly-lineup-inputs";
import { sleeperScoringFromId } from "../nfl/scoring/sleeper";
import { NflverseProvider, weeklyRosterUrl, type TextFetcher } from "./nflverse";
import { parseCsv } from "../nfl/csv";
import { assertWaiverProjectionIdentity, parseWaiverRosterEvidence, waiverRosterMembership, type WaiverRosterEvidence } from "../nfl/waiver-pool-evidence";
import { generateNflverseWeeklyProjections } from "./nflverse-weekly-projections";
import { hydrateSleeperWeeklyPlayers, parseSleeperLineup, parseSleeperWeeklyPlayer, sharedSleeperLineupFetcher } from "./sleeper-lineup";
import { leagueUrl, playersUrl } from "./sleeper";

export interface WaiverImport extends WaiverComparisonInput {
  availablePlayers: WeeklyPlayer[];
  directoryExcludedCount: number;
  rosterEvidence: { sourceUrl: string; season: number; week: number; retrievedAt: number; publicationTime: null; reportRows: number; reportedTeams: string[]; excluded: { missing: number; inactive: number; conflicting: number } };
}
export interface WaiverRequest { leagueId: string; ownerId: string; week: number; now: number; candidateIds: readonly string[]; includeConditionalEstimates: boolean }
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected Sleeper response.");
  return value as Record<string, unknown>;
};

export function parseWaiverRequest(params: URLSearchParams, now: number): WaiverRequest {
  const leagueId = params.get("leagueId") ?? "";
  const ownerId = params.get("ownerId") ?? "";
  const weekText = params.get("week") ?? "";
  const candidateText = params.get("candidates") ?? "";
  const candidateIds = candidateText === "" ? [] : candidateText.split(",");
  const conditional = params.get("conditional");
  if (!/^\d{1,30}$/.test(leagueId) || !/^\d{1,30}$/.test(ownerId) || !/^(?:[1-9]|1[0-8])$/.test(weekText)
    || candidateIds.length > WAIVER_CANDIDATE_LIMIT || new Set(candidateIds).size !== candidateIds.length
    || candidateIds.some((id) => !/^(?:[1-9]\d{0,29}|[A-Z]{2,3})$/.test(id)) || (conditional !== null && conditional !== "active-at-kickoff")) throw new Error("Use numeric league/user IDs, week 1–18, and at most 12 unique player IDs.");
  return { leagueId, ownerId, week: Number(weekText), now, candidateIds, includeConditionalEstimates: conditional === "active-at-kickoff" };
}

/** Searchable directory universe, not a ranked projection universe or claim-clearance feed. */
export function parseWaiverDirectory(payload: unknown, roster: WeeklyLineupSnapshot, ownership: WaiverOwnership, evidence: WaiverRosterEvidence): { players: WeeklyPlayer[]; excludedCount: number; evidenceExcluded: { missing: number; inactive: number; conflicting: number } } {
  const directory = object(payload);
  const entries = Object.entries(directory);
  if (entries.length === 0 || entries.length > 25000) throw new Error("Player directory is empty or exceeds this tool's supported budget.");
  const owned = new Set(ownership.ownedPlayerIds);
  const players: WeeklyPlayer[] = [];
  let excludedCount = 0;
  const evidenceExcluded = { missing: 0, inactive: 0, conflicting: 0 };
  for (const [id, row] of entries) {
    if (owned.has(id)) continue;
    try {
      if (!/^(?:[1-9]\d{0,29}|[A-Z]{2,3})$/.test(id)) throw new Error("Invalid ID");
      const player = parseSleeperWeeklyPlayer(id, row, { reserve: false, currentSlotId: null });
      if (!["active", "questionable", "doubtful"].includes(player.availability) || !roster.slots.some((slot) => slot.eligiblePositions.some((position) => player.positions.includes(position)))) { excludedCount += 1; continue; }
      const membership = waiverRosterMembership(player, evidence);
      if (!membership.ok) { evidenceExcluded[membership.reason] += 1; continue; }
      players.push({ ...player, team: membership.team });
    } catch { excludedCount += 1; }
  }
  return { players: players.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), excludedCount, evidenceExcluded };
}

/** Fresh full-league membership on every request; only the documented daily directory is cached. */
export async function importSleeperWaivers(request: WaiverRequest, fetchText: TextFetcher = sharedSleeperLineupFetcher): Promise<WaiverImport> {
  // Direct callers get the same pre-I/O request budget as HTTP callers.
  parseWaiverRequest(new URLSearchParams({ leagueId: request.leagueId, ownerId: request.ownerId, week: String(request.week), candidates: request.candidateIds.join(","), ...(request.includeConditionalEstimates ? { conditional: "active-at-kickoff" } : {}) }), request.now);
  // Hydration and projection must see the same roster/schedule bytes. This cache is
  // request-local; a later comparison always re-reads league ownership.
  const pending = new Map<string, Promise<string>>();
  const requestFetch: TextFetcher = (url) => {
    if (!pending.has(url)) pending.set(url, fetchText(url));
    return pending.get(url)!;
  };
  const [leagueRaw, rostersRaw, directoryRaw, stateRaw] = await Promise.all([
    requestFetch(leagueUrl(request.leagueId)), requestFetch(`${leagueUrl(request.leagueId)}/rosters`), requestFetch(playersUrl()), requestFetch("https://api.sleeper.app/v1/state/nfl"),
  ]);
  const league: unknown = JSON.parse(leagueRaw);
  const rosters: unknown = JSON.parse(rostersRaw);
  const directory: unknown = JSON.parse(directoryRaw);
  const ownership = parseWaiverOwnership(league, rosters, request);
  const roster = parseSleeperLineup(league, rosters, directory, request);
  if (roster.players.length > WAIVER_ROSTER_LIMIT || roster.slots.length > WAIVER_SLOT_LIMIT) throw new Error(`This comparison supports at most ${WAIVER_ROSTER_LIMIT} rostered players and ${WAIVER_SLOT_LIMIT} starting slots.`);
  const state = object(JSON.parse(stateRaw));
  if (state.season_type !== "regular" || Number(state.season) !== roster.season || state.week !== roster.week) throw new Error("Waivers compare only Sleeper's current regular-season week.");
  const evidenceUrl = weeklyRosterUrl(roster.season);
  const evidence = parseWaiverRosterEvidence(parseCsv(await requestFetch(evidenceUrl)), roster.season, roster.week);
  const pool = parseWaiverDirectory(directory, roster, ownership, evidence);
  const rosterEvidence: WaiverImport["rosterEvidence"] = { sourceUrl: evidenceUrl, season: roster.season, week: roster.week, retrievedAt: request.now, publicationTime: null, reportRows: evidence.reportRows, reportedTeams: evidence.reportedTeams, excluded: pool.evidenceExcluded };
  const byId = new Map(pool.players.map((p) => [p.id, p]));
  if (request.candidateIds.some((id) => !byId.has(id))) throw new Error("A selected candidate is no longer unrostered, eligible or supported by current NFL roster evidence. Reload the full league pool.");
  const candidates = request.candidateIds.map((id) => byId.get(id)!);
  // Discovery reads membership evidence, not projections. Comparison reuses the same bytes.
  if (candidates.length === 0) return { roster, ownership, candidates, availablePlayers: pool.players, availableCount: pool.players.length, directoryExcludedCount: pool.excludedCount, rosterEvidence };
  let combined = await hydrateSleeperWeeklyPlayers({ ...roster, players: [...roster.players, ...candidates] }, requestFetch);
  const profile = sleeperScoringFromId(roster.scoringId);
  if (profile === null) throw new Error("Imported scoring identity is not supported.");
  const result = await generateNflverseWeeklyProjections({ season: roster.season, week: roster.week, profile, playerIds: combined.players.map((p) => p.id), now: request.now, includeConditionalEstimates: request.includeConditionalEstimates }, new NflverseProvider(requestFetch));
  if (!result.ok) throw new Error(`Weekly estimates unavailable: ${result.reason}`);
  // Reconcile both sides, including availability/game metadata on unpriced players.
  // Entirely unresolved model rows carry no new context and remain unknown.
  for (const estimate of result.data.players) {
    const player = combined.players.find((entry) => entry.id === estimate.playerId);
    if (player === undefined) throw new Error("Projection returned an unexpected player identity.");
    const hasContext = estimate.points !== null || estimate.conditionalEstimate !== undefined || estimate.team !== undefined || estimate.availability !== undefined;
    assertWaiverProjectionIdentity(player, estimate, evidence, hasContext);
  }
  combined = applyWeeklyModel(combined, result.data);
  const ownIds = new Set(ownership.ownPlayerIds);
  return { roster: { ...combined, players: combined.players.filter((p) => ownIds.has(p.id)) }, candidates: combined.players.filter((p) => !ownIds.has(p.id)), ownership, availablePlayers: pool.players, availableCount: pool.players.length, directoryExcludedCount: pool.excludedCount, rosterEvidence };
}
