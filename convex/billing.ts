import { v } from "convex/values";

import { internalMutation } from "./_generated/server";

import {
  type PlanId,
  type SubscriptionStatus,
  planFromClerkKey,
  statusFromClerk,
} from "../lib/billing/entitlements";

/**
 * Billing writes.
 *
 * Every export is an `internalMutation`, reachable only from a verified webhook or another
 * server function — never from a browser. That is the structural fix for the original
 * defect, where a client-callable action granted `league_count: "unlimited"` to anyone who
 * signed in.
 *
 * These functions record *subscription state*. They never write entitlements, because
 * entitlements are derived (`lib/billing/entitlements.ts`). There is deliberately no
 * function anywhere that grants a capability directly.
 */

const planValidator = v.union(v.literal("free"), v.literal("pro"));
const statusValidator = v.union(
  v.literal("none"),
  v.literal("trialing"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
);

/**
 * Writes a user's subscription state.
 *
 * `pastDueSince` is preserved across repeated `past_due` events rather than being reset,
 * so a dunning system that retries daily cannot extend the grace period indefinitely by
 * restarting the clock. It is cleared as soon as the subscription recovers.
 */
export const setSubscription = internalMutation({
  args: {
    clerkUserId: v.string(),
    planId: planValidator,
    status: statusValidator,
    clerkSubscriptionId: v.union(v.string(), v.null()),
    currentPeriodEnd: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", args.clerkUserId))
      .unique();

    // A subscription event can arrive before the user-created event. Dropping it would
    // lose a paid upgrade, so record the gap loudly instead of failing silently.
    if (!user) {
      await ctx.db.insert("audit", {
        kind: "billing.orphan_event",
        userId: null,
        detail: `Subscription event for unknown Clerk user ${args.clerkUserId}`,
        at: Date.now(),
      });
      return;
    }

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    const now = Date.now();
    const pastDueSince =
      args.status === "past_due"
        ? (existing?.pastDueSince ?? now)
        : null;

    const next = {
      userId: user._id,
      planId: args.planId as PlanId,
      status: args.status as SubscriptionStatus,
      pastDueSince,
      currentPeriodEnd: args.currentPeriodEnd,
      clerkSubscriptionId: args.clerkSubscriptionId,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert("subscriptions", next);
    }

    await ctx.db.insert("audit", {
      kind: "billing.subscription_changed",
      userId: user._id,
      detail: `plan=${args.planId} status=${args.status}`,
      at: now,
    });
  },
});

/**
 * Applies a Clerk webhook event.
 *
 * Event names vary across Clerk's billing surface, so this matches on substrings rather
 * than an exact list. Anything unrecognised is audited and otherwise ignored: an unknown
 * event must never change access, in either direction.
 */
export const applyClerkEvent = internalMutation({
  args: {
    eventType: v.string(),
    clerkUserId: v.union(v.string(), v.null()),
    planKey: v.union(v.string(), v.null()),
    status: v.union(v.string(), v.null()),
    subscriptionId: v.union(v.string(), v.null()),
    currentPeriodEnd: v.union(v.number(), v.null()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const now = Date.now();

    if (!args.clerkUserId) {
      await ctx.db.insert("audit", {
        kind: "billing.unresolvable_event",
        userId: null,
        detail: `${args.eventType} carried no Clerk user id`,
        at: now,
      });
      return { applied: false };
    }

    const type = args.eventType.toLowerCase();
    const isSubscriptionEvent =
      type.includes("subscription") || type.includes("subscriptionitem");
    const isPaymentFailure =
      type.includes("payment_failed") || type.includes("payment_attempt.failed");

    if (!isSubscriptionEvent && !isPaymentFailure) {
      await ctx.db.insert("audit", {
        kind: "billing.ignored_event",
        userId: null,
        detail: args.eventType,
        at: now,
      });
      return { applied: false };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", args.clerkUserId!))
      .unique();
    if (!user) {
      await ctx.db.insert("audit", {
        kind: "billing.orphan_event",
        userId: null,
        detail: `${args.eventType} for unknown Clerk user ${args.clerkUserId}`,
        at: now,
      });
      return { applied: false };
    }

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    // A payment failure carries no plan; keep whatever plan is already recorded.
    const planId: PlanId = isPaymentFailure
      ? (existing?.planId ?? "pro")
      : planFromClerkKey(args.planKey);

    const status: SubscriptionStatus = isPaymentFailure
      ? "past_due"
      : statusFromClerk(args.status);

    const pastDueSince = status === "past_due" ? (existing?.pastDueSince ?? now) : null;

    const next = {
      userId: user._id,
      planId,
      status,
      pastDueSince,
      currentPeriodEnd: args.currentPeriodEnd,
      clerkSubscriptionId: args.subscriptionId,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert("subscriptions", next);
    }

    await ctx.db.insert("audit", {
      kind: "billing.applied",
      userId: user._id,
      detail: `${args.eventType} -> plan=${planId} status=${status}`,
      at: now,
    });

    return { applied: true };
  },
});
