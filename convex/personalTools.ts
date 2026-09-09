import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation } from "./_generated/server";
import { admitPersonalOperation } from "./lib/personalQuota";

/** Called with the user's Clerk token before any expensive waiver-source request. */
export const authorizeWaiverComparison = action({
  args: {}, returns: v.null(),
  handler: async (ctx): Promise<null> => ctx.runMutation(internal.personalTools.admit, { operation: "waiver" }),
});
export const authorizeWeeklyImport = action({ args: { model: v.boolean() }, returns: v.null(),
  handler: async (ctx, { model }): Promise<null> => ctx.runMutation(internal.personalTools.admit, { operation: model ? "model" : "roster" }),
});
export const authorizeConnectionLookup = action({ args: {}, returns: v.null(),
  handler: async (ctx): Promise<null> => ctx.runMutation(internal.personalTools.admit, { operation: "connection" }),
});
export const admit = internalMutation({
  args: { operation: v.union(v.literal("connection"), v.literal("roster"), v.literal("model"), v.literal("waiver"), v.literal("journal-read"), v.literal("journal-refresh")) }, returns: v.null(),
  handler: async (ctx, { operation }) => { await admitPersonalOperation(ctx, operation); return null; },
});
