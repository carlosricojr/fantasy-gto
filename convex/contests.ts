import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";

/** Schedule, scores, and market lines. */

/** Contests for a week, used for game context and to resolve the current week. */
export const forWeek = query({
  args: { season: v.number(), week: v.number() },
  handler: async (ctx, { season, week }) => {
    return await ctx.db
      .query("contests")
      .withIndex("by_sport_season_week", (q) =>
        q.eq("sport", "nfl").eq("season", season).eq("week", week),
      )
      .collect();
  },
});

/**
 * Every contest in a season.
 *
 * Bounded by construction — a season is 272 regular-season games — so collecting the
 * index range is appropriate here rather than a full table scan.
 */
export const forSeason = query({
  args: { season: v.number() },
  handler: async (ctx, { season }) => {
    const weeks = [];
    for (let week = 1; week <= 18; week += 1) {
      const rows = await ctx.db
        .query("contests")
        .withIndex("by_sport_season_week", (q) =>
          q.eq("sport", "nfl").eq("season", season).eq("week", week),
        )
        .collect();
      weeks.push(...rows);
    }
    return weeks;
  },
});

/** Upserts schedule rows. Internal-only, idempotent by external id. */
export const upsertBatch = internalMutation({
  args: {
    rows: v.array(
      v.object({
        externalId: v.string(),
        season: v.number(),
        week: v.number(),
        homeTeam: v.string(),
        awayTeam: v.string(),
        startsAt: v.union(v.string(), v.null()),
        spread: v.union(v.number(), v.null()),
        total: v.union(v.number(), v.null()),
        homeScore: v.union(v.number(), v.null()),
        awayScore: v.union(v.number(), v.null()),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const now = Date.now();
    for (const row of rows) {
      const existing = await ctx.db
        .query("contests")
        .withIndex("by_external_id", (q) => q.eq("externalId", row.externalId))
        .unique();
      const doc = { sport: "nfl", ...row, updatedAt: now };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
      } else {
        await ctx.db.insert("contests", doc);
      }
    }
    return { count: rows.length };
  },
});
