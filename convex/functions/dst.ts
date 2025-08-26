import { action } from "../_generated/server";
import { v } from "convex/values";
import { getCurrentUser, ensureEntitlement } from "./_guards";

export const streamers = action({
  args: { week: v.number() },
  handler: async (ctx, { week }) => {
    const user = await getCurrentUser(ctx);
    await ensureEntitlement(ctx, user._id, "dst_streamer");
    return { week, options: [] };
  },
});


