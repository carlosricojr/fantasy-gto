import type { WeeklyLineupSnapshot, WeeklyPlayer } from "../nfl/weekly-lineup";
import { parseWaiverOwnership, type WaiverOwnership } from "../nfl/waiver-pool";
import { WAIVER_CANDIDATE_LIMIT, WAIVER_ROSTER_LIMIT, WAIVER_SLOT_LIMIT, type WaiverComparisonInput } from "../nfl/waiver-planner";
import { applyWeeklyModel } from "../nfl/weekly-lineup-inputs";
import { sleeperScoringFromId } from "../nfl/scoring/sleeper";
import { NflverseProvider, type TextFetcher } from "./nflverse";
import { generateNflverseWeeklyProjections } from "./nflverse-weekly-projections";
import { hydrateSleeperWeeklyPlayers, parseSleeperLineup, parseSleeperWeeklyPlayer, sharedSleeperLineupFetcher } from "./sleeper-lineup";
import { leagueUrl, playersUrl } from "./sleeper";

export interface WaiverImport extends WaiverComparisonInput {
  availablePlayers: WeeklyPlayer[];
  directoryExcludedCount: number;
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
export function parseWaiverDirectory(payload: unknown, roster: WeeklyLineupSnapshot, ownership: WaiverOwnership): { players: WeeklyPlayer[]; excludedCount: number } {
  const directory = object(payload);
  const entries = Object.entries(directory);
  if (entries.length === 0 || entries.length > 25000) throw new Error("Player directory is empty or exceeds this tool's supported budget.");
  const owned = new Set(ownership.ownedPlayerIds);
  const players: WeeklyPlayer[] = [];
  let excludedCount = 0;
  for (const [id, row] of entries) {
    if (owned.has(id)) continue;
    try {
      if (!/^(?:[1-9]\d{0,29}|[A-Z]{2,3})$/.test(id)) throw new Error("Invalid ID");
      const player = parseSleeperWeeklyPlayer(id, row, { reserve: false, currentSlotId: null });
      if (!["active", "questionable", "doubtful"].includes(player.availability) || !roster.slots.some((slot) => slot.eligiblePositions.some((position) => player.positions.includes(position)))) { excludedCount += 1; continue; }
      players.push(player);
    } catch { excludedCount += 1; }
  }
  return { players: players.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), excludedCount };
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
  const pool = parseWaiverDirectory(directory, roster, ownership);
  const byId = new Map(pool.players.map((p) => [p.id, p]));
  if (request.candidateIds.some((id) => !byId.has(id))) throw new Error("A selected candidate is no longer unrostered or eligible in the directory. Reload the full league pool.");
  const candidates = request.candidateIds.map((id) => byId.get(id)!);
  // Pool discovery needs no projections or NFL downloads. Comparison hydrates both sides together.
  if (candidates.length === 0) return { roster, ownership, candidates, availablePlayers: pool.players, availableCount: pool.players.length, directoryExcludedCount: pool.excludedCount };
  let combined = await hydrateSleeperWeeklyPlayers({ ...roster, players: [...roster.players, ...candidates] }, requestFetch);
  const profile = sleeperScoringFromId(roster.scoringId);
  if (profile === null) throw new Error("Imported scoring identity is not supported.");
  const result = await generateNflverseWeeklyProjections({ season: roster.season, week: roster.week, profile, playerIds: combined.players.map((p) => p.id), now: request.now, includeConditionalEstimates: request.includeConditionalEstimates }, new NflverseProvider(requestFetch));
  if (!result.ok) throw new Error(`Weekly estimates unavailable: ${result.reason}`);
  combined = applyWeeklyModel(combined, result.data);
  const ownIds = new Set(ownership.ownPlayerIds);
  return { roster: { ...combined, players: combined.players.filter((p) => ownIds.has(p.id)) }, candidates: combined.players.filter((p) => !ownIds.has(p.id)), ownership, availablePlayers: pool.players, availableCount: pool.players.length, directoryExcludedCount: pool.excludedCount };
}
