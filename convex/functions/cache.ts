import { internalQuery, internalMutation } from "../_generated/server";
import { v } from "convex/values";

export const getProvider = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("providerCache")
      .withIndex("byKey", (q) => q.eq("key", key))
      .first();
    if (!row) return null;
    const age = (Date.now() - row.storedAt) / 1000;
    if (age > row.ttlSeconds) return null;
    return row.value;
  },
});

export const setProvider = internalMutation({
  args: { key: v.string(), value: v.string(), provider: v.string(), ttlSeconds: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerCache")
      .withIndex("byKey", (q) => q.eq("key", args.key))
      .first();
    const doc = { key: args.key, value: args.value, provider: args.provider, ttlSeconds: args.ttlSeconds, storedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return existing._id;
    }
    return ctx.db.insert("providerCache", doc);
  },
});


