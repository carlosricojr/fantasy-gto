import { query, action } from "../_generated/server";
import { v } from "convex/values";

export const getComparisons = query({
  args: { season: v.number(), week: v.number() },
  handler: async (ctx, { season, week }) => {
    const rows = (await ctx.db.query("projectionAccuracy").collect()).filter(
      (r) => r.season === season && r.week === week
    );
    const byPlatform = rows.reduce<Record<string, number[]>>((acc, r) => {
      const key = r.platformBaseline;
      if (!acc[key]) acc[key] = [];
      acc[key].push(r.absError);
      return acc;
    }, {});
    const mae = Object.fromEntries(
      Object.entries(byPlatform).map(([k, arr]) => [k, arr.reduce((a, b) => a + b, 0) / Math.max(arr.length, 1)])
    );
    return { season, week, mae };
  },
});

export const updateWeek = action({
  args: { season: v.number(), week: v.number() },
  handler: async (ctx, { season, week }) => {
    // Placeholder to compute accuracy from projections vs weeklyStats
    return { ok: true, season, week };
  },
});


