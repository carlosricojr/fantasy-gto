import { action } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { getCurrentUser, ensureLeagueCountAllowed } from "./_guards";

export const ttfp = action({
  args: {
    season: v.number(),
    leagueId: v.string(),
    week: v.number(),
    name: v.optional(v.string()),
    s2: v.optional(v.string()),
    swid: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { season, leagueId, week, name, s2, swid }
  ): Promise<{ ok: true; leagueId: string | undefined }> => {
    const user = await getCurrentUser(ctx);
    await ensureLeagueCountAllowed(ctx, user._id);
    await ctx.runMutation(internal.functions.audit.log, {
      kind: "onboarding_ttfp_start",
      actorUserId: user._id,
      payload: { season, leagueId, week },
    });
    const league = await ctx.runMutation(api.functions.leagues.upsertImported, {
      season,
      platform: "ESPN",
      externalId: leagueId,
      name,
    });
    await ctx.runAction(api.functions.sync.espn.ingestWeek, { season, leagueId, week, s2, swid });
    await ctx.runMutation(api.functions.proj.buildFeatures, { season, week });
    await ctx.runMutation(api.functions.proj.runProjections, { season, week });
    await ctx.runMutation(internal.functions.audit.log, {
      kind: "onboarding_ttfp_done",
      actorUserId: user._id,
      payload: { season, leagueId, week },
    });
    return { ok: true, leagueId: league?._id };
  },
});


