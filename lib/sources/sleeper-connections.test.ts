import { expect, it } from "vitest";
import { findSleeperConnections } from "./sleeper-connections";

const league = { league_id: "123", name: "League", sport: "nfl", season: "2026" };
function fixture(overrides: Record<string, unknown> = {}) {
  const paths: Record<string, unknown> = { "/state/nfl": { season: "2026", week: 8 }, "/user/manager": { user_id: "456", username: "manager" }, "/user/456": { user_id: "456", username: "manager" }, "/user/456/leagues/nfl/2026": [league], "/league/123": league, "/league/123/rosters": [{ league_id: "123", roster_id: 1, owner_id: "456", co_owners: ["789"] }], "/league/123/users": [{ user_id: "456", username: "manager" }, { user_id: "789", username: "coowner" }], ...overrides };
  return async (url: string) => { expect(url).toMatch(/^https:\/\/api\.sleeper\.app\/v1\//); const path = new URL(url).pathname.slice(3); if (!(path in paths)) throw new Error(`Unexpected URL ${url}`); return paths[path]; };
}
it("finds current leagues by username without downloading player dumps", async () => {
  expect(await findSleeperConnections({ username: "@manager" }, fixture())).toEqual({ season: 2026, week: 8, warnings: [], connections: [{ leagueId: "123", ownerId: "456", username: "manager", leagueName: "League", season: 2026 }] });
});
it("lists managers from a league URL and verifies a selected owner or coowner", async () => {
  expect((await findSleeperConnections({ leagueInput: "https://sleeper.com/leagues/123/team" }, fixture())).connections).toHaveLength(2);
  expect((await findSleeperConnections({ leagueInput: "123", username: "456" }, fixture())).connections).toHaveLength(1);
});
it("fails closed on wrong season, missing user and ambiguous roster ownership", async () => {
  await expect(findSleeperConnections({ leagueInput: "123" }, fixture({ "/league/123": { ...league, season: "2025" } }))).rejects.toThrow("current season");
  await expect(findSleeperConnections({ username: "manager" }, fixture({ "/user/manager": null }))).rejects.toThrow("not found");
  await expect(findSleeperConnections({ leagueInput: "123" }, fixture({ "/league/123/rosters": [{ league_id: "123", roster_id: 1, owner_id: "456" }, { league_id: "123", roster_id: 2, owner_id: "456" }] }))).rejects.toThrow("multiple rosters");
  await expect(findSleeperConnections({ leagueInput: "123" }, fixture({ "/league/123/rosters": [{ league_id: "999", roster_id: 1, owner_id: "456" }] }))).rejects.toThrow("roster identity");
});
it("rejects malicious inputs before a request and unsupported live week", async () => {
  const reject = async () => { throw new Error("unexpected request"); };
  await expect(findSleeperConnections({ leagueInput: "https://attacker.test/leagues/123" }, reject)).rejects.toThrow("league ID");
  await expect(findSleeperConnections({ username: "../../" }, reject)).rejects.toThrow("valid Sleeper");
  await expect(findSleeperConnections({ username: "manager" }, fixture({ "/state/nfl": { season: "2026", week: 0 } }))).rejects.toThrow("supported current");
});
it("bounds source-controlled names before returning or persisting them", async () => {
  const result = await findSleeperConnections({ username: "manager" }, fixture({ "/user/manager": { user_id: "456", username: "x".repeat(100000) } }));
  expect(result.connections[0].username).toHaveLength(40);
  await expect(findSleeperConnections({ leagueInput: "123" }, fixture({ "/league/123/rosters": [{ league_id: "123", roster_id: 1, owner_id: "456", co_owners: Array.from({ length: 100 }, (_, i) => String(1000 + i)) }] }))).rejects.toThrow("co-owner list");
});
