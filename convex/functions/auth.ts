import { query, mutation } from "../_generated/server";

export const getSession = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    return { authenticated: Boolean(identity), clerkUserId: identity?.subject ?? null };
  },
});

export const getUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("byClerk", (q) => q.eq("clerkUserId", identity.subject))
      .first();
    return user;
  },
});

export const getEntitlements = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const user = await ctx.db
      .query("users")
      .withIndex("byClerk", (q) => q.eq("clerkUserId", identity.subject))
      .first();
    if (!user) return [];
    const ents = await ctx.db
      .query("entitlements")
      .withIndex("byUserKey", (q) => q.eq("userId", user._id))
      .collect();
    return ents;
  },
});

export const ensureUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const existing = await ctx.db
      .query("users")
      .withIndex("byClerk", (q) => q.eq("clerkUserId", identity.subject))
      .first();
    if (existing) return existing;
    const userId = await ctx.db.insert("users", {
      clerkUserId: identity.subject,
      email: identity.email ?? "",
      planDisplay: "Free",
      createdAt: Date.now(),
    });
    return await ctx.db.get(userId);
  },
});


