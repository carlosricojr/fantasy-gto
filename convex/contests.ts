import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";
import schema from "./schema";
import { requireUser } from "./lib/auth";
import { READ_LIMITS, completeRows, seasonArgs, weekArgs } from "./lib/read-bounds";

const contestDoc = v.object({ ...schema.tables.contests.validator.fields, _id: v.id("contests"), _creationTime: v.number() });

/** Schedule, scores, and market lines. */

/** Contests for a week, used for game context and to resolve the current week. */
export const forWeek = query({
  args: { season: v.number(), week: v.number() },
  handler: async (ctx, { season, week }) => {
    await requireUser(ctx);
    weekArgs(season, week);
    const rows = await ctx.db
      .query("contests")
      .withIndex("by_sport_season_week", (q) =>
        q.eq("sport", "nfl").eq("season", season).eq("week", week),
      )
      .take(READ_LIMITS.weekContests + 1);
    return completeRows(rows, READ_LIMITS.weekContests, "Weekly schedule");
  },
  returns: v.array(contestDoc),
});

/**
 * Every contest in a season.
 *
 * A single range scan over the (sport, season) prefix of the compound index. Bounded by
 * the regular-season domain, with an explicit overflow check for inconsistent stored data.
 * Constraining week as well would turn one query into eighteen.
 */
export const forSeason = query({
  args: { season: v.number() },
  handler: async (ctx, { season }) => {
    await requireUser(ctx);
    seasonArgs(season);
    const rows = await ctx.db
      .query("contests")
      .withIndex("by_sport_season_week", (q) => q.eq("sport", "nfl").eq("season", season))
      .take(READ_LIMITS.seasonContests + 1);
    return completeRows(rows, READ_LIMITS.seasonContests, "Season schedule");
  },
  returns: v.array(contestDoc),
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
        .first();
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
