import { action } from "../_generated/server";
import { v } from "convex/values";
import { getCurrentUser, ensureEntitlement } from "./_guards";

export const recommend = action({
  args: { leagueId: v.id("leagues"), week: v.number() },
  handler: async (ctx, { leagueId, week }) => {
    const user = await getCurrentUser(ctx);
    await ensureEntitlement(ctx, user._id, "waivers_faab");
    return { leagueId, week, adds: [] };
  },
});

export const faabGuide = action({
  args: { leagueId: v.id("leagues"), week: v.number() },
  handler: async (ctx, { leagueId, week }) => {
    const user = await getCurrentUser(ctx);
    await ensureEntitlement(ctx, user._id, "waivers_faab");
    return { leagueId, week, bids: [] };
  },
});


