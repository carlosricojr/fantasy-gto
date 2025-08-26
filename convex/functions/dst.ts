import { action } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

export const streamers = action({
  args: { week: v.number() },
  handler: async (ctx, { week }): Promise<{ week: number; options: unknown[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const ok = (ents as Doc<"entitlements">[]).some((e) => e.key === "dst_streamer" && e.active);
    if (!ok) throw new Error("Missing entitlement: dst_streamer");
    return { week, options: [] };
  },
});


