import { action } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

export const recommend = action({
  args: { leagueId: v.id("leagues"), week: v.number() },
  handler: async (ctx, { leagueId, week }): Promise<{ leagueId: string; week: number; adds: unknown[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const ok = (ents as Doc<"entitlements">[]).some((e) => e.key === "waivers_faab" && e.active);
    if (!ok) throw new Error("Missing entitlement: waivers_faab");
    return { leagueId: leagueId as unknown as string, week, adds: [] };
  },
});

export const faabGuide = action({
  args: { leagueId: v.id("leagues"), week: v.number() },
  handler: async (ctx, { leagueId, week }): Promise<{ leagueId: string; week: number; bids: unknown[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const ok = (ents as Doc<"entitlements">[]).some((e) => e.key === "waivers_faab" && e.active);
    if (!ok) throw new Error("Missing entitlement: waivers_faab");
    return { leagueId: leagueId as unknown as string, week, bids: [] };
  },
});


