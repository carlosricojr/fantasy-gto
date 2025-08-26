import { action } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";

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
  ): Promise<{ ok: true; leagueId: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const leagueEnt = ents.find((e: { key: string; active: boolean; value?: unknown }) => e.key === "league_count" && e.active);
    let limit: number | typeof Infinity = 3;
    if (leagueEnt) {
      const val = (leagueEnt as any).value;
      if (val === "unlimited") limit = Infinity;
      else if (typeof val === "number") limit = val;
      else if (typeof val === "string") {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) limit = n;
      }
    }
    if (Number.isFinite(limit)) {
      const count = await ctx.runQuery(api.functions.audit.countByActorAndKind, {
        actorUserId: user._id,
        kind: "league_import",
      });
      if (count >= (limit as number)) throw new Error("League import limit reached for current plan");
    }
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
    if (!league) throw new Error("League upsert failed");
    await ctx.runAction(api.functions.sync.espn.ingestWeek, { season, leagueId, week, s2, swid });
    await ctx.runMutation(api.functions.proj.buildFeatures, { season, week });
    await ctx.runMutation(api.functions.proj.runProjections, { season, week });
    await ctx.runMutation(internal.functions.audit.log, {
      kind: "onboarding_ttfp_done",
      actorUserId: user._id,
      payload: { season, leagueId, week },
    });
    return { ok: true, leagueId: league._id };
  },
});


