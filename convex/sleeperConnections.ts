import { v } from "convex/values";
import { findSleeperConnections } from "../lib/sources/sleeper-connections";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { currentUser, invalid, notFound, requireLeagueCapacity, requireUser, unauthenticated } from "./lib/auth";

const connectionFields = { leagueId: v.string(), ownerId: v.string(), leagueName: v.string(), username: v.string(), season: v.number() };
const summary = v.object({ _id: v.id("sleeperConnections"), ...connectionFields, verifiedAt: v.number() });

export const list = query({
  args: {}, returns: v.array(summary),
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db.query("sleeperConnections").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100);
    return rows.map(({ _id, leagueId, ownerId, leagueName, username, season, verifiedAt }) => ({ _id, leagueId, ownerId, leagueName, username, season, verifiedAt }));
  },
});

/** Re-resolves public roster membership; the caller cannot supply saved display facts. */
export const save = action({
  args: { leagueId: v.string(), ownerId: v.string() }, returns: v.id("sleeperConnections"),
  handler: async (ctx, args): Promise<Id<"sleeperConnections">> => {
    if (!await ctx.auth.getUserIdentity()) throw unauthenticated();
    if (!/^\d{1,30}$/.test(args.leagueId) || !/^\d{1,30}$/.test(args.ownerId)) throw invalid("Supply a valid Sleeper league and user ID.");
    await ctx.runMutation(internal.personalTools.admit, { operation: "connection" });
    const result = await findSleeperConnections({ leagueInput: args.leagueId, username: args.ownerId });
    const connection = result.connections.find((row) => row.leagueId === args.leagueId && row.ownerId === args.ownerId);
    if (!connection) throw invalid("That Sleeper manager has no roster in this league.");
    return await ctx.runMutation(internal.sleeperConnections.store, connection);
  },
});

export const store = internalMutation({
  args: connectionFields, returns: v.id("sleeperConnections"),
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db.query("sleeperConnections").withIndex("by_user_league_owner", (q) => q.eq("userId", user._id).eq("leagueId", args.leagueId).eq("ownerId", args.ownerId)).first();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, verifiedAt: Date.now() });
      return existing._id;
    }
    await requireLeagueCapacity(ctx, user._id);
    const count = await ctx.db.query("sleeperConnections").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100);
    if (count.length >= 100) throw invalid("This connection list supports 100 bookmarks. Remove an old bookmark before adding another.");
    const now = Date.now();
    return ctx.db.insert("sleeperConnections", { ...args, userId: user._id, createdAt: now, verifiedAt: now });
  },
});

export const remove = mutation({
  args: { id: v.id("sleeperConnections") }, returns: v.null(),
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.userId !== user._id) throw notFound("That saved connection does not exist.");
    await ctx.db.delete(id);
    return null;
  },
});
