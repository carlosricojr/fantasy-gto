import { convexTest } from "convex-test";
import { expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob(["../**/*.ts", "../**/*.js", "!../**/*.d.ts", "!../**/*.test.ts", "!../tests/**"]);
async function setup() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "owner" });
  const other = t.withIdentity({ subject: "other" });
  const free = t.withIdentity({ subject: "free" });
  for (const client of [owner, other, free]) await client.mutation(api.users.ensure, {});
  for (const clerkUserId of ["owner", "other"]) await t.mutation(internal.billing.setSubscription, { clerkUserId, planId: "pro", status: "active", clerkSubscriptionId: null, currentPeriodEnd: null });
  const now = Date.now();
  const snapshot = { leagueId: "123", ownerId: "456", leagueName: "League", season: 2026, week: 1, scoringId: "ppr", source: "Manual weekly points", retrievedAt: now, rosterRetrievedAt: now, projectionUpdatedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [{ id: "1", name: "Runner", positions: ["RB"], availability: "active", kickoffAt: now + 3600_000, currentSlotId: "rb", projectedPoints: 10, projectionOrigin: "manual", projectionEnteredAt: now }] };
  const args = { snapshotJson: JSON.stringify(snapshot), preferencesJson: "{}", requestId: "request-one" };
  return { t, owner, other, free, args };
}

it("freezes a server-recomputed record, idempotently without replacing its receipt time", async () => {
  const { owner, args } = await setup();
  const id = await owner.mutation(api.decisionJournal.create, args);
  const first = await owner.action(api.decisionJournal.detail, { id });
  expect(await owner.mutation(api.decisionJournal.create, args)).toBe(id);
  expect(await owner.action(api.decisionJournal.detail, { id })).toEqual(first);
  expect(JSON.parse(first!.recordJson)).toMatchObject({ inputProvenance: "user-supplied", timing: "before-listed-kickoffs", plan: { projectedPoints: 10 } });
  await expect(owner.mutation(api.decisionJournal.create, { ...args, snapshotJson: args.snapshotJson.replace('"projectedPoints":10', '"projectedPoints":20') })).rejects.toMatchObject({ data: { code: "invalid" } });
});
it("requires authenticated Pro access and never exposes another user's record", async () => {
  const { t, owner, other, free, args } = await setup();
  const id = await owner.mutation(api.decisionJournal.create, args);
  await expect(t.mutation(api.decisionJournal.create, args)).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  await expect(free.mutation(api.decisionJournal.create, args)).rejects.toMatchObject({ data: { code: "entitlement" } });
  await expect(free.action(api.decisionJournal.detail, { id })).rejects.toMatchObject({ data: { code: "entitlement" } });
  expect(await other.action(api.decisionJournal.detail, { id })).toBeNull();
  expect((await other.action(api.decisionJournal.list, { paginationOpts: { numItems: 20, cursor: null } })).page).toEqual([]);
  await expect(other.action(api.decisionJournal.refreshOutcomes, { id })).rejects.toMatchObject({ data: { code: "not_found" } });
});
it("paginates summaries with a bounded page and rejects invalid snapshots and request IDs", async () => {
  const { owner, args } = await setup();
  for (let i = 0; i < 3; i++) await owner.mutation(api.decisionJournal.create, { ...args, requestId: `request-${i}` });
  const first = await owner.action(api.decisionJournal.list, { paginationOpts: { numItems: 2, cursor: null } });
  expect(first.page).toHaveLength(2); expect(first.isDone).toBe(false);
  const bounded = await owner.action(api.decisionJournal.list, { paginationOpts: { numItems: 1, cursor: null, endCursor: first.continueCursor, maximumRowsRead: 10000 } });
  expect(bounded.page).toHaveLength(1);
  expect((await owner.action(api.decisionJournal.list, { paginationOpts: { numItems: 2, cursor: first.continueCursor } })).page).toHaveLength(1);
  await expect(owner.action(api.decisionJournal.list, { paginationOpts: { numItems: 100, cursor: null } })).rejects.toMatchObject({ data: { code: "invalid" } });
  await expect(owner.mutation(api.decisionJournal.create, { ...args, snapshotJson: "{}" })).rejects.toMatchObject({ data: { code: "invalid" } });
  await expect(owner.mutation(api.decisionJournal.create, { ...args, requestId: " " })).rejects.toMatchObject({ data: { code: "invalid" } });
});
it("appends observations without mutating decisions and restricts cross-user/internal append ownership", async () => {
  const { owner, other, args } = await setup();
  const id = await owner.mutation(api.decisionJournal.create, args);
  const before = await owner.action(api.decisionJournal.detail, { id });
  const observation = { id, observedAt: Date.now(), outcomeJson: "{}", evaluationJson: "{}" };
  await expect(other.mutation(internal.decisionJournal.appendObservation, observation)).rejects.toMatchObject({ data: { code: "not_found" } });
  await owner.mutation(internal.decisionJournal.appendObservation, observation);
  const after = await owner.action(api.decisionJournal.detail, { id });
  expect(after!.recordJson).toBe(before!.recordJson); expect(after!.observations).toHaveLength(1);
  await expect(owner.mutation(internal.decisionJournal.appendObservation, observation)).rejects.toMatchObject({ data: { code: "invalid" } });
});
it("checks effective subscriptions at server time for history and the narrow waiver capability", async () => {
  const { t, owner, free, args } = await setup();
  await owner.action(api.personalTools.authorizeWaiverComparison, {});
  await expect(free.action(api.personalTools.authorizeWaiverComparison, {})).rejects.toMatchObject({ data: { code: "entitlement" } });
  await expect(t.action(api.personalTools.authorizeWaiverComparison, {})).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  const id = await owner.mutation(api.decisionJournal.create, args);
  await t.mutation(internal.billing.setSubscription, { clerkUserId: "owner", planId: "pro", status: "canceled", clerkSubscriptionId: null, currentPeriodEnd: Date.now() - 1 });
  await expect(owner.action(api.decisionJournal.detail, { id })).rejects.toMatchObject({ data: { code: "entitlement" } });
  await expect(owner.action(api.personalTools.authorizeWaiverComparison, {})).rejects.toMatchObject({ data: { code: "entitlement" } });
});

