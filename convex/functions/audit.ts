import { internalMutation, query } from "../_generated/server";
import { v } from "convex/values";

export const log = internalMutation({
  args: {
    kind: v.string(),
    actorUserId: v.optional(v.id("users")),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("audit", {
      kind: args.kind,
      actorUserId: args.actorUserId,
      payload: args.payload,
      ts: Date.now(),
    });
  },
});

export const countByActorAndKind = query({
  args: {
    actorUserId: v.id("users"),
    kind: v.string(),
  },
  handler: async (ctx, { actorUserId, kind }): Promise<number> => {
    const rows = await ctx.db
      .query("audit")
      .withIndex("byKindTs", (q) => q.eq("kind", kind))
      .collect();
    return rows.filter((r) => r.actorUserId === actorUserId).length;
  },
});


