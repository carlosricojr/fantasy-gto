import { describe, expect, it } from "vitest";
import { parseWaiverOwnership } from "./waiver-pool";

const request = { leagueId: "123", ownerId: "456", now: 100000 };
const league = { league_id: "123", sport: "nfl", status: "in_season", total_rosters: 2, settings: { disable_adds: 0, taxi_slots: 1 }, roster_positions: ["RB", "BN"] };
const rosters = [
  { league_id: "123", roster_id: 6, owner_id: "456", players: ["1", "2", "3"], starters: ["1"], reserve: ["2"], taxi: ["3"] },
  { league_id: "123", roster_id: 2, owner_id: "789", players: ["4"], starters: ["4"], reserve: ["5"], taxi: ["6"] },
];
describe("strict full-league waiver ownership", () => {
  it("excludes every holding, including reserve/taxi absent from players, without confusing roster ID with seat", () => {
    expect(parseWaiverOwnership(league, rosters, request)).toEqual({ leagueId: request.leagueId, ownerId: request.ownerId, retrievedAt: request.now, rosterId: 6, rosterCount: 2, ownedPlayerIds: ["1", "2", "3", "4", "5", "6"], ownPlayerIds: ["1", "2", "3"], protectedPlayerIds: ["2", "3"] });
  });
  it.each([null, [], [rosters[0]], [...rosters, rosters[1]]])("fails closed on incomplete roster collection %j", (rows) => {
    expect(() => parseWaiverOwnership(league, rows, request)).toThrow("ownership");
  });
  it.each([
    { players: null }, { players: undefined }, { players: ["4", "4"] }, { players: ["4", 5] },
    { reserve: undefined }, { reserve: "5" }, { taxi: undefined }, { taxi: ["1"] }, { reserve: ["1"] },
    { roster_id: 6 }, { roster_id: null }, { league_id: "999" }, { starters: [] }, { starters: ["7"] }, { owner_id: undefined }, { co_owners: [123] },
  ])("rejects malformed opponent facts without assuming free agents: %j", (patch) => {
    expect(() => parseWaiverOwnership(league, [rosters[0], { ...rosters[1], ...patch }], request)).toThrow();
  });
  it("accepts observed null empty holdings and documented omission only with zero taxi slots", () => {
    const rows = rosters.map((r) => ({ ...r, reserve: null, taxi: undefined }));
    expect(parseWaiverOwnership({ ...league, settings: { ...league.settings, taxi_slots: 0 } }, rows, request).ownedPlayerIds).toEqual(["1", "2", "3", "4"]);
  });
  it("resolves a single co-owner but refuses ambiguous ownership or a foreign user", () => {
    expect(parseWaiverOwnership(league, [{ ...rosters[0], co_owners: ["999"] }, rosters[1]], { ...request, ownerId: "999" }).rosterId).toBe(6);
    expect(() => parseWaiverOwnership(league, [rosters[0], { ...rosters[1], co_owners: ["456"] }], request)).toThrow("uniquely");
    expect(() => parseWaiverOwnership(league, rosters, { ...request, ownerId: "999" })).toThrow("uniquely");
  });
  it.each([{ total_rosters: 3 }, { total_rosters: "2" }, { status: "drafting" }, { sport: "nba" }, { league_id: "999" }, { settings: {} }, { settings: { disable_adds: 1 } }])("rejects unsupported or incomplete league %j", (patch) => {
    expect(() => parseWaiverOwnership({ ...league, ...patch }, rosters, request)).toThrow();
  });
});
