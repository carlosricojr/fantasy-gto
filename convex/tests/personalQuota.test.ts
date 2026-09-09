import { convexTest } from "convex-test";
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob(["../**/*.ts", "../**/*.js", "!../**/*.d.ts", "!../**/*.test.ts", "!../tests/**"]);
afterEach(() => vi.useRealTimers());
async function setup() {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 8, 9, 12, 1));
  const t = convexTest(schema, modules);
  const free = t.withIdentity({ subject: "free" }); const pro = t.withIdentity({ subject: "pro" });
  await free.mutation(api.users.ensure, {}); await pro.mutation(api.users.ensure, {});
  await t.mutation(internal.billing.setSubscription, { clerkUserId: "pro", planId: "pro", status: "active", clerkSubscriptionId: null, currentPeriodEnd: null });
  return { t, free, pro };
}
it("admits Free roster/lookup, denies anonymous/model/waiver without writing counters", async () => {
  const { t, free } = await setup();
  await expect(t.action(api.personalTools.authorizeConnectionLookup, {})).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  await expect(free.action(api.personalTools.authorizeWeeklyImport, { model: true })).rejects.toMatchObject({ data: { code: "entitlement" } });
  await expect(free.action(api.personalTools.authorizeWaiverComparison, {})).rejects.toMatchObject({ data: { code: "entitlement" } });
  expect(await t.run(async (ctx) => (await ctx.db.query("personalUsage").take(10)).length)).toBe(0);
  await free.action(api.personalTools.authorizeWeeklyImport, { model: false });
  await free.action(api.personalTools.authorizeConnectionLookup, {});
});
it("serializes parallel admission, supplies retry timing and isolates owners", async () => {
  const { free, pro } = await setup();
  const results = await Promise.allSettled(Array.from({ length: 9 }, () => free.action(api.personalTools.authorizeConnectionLookup, {})));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(6);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
  await expect(free.action(api.personalTools.authorizeConnectionLookup, {})).rejects.toMatchObject({ data: { code: "rate_limit", retryAfterSeconds: 840 } });
  await pro.action(api.personalTools.authorizeConnectionLookup, {});
  vi.advanceTimersByTime(15 * 60_000);
  await free.action(api.personalTools.authorizeConnectionLookup, {});
});
it("retains the daily cap across short windows and reuses one row", async () => {
  const { t, free } = await setup();
  for (let i = 0; i < 20; i++) {
    await free.action(api.personalTools.authorizeConnectionLookup, {});
    if (i % 5 === 4) vi.advanceTimersByTime(15 * 60_000);
  }
  await expect(free.action(api.personalTools.authorizeConnectionLookup, {})).rejects.toMatchObject({ data: { code: "rate_limit" } });
  expect(await t.run(async (ctx) => (await ctx.db.query("personalUsage").take(10)).length)).toBe(1);
  vi.advanceTimersByTime(24 * 60 * 60_000);
  await free.action(api.personalTools.authorizeConnectionLookup, {});
});
it("rechecks expired Pro subscriptions even after earlier successful model admission", async () => {
  const { t, pro } = await setup();
  await pro.action(api.personalTools.authorizeWeeklyImport, { model: true });
  await t.mutation(internal.billing.setSubscription, { clerkUserId: "pro", planId: "pro", status: "canceled", clerkSubscriptionId: null, currentPeriodEnd: Date.now() - 1 });
  await expect(pro.action(api.personalTools.authorizeWeeklyImport, { model: true })).rejects.toMatchObject({ data: { code: "entitlement" } });
});
