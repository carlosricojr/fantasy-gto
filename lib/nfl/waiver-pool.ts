/** Ownership is independent of projections and directory coverage. */
export interface WaiverOwnership {
  leagueId: string;
  ownerId: string;
  rosterId: number;
  rosterCount: number;
  ownedPlayerIds: string[];
  ownPlayerIds: string[];
  protectedPlayerIds: string[];
  retrievedAt: number;
}

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Incomplete league ownership: expected an object.");
  return value as Record<string, unknown>;
};
const ids = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !/^(?:[1-9]\d{0,29}|[A-Z]{2,3})$/.test(id)) || new Set(value).size !== value.length) throw new Error(`Incomplete league ownership: invalid ${label}.`);
  return value;
};

/** Full-league, fail-closed membership. Reserve/taxi may overlap players, never another team. */
export function parseWaiverOwnership(leaguePayload: unknown, rostersPayload: unknown, request: { leagueId: string; ownerId: string; now: number }): WaiverOwnership {
  const league = record(leaguePayload);
  const settings = record(league.settings);
  if (league.league_id !== request.leagueId || league.sport !== "nfl" || league.status !== "in_season") throw new Error("Waivers require the requested NFL league after its draft and during its season.");
  if (!Number.isFinite(request.now) || !/^\d{1,30}$/.test(request.ownerId)) throw new Error("Invalid ownership request.");
  const count = league.total_rosters;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 2 || count > 32 || !Array.isArray(rostersPayload) || rostersPayload.length !== count) throw new Error("Incomplete league ownership: every league roster is required.");
  if (settings.disable_adds !== 0) throw new Error("League additions are disabled or their permission is unknown.");
  if (!Array.isArray(league.roster_positions) || league.roster_positions.some((p) => typeof p !== "string")) throw new Error("Incomplete league ownership: missing roster format.");
  const startingCount = league.roster_positions.filter((p) => p !== "BN").length;
  const seenRosters = new Set<number>();
  const owners = new Map<string, number>();
  let own: { rosterId: number; players: string[]; protectedIds: string[] } | undefined;
  for (const payload of rostersPayload) {
    const row = record(payload);
    const rosterId = row.roster_id;
    if (row.league_id !== request.leagueId || typeof rosterId !== "number" || !Number.isInteger(rosterId) || rosterId < 1 || seenRosters.has(rosterId)) throw new Error("Incomplete league ownership: foreign or duplicate roster identity.");
    seenRosters.add(rosterId);
    const players = ids(row.players, "players");
    // Null is the observed empty shape. An omitted field is not evidence of emptiness.
    const reserve = ids(row.reserve === null ? [] : row.reserve, "reserve");
    const taxi = ids(row.taxi === null || (row.taxi === undefined && settings.taxi_slots === 0) ? [] : row.taxi, "taxi");
    if (!Array.isArray(row.starters) || row.starters.length !== startingCount) throw new Error("Incomplete league ownership: missing starting slots.");
    const starters = ids(Array.isArray(row.starters) ? row.starters.filter((id) => id !== "0") : row.starters, "starters");
    if (starters.some((id) => !players.includes(id) || reserve.includes(id) || taxi.includes(id))) throw new Error("Incomplete league ownership: invalid starter membership.");
    const coOwners = row.co_owners === null || row.co_owners === undefined ? [] : ids(row.co_owners, "co-owners");
    if (row.owner_id !== null && (typeof row.owner_id !== "string" || !/^\d{1,30}$/.test(row.owner_id))) throw new Error("Incomplete league ownership: invalid owner.");
    for (const id of new Set([...players, ...reserve, ...taxi])) {
      if (owners.has(id)) throw new Error(`Incomplete league ownership: player ${id} belongs to multiple rosters.`);
      owners.set(id, rosterId);
    }
    if (row.owner_id === request.ownerId || coOwners.includes(request.ownerId)) {
      if (own) throw new Error("The user does not uniquely identify a league roster.");
      own = { rosterId, players, protectedIds: [...new Set([...reserve, ...taxi])] };
    }
  }
  if (!own) throw new Error("The user does not uniquely identify a league roster.");
  return { leagueId: request.leagueId, ownerId: request.ownerId, rosterId: own.rosterId, rosterCount: count, ownedPlayerIds: [...owners.keys()].sort(), ownPlayerIds: [...own.players], protectedPlayerIds: own.protectedIds, retrievedAt: request.now };
}
/** Exact saved public-connection handoff; current week is resolved only on user request. */
export function waiverComparisonHref(connection: { leagueId: string; ownerId: string }): string {
  if (!/^\d{1,30}$/.test(connection.leagueId) || !/^\d{1,30}$/.test(connection.ownerId)) throw new Error("Invalid saved Sleeper connection.");
  return `/waivers?${new URLSearchParams({ leagueId: connection.leagueId, ownerId: connection.ownerId })}`;
}
