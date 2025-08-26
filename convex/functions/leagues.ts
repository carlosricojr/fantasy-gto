import { mutation } from "../_generated/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";

export const upsertImported = mutation({
  args: {
    season: v.number(),
    platform: v.union(v.literal("ESPN"), v.literal("SLEEPER"), v.literal("YAHOO")),
    externalId: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { season, platform, externalId, name }): Promise<Doc<"leagues">> => {
    const existing = await ctx.db
      .query("leagues")
      .withIndex("byPlatformSeason", (q) => q.eq("platform", platform).eq("season", season))
      .collect();
    const found = existing.find((l) => l.rules?.externalId === externalId || l.name.endsWith(`#${externalId}`));
    if (found) return found as Doc<"leagues">;
    const id = await ctx.db.insert("leagues", {
      platform,
      name: (name ?? `League ${externalId}`) + ` #${externalId}`,
      season,
      scoring: {},
      rules: { externalId },
    });
    const league = await ctx.db.get(id);
    if (!league) throw new Error("Failed to insert league");
    return league;
  },
});


