import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { READ_LIMITS, completeRows } from "./lib/readBounds";

import type { Contest } from "../lib/core/domain";
import { resolveSeasonState } from "../lib/nfl/season";

/**
 * Resolves which season and week the product should display.
 *
 * Derived from the schedule rather than the calendar. At the time of writing the latest
 * complete season is 2025 while the calendar year is 2026, so anything keyed off
 * `new Date().getFullYear()` would render an empty week and look broken.
 *
 * Returns null when no schedule has been ingested, which the interface presents as an
 * explicit empty state rather than as a week with no games.
 */
const seasonState = v.union(v.null(), v.object({
  season: v.number(), week: v.number(),
  phase: v.union(v.literal("preseason"), v.literal("regular"), v.literal("offseason")),
  isComplete: v.boolean(),
}));

async function resolveCurrent(ctx: QueryCtx) {
    const contests: Contest[] = [];
    const thisYear = new Date().getUTCFullYear();

    // One range scan per season, not one per week. `by_sport_season_week` is a compound
    // index, so constraining only its (sport, season) prefix reads the whole season in a
    // single query. Constraining week as well would issue 18 queries per season — 72 in
    // total on a query that runs on every page load.
    for (let season = thisYear - 2; season <= thisYear + 1; season += 1) {
      const rows = await ctx.db
        .query("contests")
        .withIndex("by_sport_season_week", (q) =>
          q.eq("sport", "nfl").eq("season", season),
        )
        .take(READ_LIMITS.seasonContests + 1);
      completeRows(rows, READ_LIMITS.seasonContests, "Season schedule");

      for (const row of rows) {
        contests.push({
          id: row.externalId,
          period: { season: row.season, index: row.week },
          homeTeam: row.homeTeam,
          awayTeam: row.awayTeam,
          startsAt: row.startsAt,
          result:
            row.homeScore === null || row.awayScore === null
              ? null
              : { homeScore: row.homeScore, awayScore: row.awayScore },
        });
      }
    }

    return resolveSeasonState(contests, Date.now());
}

export const current = query({
  args: {},
  returns: seasonState,
  handler: async (ctx) => {
    await requireUser(ctx);
    return resolveCurrent(ctx);
  },
});

/** Scheduled ingest has no caller identity; never call the authenticated public wrapper. */
export const currentInternal = internalQuery({
  args: {},
  returns: seasonState,
  handler: resolveCurrent,
});
