import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { currentUser, requireLeagueCapacity, requireUser } from "./lib/auth";

/**
 * Leagues and rosters.
 *
 * The free-tier league cap is enforced here, server-side, in the same transaction that
 * creates the league. A client cannot bypass it, and a race between two concurrent creates
 * cannot exceed the cap because Convex mutations are serialisable.
 */

const slotValidator = v.object({
  slotId: v.string(),
  slotLabel: v.string(),
  eligiblePositions: v.array(v.string()),
  playerId: v.union(v.string(), v.null()),
});

/** The caller's leagues. Returns empty for anonymous visitors rather than throwing. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return await ctx.db
      .query("leagues")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

/**
 * Creates a league, or returns the existing one for the same external identity.
 *
 * Idempotent by (user, platform, externalId) so re-running an import does not produce
 * duplicates. The capacity check is skipped when an existing league is found, because
 * re-importing something you already have should not be blocked by your own cap.
 */
export const create = mutation({
  args: {
    name: v.string(),
    season: v.number(),
    platform: v.string(),
    externalId: v.union(v.string(), v.null()),
    scoringId: v.string(),
    slots: v.array(slotValidator),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);

    if (args.externalId !== null) {
      const existing = await ctx.db
        .query("leagues")
        .withIndex("by_user_platform_external", (q) =>
          q
            .eq("userId", user._id)
            .eq("platform", args.platform)
            .eq("externalId", args.externalId),
        )
        .unique();
      if (existing) return existing._id;
    }

    await requireLeagueCapacity(ctx, user._id);

    const now = Date.now();
    const leagueId = await ctx.db.insert("leagues", {
      userId: user._id,
      sport: "nfl",
      platform: args.platform,
      externalId: args.externalId,
      name: args.name,
      season: args.season,
      scoringId: args.scoringId,
      createdAt: now,
    });

    await ctx.db.insert("rosters", {
      leagueId,
      userId: user._id,
      name: "My team",
      slots: args.slots,
      bench: [],
      updatedAt: now,
    });

    return leagueId;
  },
});

/** Deletes a league and its rosters. Ownership is verified, not assumed. */
export const remove = mutation({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }) => {
    const user = await requireUser(ctx);
    const league = await ctx.db.get(leagueId);
    if (!league || league.userId !== user._id) {
      throw new Error("That league does not exist.");
    }

    const rosters = await ctx.db
      .query("rosters")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .collect();
    for (const roster of rosters) await ctx.db.delete(roster._id);

    await ctx.db.delete(leagueId);
  },
});

/** A league with its roster, or null when it is missing or not the caller's. */
export const withRoster = query({
  args: { leagueId: v.id("leagues") },
  handler: async (ctx, { leagueId }) => {
    const user = await currentUser(ctx);
    if (!user) return null;

    const league = await ctx.db.get(leagueId);
    if (!league || league.userId !== user._id) return null;

    const roster = await ctx.db
      .query("rosters")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();

    return { league, roster };
  },
});

/**
 * Replaces a roster's slots and bench.
 *
 * The whole roster is written at once because a lineup is only meaningful as a complete
 * record; a partial update could leave the same player in two slots.
 */
export const setRoster = mutation({
  args: {
    leagueId: v.id("leagues"),
    slots: v.array(slotValidator),
    bench: v.array(v.string()),
  },
  handler: async (ctx, { leagueId, slots, bench }) => {
    const user = await requireUser(ctx);
    const league = await ctx.db.get(leagueId);
    if (!league || league.userId !== user._id) {
      throw new Error("That league does not exist.");
    }

    const assigned = slots
      .map((slot) => slot.playerId)
      .filter((id): id is string => id !== null);
    if (new Set(assigned).size !== assigned.length) {
      throw new Error("A player cannot occupy two slots at once.");
    }

    const existing: Doc<"rosters"> | null = await ctx.db
      .query("rosters")
      .withIndex("by_league", (q) => q.eq("leagueId", leagueId))
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { slots, bench, updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("rosters", {
      leagueId,
      userId: user._id,
      name: "My team",
      slots,
      bench,
      updatedAt: now,
    });
  },
});
