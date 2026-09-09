import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob(["../**/*.ts", "../**/*.js", "!../**/*.d.ts", "!../**/*.test.ts", "!../tests/**"]);
const connection = { leagueId: "123", ownerId: "456", leagueName: "League", username: "manager", season: 2026 };
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "owner" });
  const other = t.withIdentity({ subject: "other" });
  await owner.mutation(api.users.ensure, {}); await other.mutation(api.users.ensure, {});
  return { t, owner, other };
}
const manual = { name: "Manual", season: 2026, platform: "manual", externalId: null, scoringId: "ppr", teams: 12, playoffTeams: 6, championshipWeek: 17, slots: [] };

it("keeps connections private, idempotent and owned on removal", async () => {
  const { t, owner, other } = await setup();
  const id = await owner.mutation(internal.sleeperConnections.store, connection);
  expect(await owner.mutation(internal.sleeperConnections.store, connection)).toBe(id);
  expect(await owner.query(api.sleeperConnections.list, {})).toHaveLength(1);
  expect(await other.query(api.sleeperConnections.list, {})).toEqual([]);
  expect(await t.query(api.sleeperConnections.list, {})).toEqual([]);
  await expect(other.mutation(api.sleeperConnections.remove, { id })).rejects.toMatchObject({ data: { code: "not_found" } });
  await owner.mutation(api.sleeperConnections.remove, { id });
  expect(await owner.query(api.sleeperConnections.list, {})).toEqual([]);
});
it("enforces the existing free cap across connection and legacy creates in both directions", async () => {
  const { owner, other } = await setup();
  await owner.mutation(internal.sleeperConnections.store, connection);
  await expect(owner.mutation(internal.sleeperConnections.store, { ...connection, leagueId: "789" })).rejects.toMatchObject({ data: { code: "entitlement" } });
  await expect(owner.mutation(api.leagues.create, manual)).rejects.toMatchObject({ data: { code: "entitlement" } });
  await other.mutation(api.leagues.create, manual);
  await expect(other.mutation(internal.sleeperConnections.store, connection)).rejects.toMatchObject({ data: { code: "entitlement" } });
});
it("rejects anonymous saves before fetching public data", async () => {
  const { t } = await setup();
  await expect(t.action(api.sleeperConnections.save, { leagueId: "123", ownerId: "456" })).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  await expect(t.mutation(internal.sleeperConnections.store, connection)).rejects.toMatchObject({ data: { code: "unauthenticated" } });
});
