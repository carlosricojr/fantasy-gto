import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";
import { GRACE_PERIOD_MS } from "../../lib/billing/entitlements";

/**
 * Billing event handling.
 *
 * The original implementation resolved the acting user through
 * `ctx.auth.getUserIdentity()` inside a webhook, where there is no identity, so every
 * billing event was silently discarded — subscriptions never applied and cancellations
 * never took effect. That defect is invisible to a unit test of the entitlement resolver,
 * which is why these exercise the Convex mutations directly.
 */
const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../tests/**",
]);

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject, issuer: "https://clerk.test" });
}

const NO_EVENT_EXTRAS = {
  subscriptionId: null,
  currentPeriodEnd: null,
};

describe("applyClerkEvent", () => {
  it("upgrades a user on a subscription event", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u1").mutation(api.users.ensure, {});

    const result = await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u1",
      planKey: "pro_monthly",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect(result.applied).toBe(true);
    const me = await asUser(t, "u1").query(api.users.me, {});
    expect(me.plan).toBe("pro");
  });

  it("downgrades on cancellation once the paid period has ended", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u2").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u2",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u2",
      planKey: "pro",
      status: "canceled",
      subscriptionId: null,
      currentPeriodEnd: Date.now() - 1000,
    });

    expect((await asUser(t, "u2").query(api.users.me, {})).plan).toBe("free");
  });

  it("honors the remainder of an already-paid period after cancellation", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u3").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u3",
      planKey: "pro",
      status: "canceled",
      subscriptionId: null,
      currentPeriodEnd: Date.now() + 60_000,
    });

    expect((await asUser(t, "u3").query(api.users.me, {})).plan).toBe("pro");
  });

  it("fails closed on an unrecognized plan key and records why", async () => {
    // A renamed price in the billing dashboard must never silently grant Pro, and the
    // resulting downgrade must be diagnosable rather than mysterious.
    const t = convexTest(schema, modules);
    await asUser(t, "u4").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u4",
      planKey: "pro_lite",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "u4").query(api.users.me, {})).plan).toBe("free");
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.unknown_plan_key")).toBe(true);
  });

  it("keeps Pro during the grace window after a failed payment", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u5").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u5",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "paymentAttempt.updated",
      clerkUserId: "u5",
      planKey: null,
      status: "failed",
      ...NO_EVENT_EXTRAS,
    });

    const me = await asUser(t, "u5").query(api.users.me, {});
    expect(me.plan).toBe("pro");
    expect(me.graceRemainingMs).not.toBeNull();
    expect(me.graceRemainingMs!).toBeLessThanOrEqual(GRACE_PERIOD_MS);
  });

  it("does not treat a successful payment attempt as a failure", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u6").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u6",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "paymentAttempt.updated",
      clerkUserId: "u6",
      planKey: null,
      status: "paid",
      ...NO_EVENT_EXTRAS,
    });

    const me = await asUser(t, "u6").query(api.users.me, {});
    expect(me.plan).toBe("pro");
    expect(me.graceRemainingMs).toBeNull();
  });

  it("does not grant Pro from a payment failure for an unknown subscription", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u7").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "paymentAttempt.updated",
      clerkUserId: "u7",
      planKey: null,
      status: "failed",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "u7").query(api.users.me, {})).plan).toBe("free");
  });

  it("does not restart the grace clock on a repeated failure", async () => {
    // A dunning system retrying daily must not extend the window indefinitely.
    const t = convexTest(schema, modules);
    await asUser(t, "u8").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u8",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "paymentAttempt.updated",
      clerkUserId: "u8",
      planKey: null,
      status: "failed",
      ...NO_EVENT_EXTRAS,
    });
    const first = await t.run(async (ctx) =>
      (await ctx.db.query("subscriptions").first())?.pastDueSince,
    );

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "paymentAttempt.updated",
      clerkUserId: "u8",
      planKey: null,
      status: "failed",
      ...NO_EVENT_EXTRAS,
    });
    const second = await t.run(async (ctx) =>
      (await ctx.db.query("subscriptions").first())?.pastDueSince,
    );

    expect(second).toBe(first);
  });

  it("does not downgrade a subscriber when the event carries no plan key", async () => {
    // Clerk spells the plan in several places. If none matched, the event says nothing
    // about the plan — resolving it to "free" would drop a paying customer instantly,
    // because effectivePlan short-circuits on planId === "free" and the grace window
    // stops applying entirely.
    const t = convexTest(schema, modules);
    await asUser(t, "keep").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "keep",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "keep",
      planKey: null,
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "keep").query(api.users.me, {})).plan).toBe("pro");
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.unresolved_plan_key")).toBe(true);
  });

  it("preserves the grace window when a past_due event carries no plan key", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "grace").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "grace",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.past_due",
      clerkUserId: "grace",
      planKey: null,
      status: "past_due",
      ...NO_EVENT_EXTRAS,
    });

    const me = await asUser(t, "grace").query(api.users.me, {});
    expect(me.plan).toBe("pro");
    expect(me.graceRemainingMs).not.toBeNull();
  });

  it("still downgrades a genuinely free subscription event", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "downgrade").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "downgrade",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "downgrade",
      planKey: "free",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "downgrade").query(api.users.me, {})).plan).toBe("free");
  });

  it("ignores a delivery older than the one already applied", async () => {
    // Svix does not guarantee order, and the webhook returns 500 on failure to force a
    // retry — which re-queues that delivery behind newer ones. Without an ordering guard
    // a delayed upgrade landing after a cancellation restores Pro permanently, and no
    // later event corrects it.
    const t = convexTest(schema, modules);
    await asUser(t, "order").mutation(api.users.ensure, {});

    const cancelAt = 2_000_000;
    const upgradeAt = 1_000_000; // sent first, delivered second

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "order",
      planKey: "pro",
      status: "canceled",
      subscriptionId: null,
      currentPeriodEnd: 0,
      eventAt: cancelAt,
    });
    expect((await asUser(t, "order").query(api.users.me, {})).plan).toBe("free");

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "order",
      planKey: "pro",
      status: "active",
      subscriptionId: null,
      currentPeriodEnd: null,
      eventAt: upgradeAt,
    });

    expect((await asUser(t, "order").query(api.users.me, {})).plan).toBe("free");
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.stale_event_ignored")).toBe(true);
  });

  it("applies a newer delivery normally", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "inorder").mutation(api.users.ensure, {});

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "inorder",
      planKey: "pro",
      status: "active",
      subscriptionId: null,
      currentPeriodEnd: null,
      eventAt: 1_000_000,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "inorder",
      planKey: "pro",
      status: "canceled",
      subscriptionId: null,
      currentPeriodEnd: 0,
      eventAt: 2_000_000,
    });

    expect((await asUser(t, "inorder").query(api.users.me, {})).plan).toBe("free");
  });

  it("audits an event that carries no Clerk user id instead of guessing", async () => {
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: null,
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect(result.applied).toBe(false);
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.unresolvable_event")).toBe(true);
  });

  it("applies a subscription event that arrives before the user exists", async () => {
    // Clerk does not guarantee that `user.created` is delivered before the subscription
    // event for the same checkout. Dropping the event loses the upgrade permanently: the
    // webhook returns 200 so there is no retry, and nothing replays it later. The
    // subscriber has paid, so the account is created and the plan applied.
    const t = convexTest(schema, modules);
    const result = await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "never_seen",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect(result.applied).toBe(true);
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.provisioned_user")).toBe(true);

    // The provisional row is adopted by the real user, not duplicated, and the plan they
    // paid for is in force by the time they first sign in.
    await asUser(t, "never_seen").mutation(api.users.ensure, {});
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users.filter((u) => u.clerkUserId === "never_seen")).toHaveLength(1);
    expect((await asUser(t, "never_seen").query(api.users.me, {})).plan).toBe("pro");
  });

  it("does not end a subscription on a status it does not model", async () => {
    // Clerk emits statuses this code does not map — `upcoming` on a scheduled plan
    // change, among others. `statusFromClerk` collapses those to "none", which
    // `effectivePlan` reads as free regardless of the period already paid for, so an
    // active subscriber would be downgraded mid-period by an event that says nothing
    // about whether they are still subscribed.
    const t = convexTest(schema, modules);
    await asUser(t, "u_sched").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u_sched",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    expect((await asUser(t, "u_sched").query(api.users.me, {})).plan).toBe("pro");

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscriptionItem.updated",
      clerkUserId: "u_sched",
      planKey: "pro",
      status: "upcoming",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "u_sched").query(api.users.me, {})).plan).toBe("pro");
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.unknown_status")).toBe(true);
  });

  it("does not apply a scheduled downgrade before it takes effect", async () => {
    // Clerk represents a cancel-at-period-end or a scheduled plan change as an *upcoming*
    // item carrying the FUTURE plan key. Preserving the status but applying the plan from
    // that event writes {planId: "free", status: "active"}, and `effectivePlan`
    // short-circuits on a free plan — so the subscriber loses the period they have already
    // paid for, weeks early, while the audit row claims the status was kept.
    const t = convexTest(schema, modules);
    await asUser(t, "u_down").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u_down",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    const result = await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscriptionItem.updated",
      clerkUserId: "u_down",
      planKey: "free",
      status: "upcoming",
      ...NO_EVENT_EXTRAS,
    });

    expect(result.applied).toBe(false);
    expect((await asUser(t, "u_down").query(api.users.me, {})).plan).toBe("pro");
  });

  it("does not treat a subscription event with no status as a cancellation", async () => {
    // `statusFromClerk(null)` is "none", which reads as free. An event that omits the
    // status says nothing about whether the subscription is live, so it must not be the
    // thing that ends it — and the old path wrote no audit row either.
    const t = convexTest(schema, modules);
    await asUser(t, "u_nostatus").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u_nostatus",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u_nostatus",
      planKey: "pro",
      status: null,
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "u_nostatus").query(api.users.me, {})).plan).toBe("pro");
    const audits = await t.run(async (ctx) => await ctx.db.query("audit").collect());
    expect(audits.some((a) => a.kind === "billing.unknown_status")).toBe(true);
  });

  it("still ends a subscription on a terminal status", async () => {
    // The counterpart: "ended" is modeled, so it must revoke rather than be preserved.
    const t = convexTest(schema, modules);
    await asUser(t, "u_end").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u_end",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u_end",
      planKey: "pro",
      status: "ended",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "u_end").query(api.users.me, {})).plan).toBe("free");
  });

  it("ignores an unrelated event without changing access", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u9").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "session.created",
      clerkUserId: "u9",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    expect((await asUser(t, "u9").query(api.users.me, {})).plan).toBe("free");
  });

  it("preserves a known period end when a later payload omits it", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "u10").mutation(api.users.ensure, {});
    const periodEnd = Date.now() + 86_400_000;
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u10",
      planKey: "pro",
      status: "active",
      subscriptionId: "sub_x",
      currentPeriodEnd: periodEnd,
    });
    await t.mutation(internal.billing.applyClerkEvent, {
      eventType: "subscription.updated",
      clerkUserId: "u10",
      planKey: "pro",
      status: "active",
      ...NO_EVENT_EXTRAS,
    });

    const stored = await t.run(async (ctx) => await ctx.db.query("subscriptions").first());
    expect(stored?.currentPeriodEnd).toBe(periodEnd);
    expect(stored?.clerkSubscriptionId).toBe("sub_x");
  });
});

describe("user lifecycle", () => {
  it("provisions idempotently", async () => {
    const t = convexTest(schema, modules);
    const first = await asUser(t, "dup").mutation(api.users.ensure, {});
    const second = await asUser(t, "dup").mutation(api.users.ensure, {});
    expect(second).toBe(first);

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
  });

  it("does not race with the webhook creating the same user", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.users.upsertFromClerk, {
      clerkUserId: "race",
      email: "race@example.com",
    });
    await asUser(t, "race").mutation(api.users.ensure, {});

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("race@example.com");
  });

  it("cascades a deletion so no orphaned league survives", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "gone").mutation(api.users.ensure, {});
    await asUser(t, "gone").mutation(api.leagues.create, {
      name: "Doomed",
      season: 2025,
      platform: "manual",
      externalId: null,
      scoringId: "ppr",
      slots: [],
    });

    await t.mutation(internal.users.deleteFromClerk, { clerkUserId: "gone" });

    const remaining = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      leagues: await ctx.db.query("leagues").collect(),
      rosters: await ctx.db.query("rosters").collect(),
    }));
    expect(remaining.users).toHaveLength(0);
    expect(remaining.leagues).toHaveLength(0);
    expect(remaining.rosters).toHaveLength(0);
  });
});
