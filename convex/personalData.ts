import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

/** Only the existing authenticated-webhook account erasure path schedules this. */
export const eraseBatch = internalMutation({
  args: { userId: v.id("users") }, returns: v.null(),
  handler: async (ctx, { userId }): Promise<null> => {
    // Refuse to erase a still-existing user's data, even if incorrectly scheduled.
    if (await ctx.db.get(userId)) return null;
    const connections = await ctx.db.query("sleeperConnections").withIndex("by_user", (q) => q.eq("userId", userId)).take(100);
    const decisions = await ctx.db.query("weeklyDecisions").withIndex("by_user_time", (q) => q.eq("userId", userId)).take(5);
    const observations = await ctx.db.query("weeklyDecisionObservations").withIndex("by_user", (q) => q.eq("userId", userId)).take(50);
    for (const row of [...connections, ...decisions, ...observations]) await ctx.db.delete(row._id);
    if (connections.length === 100 || decisions.length === 5 || observations.length === 50) await ctx.scheduler.runAfter(0, internal.personalData.eraseBatch, { userId });
    return null;
  },
});
