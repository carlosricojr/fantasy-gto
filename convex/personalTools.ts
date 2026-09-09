import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";
import { requireTimedEntitlement } from "./lib/timedEntitlement";

/** Called with the user's Clerk token before any expensive waiver-source request. */
export const authorizeWaiverComparison = action({
  args: {}, returns: v.null(),
  handler: async (ctx): Promise<null> => ctx.runQuery(internal.personalTools.checkWaiverAccess, { now: Date.now() }),
});
export const checkWaiverAccess = internalQuery({
  args: { now: v.number() }, returns: v.null(),
  handler: async (ctx, { now }) => { await requireTimedEntitlement(ctx, "waiver_comparison", now); return null; },
});
