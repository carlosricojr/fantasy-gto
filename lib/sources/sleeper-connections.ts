import { sleeperLeagueId, sleeperUserInput, type SleeperConnection } from "../nfl/sleeper-connection";
import { readBoundedJson } from "./bounded-json";

type FetchJson = (url: string) => Promise<unknown>;
const BASE = "https://api.sleeper.app/v1";
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value);
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Sleeper lookup failed (${response.status}). Try again later.`);
  return readBoundedJson(response.body, 2_000_000);
}

export interface SleeperConnectionLookup { connections: SleeperConnection[]; season: number; week: number; warnings: string[] }

/** Documented public endpoints only. Resolves stable IDs; a public roster is not account authentication. */
export async function findSleeperConnections(request: { username?: string; leagueInput?: string }, get: FetchJson = fetchJson): Promise<SleeperConnectionLookup> {
  const username = request.username?.trim() ? sleeperUserInput(request.username) : null;
  const leagueId = request.leagueInput?.trim() ? sleeperLeagueId(request.leagueInput) : null;
  if (request.username?.trim() && username === null) throw new Error("Enter a valid Sleeper username or user ID.");
  if (request.leagueInput?.trim() && leagueId === null) throw new Error("Enter a Sleeper league ID or https://sleeper.com/leagues/… link.");
  if (username === null && leagueId === null) throw new Error("Enter your Sleeper username or a league link.");
  const state = object(await get(`${BASE}/state/nfl`));
  const season = Number(state?.season);
  const week = Number(state?.week);
  if (!Number.isInteger(season) || season < 2000 || season > 2200 || !Number.isInteger(week) || week < 1 || week > 18) throw new Error("Sleeper has no supported current NFL week.");
  const user = username === null ? null : object(await get(`${BASE}/user/${encodeURIComponent(username)}`));
  if (username !== null && (!user || !id(user.user_id))) throw new Error("Sleeper user not found. Check the username.");
  const ownerId = user?.user_id as string | undefined;
  const rawLeagues = leagueId ? [await get(`${BASE}/league/${leagueId}`)] : await get(`${BASE}/user/${ownerId}/leagues/nfl/${season}`);
  if (!Array.isArray(rawLeagues) || rawLeagues.length > 100) throw new Error("Sleeper returned an unsupported league list. Use a specific league link.");
  const leagues = rawLeagues.map(object).filter((row) => row !== null && row.sport === "nfl" && Number(row.season) === season && id(row.league_id));
  if (leagueId && (leagues.length !== 1 || leagues[0]!.league_id !== leagueId)) throw new Error("That league is not an NFL league in Sleeper’s current season.");
  const connections: SleeperConnection[] = [];
  const warnings: string[] = [];
  // A named user can discover many leagues without multiplying roster/directory downloads.
  for (const league of leagues.slice(0, 20)) {
    const externalId = league!.league_id as string;
    const leagueName = typeof league!.name === "string" ? league!.name.slice(0, 120) : "Sleeper league";
    if (ownerId && !leagueId) {
      connections.push({ leagueId: externalId, ownerId, leagueName, username: typeof user?.username === "string" ? user.username.slice(0, 40) : username!, season });
      continue;
    }
    const [rawRosters, rawUsers] = await Promise.all([get(`${BASE}/league/${externalId}/rosters`), get(`${BASE}/league/${externalId}/users`)]);
    if (!Array.isArray(rawRosters) || rawRosters.length === 0 || rawRosters.length > 32 || !Array.isArray(rawUsers) || rawUsers.length > 100) throw new Error("Sleeper returned an unsupported manager list.");
    const users = rawUsers.map(object);
    const owners = new Set<string>();
    const rosterIds = new Set<number>();
    for (const raw of rawRosters) {
      const roster = object(raw);
      if (!roster || roster.league_id !== externalId || !Number.isInteger(roster.roster_id) || Number(roster.roster_id) < 1 || rosterIds.has(Number(roster.roster_id))) throw new Error("Sleeper returned an invalid roster identity.");
      rosterIds.add(Number(roster.roster_id));
      if (roster.co_owners !== null && roster.co_owners !== undefined && (!Array.isArray(roster.co_owners) || roster.co_owners.length > 8 || roster.co_owners.some((value) => !id(value)))) throw new Error("Sleeper returned an unsupported co-owner list.");
      const candidates = [roster.owner_id, ...(Array.isArray(roster.co_owners) ? roster.co_owners : [])].filter(id);
      if (candidates.some((candidate) => owners.has(candidate))) throw new Error("A Sleeper manager maps to multiple rosters; select a different league.");
      for (const candidate of candidates) owners.add(candidate);
      if (owners.size > 100) throw new Error("Sleeper returned too many roster managers.");
    }
    for (const candidate of owners) {
      if (ownerId && candidate !== ownerId) continue;
      const manager = users.find((entry) => entry?.user_id === candidate);
      connections.push({ leagueId: externalId, ownerId: candidate, leagueName, username: typeof manager?.username === "string" ? manager.username.slice(0, 40) : candidate, season });
    }
  }
  if (leagues.length > 20) warnings.push("Showing the first 20 leagues. Paste a specific league link to find another.");
  if (connections.length === 0) throw new Error("No current-season roster found for that Sleeper identity.");
  if (connections.length > 100) throw new Error("Too many team choices. Supply your Sleeper username and a specific league link.");
  return { connections, season, week, warnings };
}
