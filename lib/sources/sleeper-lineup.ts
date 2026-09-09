import type { WeeklyAvailability, WeeklyLineupSnapshot, WeeklyPlayer } from "../nfl/weekly-lineup";
import { parseSleeperScoring } from "../nfl/scoring/sleeper";
import { SLOT_ELIGIBILITY } from "../nfl/roster";
import { teamByeWeeks } from "../nfl/byes";
import { resolveWeeklyRosterTeam } from "../nfl/weekly-lineup-inputs";
import { NflverseProvider, httpTextFetcher, schedulesUrl, type TextFetcher } from "./nflverse";
import { leagueUrl, playersUrl } from "./sleeper";

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Unexpected Sleeper response.");
  return value as Record<string, unknown>;
};
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new Error("Incomplete Sleeper roster or positions.");
  return value as string[];
};

/** Two bounded shared downloads. Concurrent imports share their in-flight request. */
export function createSleeperLineupFetcher(fetchText: TextFetcher, clock: () => number): TextFetcher {
  const cache = new Map<string, { expiresAt: number; pending: Promise<string> }>();
  return async (url) => {
    // Sleeper documents a once-a-day limit for the complete player directory.
    // Schedule changes affect locks, so its separate cache lasts only 15 minutes.
    const ttl = url === playersUrl() ? 24 * 60 * 60 * 1000 : url === schedulesUrl() ? 15 * 60 * 1000 : 0;
    if (ttl === 0) return fetchText(url);
    const cached = cache.get(url);
    if (cached && cached.expiresAt > clock()) return cached.pending;
    const entry = { expiresAt: clock() + ttl, pending: fetchText(url) };
    cache.set(url, entry);
    try { return await entry.pending; }
    catch (cause) { if (cache.get(url) === entry) cache.delete(url); throw cause; }
  };
}

export const sharedSleeperLineupFetcher = createSleeperLineupFetcher(httpTextFetcher, () => Date.now());

/** Shared directory interpretation for rostered players and unrostered candidates. */
export function parseSleeperWeeklyPlayer(id: string, payload: unknown, context: { reserve: boolean; currentSlotId: string | null }): WeeklyPlayer {
  const row = object(payload);
  if (row.player_id !== undefined && row.player_id !== id) throw new Error(`Player ${id} has conflicting directory identity.`);
  const positions = strings(row.fantasy_positions).map((p) => p === "DEF" ? "DST" : p);
  const name = typeof row.full_name === "string" ? row.full_name : [row.first_name, row.last_name].filter((p) => typeof p === "string").join(" ");
  if (!name || positions.length === 0) throw new Error(`Player ${id} has no usable name or fantasy position.`);
  const status = typeof row.status === "string" ? row.status.toLowerCase() : "unknown";
  const injury = typeof row.injury_status === "string" ? row.injury_status.toLowerCase() : "";
  let availability: WeeklyAvailability = "unknown";
  if (context.reserve) availability = "reserve";
  else if (["out", "inactive", "ir", "pup", "suspended", "susp"].includes(injury)) availability = "out";
  else if (["inactive", "injured reserve", "suspended", "pup"].includes(status)) availability = "inactive";
  else if (status === "active" || positions.includes("DST")) availability = injury === "questionable" || injury === "doubtful" ? injury : injury === "" ? "active" : "unknown";
  return { id, name, positions, availability, kickoffAt: null, currentSlotId: context.currentSlotId, projectedPoints: null };
}

/** Parse only the requested roster; foreign or ambiguous ownership is never guessed. */
export function parseSleeperLineup(leaguePayload: unknown, rostersPayload: unknown, playersPayload: unknown, request: { leagueId: string; ownerId: string; week: number; now: number }): WeeklyLineupSnapshot {
  const league = object(leaguePayload);
  if (league.league_id !== request.leagueId || league.sport !== "nfl") throw new Error("Sleeper returned a different league or sport.");
  const season = Number(league.season);
  if (!Number.isInteger(season) || season < 2000 || !Number.isInteger(request.week) || request.week < 1 || request.week > 18) throw new Error("Invalid season or regular-season week.");
  const settings = object(league.settings);
  if (settings.best_ball !== 0 || settings.max_subs !== 0) throw new Error("Best ball and automatic substitutions are not supported by this weekly planner.");
  if (!Array.isArray(rostersPayload)) throw new Error("Sleeper did not return league rosters.");
  const matches = rostersPayload.map(object).filter((r) => r.owner_id === request.ownerId || (Array.isArray(r.co_owners) && r.co_owners.includes(request.ownerId)));
  if (matches.length !== 1) throw new Error("This user does not uniquely identify a roster in the league.");
  const roster = matches[0];
  if (roster.league_id !== request.leagueId) throw new Error("Sleeper roster belongs to another league.");
  const scoring = parseSleeperScoring(league.scoring_settings);
  if (!scoring.ok) throw new Error(`Unsupported exact scoring: ${scoring.unsupported.join("; ")}`);
  const slotCodes = strings(league.roster_positions).filter((p) => p !== "BN");
  const slots = slotCodes.map((code, i) => {
    const kind = code === "DEF" ? "DST" : code === "SUPER_FLEX" ? "SUPERFLEX" : code;
    const eligiblePositions = SLOT_ELIGIBILITY[kind];
    if (!eligiblePositions) throw new Error(`Unsupported starting slot: ${code}`);
    return { id: `sleeper-slot-${i}`, label: code, eligiblePositions };
  });
  const starters = strings(roster.starters);
  if (starters.length !== slots.length) throw new Error("Starter count does not match the league slot order.");
  const ids = strings(roster.players);
  if (new Set(ids).size !== ids.length || new Set(starters.filter((id) => id !== "0")).size !== starters.filter((id) => id !== "0").length || starters.some((id) => id !== "0" && !ids.includes(id))) throw new Error("Sleeper roster has duplicate or missing starter identities.");
  const reserve = new Set([...strings(roster.reserve ?? []), ...strings(roster.taxi ?? [])]);
  const directory = object(playersPayload);
  const players = ids.map((id) => parseSleeperWeeklyPlayer(id, directory[id], { reserve: reserve.has(id), currentSlotId: starters.includes(id) ? slots[starters.indexOf(id)].id : null }));
  return { leagueId: request.leagueId, ownerId: request.ownerId, season, week: request.week, scoringId: scoring.profile.id, leagueName: typeof league.name === "string" ? league.name : request.leagueId, slots, players, source: "User-entered expected points", retrievedAt: request.now, projectionUpdatedAt: null, rosterRetrievedAt: request.now };
}