it("serializes concurrent observation appends into one immutable observation", async () => {
  const { owner, args } = await setup();
  const id = await owner.mutation(api.decisionJournal.create, args);
  const observation = { id, observedAt: Date.now(), outcomeJson: "{}", evaluationJson: "{}" };
  const results = await Promise.allSettled([owner.mutation(internal.decisionJournal.appendObservation, observation), owner.mutation(internal.decisionJournal.appendObservation, observation)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await owner.action(api.decisionJournal.detail, { id }))!.observations).toHaveLength(1);
});

it("erases only deleted-user personal data in repeatable batches, including orphan observations", async () => {
  vi.useFakeTimers();
  try {
    const { t, owner, other, args } = await setup();
    const keep = await other.mutation(api.decisionJournal.create, args);
    const ids: Id<"weeklyDecisions">[] = [];
    for (let i = 0; i < 7; i++) ids.push(await owner.mutation(api.decisionJournal.create, { ...args, requestId: `erase-${i}` }));
    await owner.mutation(internal.sleeperConnections.store, { leagueId: "123", ownerId: "456", leagueName: "League", username: "manager", season: 2026 });
    const userId = await t.run(async (ctx) => {
      const row = await ctx.db.get(ids[0]);
      const userId = row!.userId;
      for (let i = 0; i < 55; i++) await ctx.db.insert("weeklyDecisionObservations", { userId, decisionId: ids[0], observedAt: i, outcomeJson: "{}", evaluationJson: "{}" });
      await ctx.db.delete(ids[0]);
      return userId;
    });
    await t.mutation(internal.personalData.eraseBatch, { userId });
    expect((await owner.action(api.decisionJournal.list, { paginationOpts: { numItems: 20, cursor: null } })).page).toHaveLength(6);
    await t.mutation(internal.users.deleteFromClerk, { clerkUserId: "owner" });
    await expect(owner.action(api.decisionJournal.detail, { id: ids[1] })).rejects.toMatchObject({ data: { code: "unauthenticated" } });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(internal.personalData.eraseBatch, { userId });
    const counts = await t.run(async (ctx) => ({ decisions: (await ctx.db.query("weeklyDecisions").withIndex("by_user_time", (q) => q.eq("userId", userId)).take(20)).length, observations: (await ctx.db.query("weeklyDecisionObservations").withIndex("by_user", (q) => q.eq("userId", userId)).take(100)).length, connections: (await ctx.db.query("sleeperConnections").withIndex("by_user", (q) => q.eq("userId", userId)).take(100)).length }));
    expect(counts).toEqual({ decisions: 0, observations: 0, connections: 0 });
    expect(await other.action(api.decisionJournal.detail, { id: keep })).not.toBeNull();
  } finally { vi.useRealTimers(); }
});
