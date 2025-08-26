import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { getCurrentUser } from "./_guards";
import type { Doc } from "../_generated/dataModel";

export const buildFeatures = mutation({
  args: { season: v.number(), week: v.number() },
  handler: async (ctx, { season, week }) => {
    await getCurrentUser(ctx);
    // daily/weekly refresh entitlement gate (if needed in future)
    // Compute minimal placeholder features from weeklyStats
    const stats = await ctx.db.query("weeklyStats").collect();
    const filtered = stats.filter((s: Doc<"weeklyStats">) => s.season === season && s.week === week);
    for (const s of filtered.slice(0, 500)) {
      await ctx.db.insert("features", {
        season,
        week,
        playerId: s.playerId,
        usage: { snaps: s.raw?.snaps ?? 0 },
        context: { opponent: s.raw?.opponent ?? null },
        ema: { value: 0 },
      });
    }
    return { ok: true, count: filtered.length };
  },
});

export const runProjections = mutation({
  args: { season: v.number(), week: v.number() },
  handler: async (ctx, { season, week }) => {
    // Combine features into simple mean projections
    const feats = await ctx.db.query("features").collect();
    const f = feats.filter((x: Doc<"features">) => x.season === season && x.week === week);
    for (const x of f.slice(0, 500)) {
      await ctx.db.insert("projections", {
        season,
        week,
        playerId: x.playerId,
        pos: "FLEX",
        mean: Number(x.ema?.value ?? 0),
        floor: 0,
        ceiling: Number(x.ema?.value ?? 0) * 1.5,
        contributions: [],
        sourceVersion: "v0",
      });
    }
    return { ok: true, count: f.length };
  },
});

export const getProjections = query({
  args: { season: v.number(), week: v.number(), position: v.optional(v.string()) },
  handler: async (ctx, { season, week, position }) => {
    const rows = await ctx.db.query("projections").collect();
    const filtered = rows.filter((r) => r.season === season && r.week === week);
    return position ? filtered.filter((r) => r.pos === position) : filtered;
  },
});