/** Documented read-only league state only. Never calls Sleeper's projection service. */
export async function importSleeperLineup(request: { leagueId: string; ownerId: string; week: number; now: number }, fetchText: TextFetcher = sharedSleeperLineupFetcher): Promise<WeeklyLineupSnapshot> {
  if (!/^\d+$/.test(request.leagueId) || !/^\d+$/.test(request.ownerId)) throw new Error("Use numeric Sleeper league and user IDs.");
  const [leagueRaw, rostersRaw, playersRaw, stateRaw] = await Promise.all([
    fetchText(leagueUrl(request.leagueId)),
    fetchText(`${leagueUrl(request.leagueId)}/rosters`),
    fetchText(playersUrl()),
    fetchText("https://api.sleeper.app/v1/state/nfl"),
  ]);
  const directory: unknown = JSON.parse(playersRaw);
  const snapshot = parseSleeperLineup(JSON.parse(leagueRaw), JSON.parse(rostersRaw), directory, request);
  const state = object(JSON.parse(stateRaw));
  if (Number(state.season) !== snapshot.season || state.week !== snapshot.week) throw new Error("Live starters can only be imported for Sleeper's current season and week. Historical or future snapshots must identify their own starting lineup.");
  return hydrateSleeperWeeklyPlayers(snapshot, fetchText);
}

/** Applies the same verified current-team/game gates to every supplied identity. */
export async function hydrateSleeperWeeklyPlayers(snapshot: WeeklyLineupSnapshot, fetchText: TextFetcher = sharedSleeperLineupFetcher): Promise<WeeklyLineupSnapshot> {
  const provider = new NflverseProvider(fetchText);
  const [schedule, identities, weekly] = await Promise.all([provider.allContests(), provider.draftRoster(snapshot.season), provider.weeklyRoster(snapshot.season)]);
  if (!schedule.ok) throw new Error(`Schedule unavailable: ${schedule.reason}`);
  if (!identities.ok) throw new Error(`Player identity bridge unavailable: ${identities.reason}`);
  if (!weekly.ok) throw new Error(`Current weekly teams unavailable: ${weekly.reason}`);
  const seasonGames = schedule.data.filter((g) => g.period.season === snapshot.season);
  const weekGames = seasonGames.filter((g) => g.period.index === snapshot.week);
  if (weekGames.length === 0) throw new Error("No games were found for this season and week.");
  const byes = teamByeWeeks(seasonGames, snapshot.season);
  const players = snapshot.players.map((player) => {
    const team = resolveWeeklyRosterTeam(player.id, player.positions, snapshot.season, snapshot.week, identities.data.entries, weekly.data.entries);
    const games = weekGames.filter((game) => game.homeTeam === team || game.awayTeam === team);
    const kickoff = games.length === 1 && games[0].startsAt !== null ? Date.parse(games[0].startsAt) : null;
    // A missing row in a potentially partial schedule is not enough evidence of a bye.
    const fullTeamSchedule = seasonGames.filter((g) => g.homeTeam === team || g.awayTeam === team).length === 17;
    const availability = team !== null && fullTeamSchedule && byes.get(team) === snapshot.week ? "bye" as const : player.availability;
    return { ...player, availability, team, gameId: games.length === 1 ? games[0].id : null, kickoffAt: kickoff !== null && Number.isFinite(kickoff) ? kickoff : null };
  });
  return { ...snapshot, players, warnings: ["Player designations come from Sleeper's directory, cached for up to one day per its API guidance. Verify current injuries and the final inactive list before setting a lineup."] };
}
