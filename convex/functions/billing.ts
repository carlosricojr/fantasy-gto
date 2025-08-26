import { action, mutation } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";

export const syncEntitlements = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    // Placeholder: fetch from Clerk server-side using Clerk SDK or REST
    const entitlements = [
      { key: "league_count", value: "unlimited", active: true },
    ];
    const user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) return { updated: 0 };
    for (const e of entitlements) {
      await ctx.runMutation(api.functions.billing._upsertEntitlement, {
        userId: user._id,
        key: e.key,
        value: e.value,
        active: e.active,
      });
    }
    return { updated: entitlements.length };
  },
});

export const _upsertEntitlement = mutation({
  args: {
    userId: v.id("users"),
    key: v.string(),
    value: v.optional(v.any()),
    active: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("byUserKey", (q) => q.eq("userId", args.userId).eq("key", args.key))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value, active: args.active, updatedAt: now });
      return existing._id;
    }
    return ctx.db.insert("entitlements", {
      userId: args.userId,
      key: args.key,
      value: args.value,
      active: args.active,
      source: "clerk",
      updatedAt: now,
    });
  },
});

export const applyEvent = action({
  args: { event: v.any() },
  handler: async (ctx, { event }) => {
    const identity = await ctx.auth.getUserIdentity();
    const user = identity ? await ctx.runQuery(api.functions.auth.getUser, {}) : null;
    const ensured = identity && !user ? await ctx.runMutation(api.functions.auth.ensureUser, {}) : user;
    // Interpret basic Clerk Billing event types to toggle entitlements
    const type = (event?.type ?? "") as string;
    if (ensured) {
      if (type.includes("entitlement.granted")) {
        const key = (event?.data?.entitlement?.key ?? "") as string;
        const value = event?.data?.entitlement?.value ?? true;
        await ctx.runMutation(api.functions.billing._upsertEntitlement, {
          userId: ensured._id,
          key,
          value,
          active: true,
        });
      } else if (type.includes("entitlement.revoked")) {
        const key = (event?.data?.entitlement?.key ?? "") as string;
        await ctx.runMutation(api.functions.billing._upsertEntitlement, {
          userId: ensured._id,
          key,
          value: null,
          active: false,
        });
      }
    }
    await ctx.runMutation(internal.functions.audit.log, { kind: "billing_event", actorUserId: ensured?._id, payload: event });
    return { ok: true, type: (event as { type?: string })?.type };
  },
});


