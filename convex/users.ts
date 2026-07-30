import { v } from "convex/values";

import { internalMutation, mutation, query } from "./_generated/server";
import { callerEntitlements, currentUser, subscriptionFor } from "./lib/auth";

import {
  FREE_SUBSCRIPTION,
  effectivePlan,
  graceRemainingMs,
} from "../lib/billing/entitlements";

/**
 * Ensures a row exists for the signed-in Clerk user.
 *
 * Idempotent, and safe to race with the Clerk webhook creating the same user: both paths
 * look up by `clerkUserId` first and the unique index makes a duplicate impossible.
 */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (existing) return existing._id;

    return await ctx.db.insert("users", {
      clerkUserId: identity.subject,
      email: identity.email ?? "",
      createdAt: Date.now(),
    });
  },
});

/**
 * Everything the interface needs about the caller in one read.
 *
 * Returns a usable shape for anonymous visitors rather than null, because the product is
 * explicitly usable without an account and the interface should not have to special-case
 * that.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    const now = Date.now();

    if (!user) {
      return {
        signedIn: false,
        email: null,
        plan: "free" as const,
        entitlements: await callerEntitlements(ctx),
        graceRemainingMs: null,
      };
    }

    const subscription = await subscriptionFor(ctx, user._id);
    return {
      signedIn: true,
      email: user.email,
      plan: effectivePlan(subscription, now),
      entitlements: await callerEntitlements(ctx),
      graceRemainingMs: graceRemainingMs(subscription, now),
    };
  },
});

/**
 * Creates or updates a user from a Clerk webhook.
 *
 * Internal, so it is unreachable from a browser. Webhooks carry no authenticated identity,
 * which is why the Clerk user id arrives as an argument — the previous implementation
 * tried to read the identity from the request context here and, finding none, silently did
 * nothing at all.
 */
export const upsertFromClerk = internalMutation({
  args: { clerkUserId: v.string(), email: v.string() },
  handler: async (ctx, { clerkUserId, email }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();

    if (existing) {
      if (email !== "" && existing.email !== email) {
        await ctx.db.patch(existing._id, { email });
      }
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkUserId,
      email,
      createdAt: Date.now(),
    });
  },
});

/**
 * Deletes a user and everything they own, for a Clerk `user.deleted` event.
 *
 * Cascades explicitly. Convex has no foreign keys, so orphaned leagues and rosters would
 * otherwise persist indefinitely after an account is removed.
 */
export const deleteFromClerk = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", clerkUserId))
      .unique();
    if (!user) return;

    const rosters = await ctx.db
      .query("rosters")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const roster of rosters) await ctx.db.delete(roster._id);

    const leagues = await ctx.db
      .query("leagues")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const league of leagues) await ctx.db.delete(league._id);

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (subscription) await ctx.db.delete(subscription._id);

    await ctx.db.insert("audit", {
      kind: "user.deleted",
      userId: null,
      detail: `Removed account and ${leagues.length} league(s) for ${clerkUserId}`,
      at: Date.now(),
    });

    await ctx.db.delete(user._id);
  },
});

/** The caller's subscription, for the billing screen. */
export const subscription = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return FREE_SUBSCRIPTION;
    return await subscriptionFor(ctx, user._id);
  },
});
