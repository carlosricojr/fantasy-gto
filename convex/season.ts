import { query } from "./_generated/server";

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
export const current = query({
  args: {},
  handler: async (ctx) => {
    // Bounded scan: a handful of seasons at 18 weeks each. Each week uses the index.
    const contests: Contest[] = [];
    const thisYear = new Date().getUTCFullYear();

    for (let season = thisYear - 2; season <= thisYear + 1; season += 1) {
      for (let week = 1; week <= 18; week += 1) {
        const rows = await ctx.db
          .query("contests")
          .withIndex("by_sport_season_week", (q) =>
            q.eq("sport", "nfl").eq("season", season).eq("week", week),
          )
          .collect();

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
    }

    return resolveSeasonState(contests, Date.now());
  },
});
