import { action } from "../_generated/server";
import { v } from "convex/values";
import { api } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";

export const importCsv = action({
  args: { csv: v.string() },
  handler: async (ctx, { csv }): Promise<{ ok: true; items: Record<string, string>[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const ok = (ents as Doc<"entitlements">[]).some((e) => e.key === "import_export" && e.active);
    if (!ok) throw new Error("Missing entitlement: import_export");
    const rows = csv.trim().split(/\r?\n/).map((l) => l.split(","));
    const header = rows.shift() || [];
    const items = rows.map((r) => Object.fromEntries(r.map((v, i) => [header[i] || `col${i}`, v])));
    return { ok: true, items };
  },
});

export const exportCsv = action({
  args: { lineup: v.array(v.object({ player: v.string(), pos: v.string() })) },
  handler: async (ctx, { lineup }): Promise<{ csv: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const ok = (ents as Doc<"entitlements">[]).some((e) => e.key === "import_export" && e.active);
    if (!ok) throw new Error("Missing entitlement: import_export");
    const header = ["player", "pos"];
    const rows = lineup.map((r) => [r.player, r.pos]);
    const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
    return { csv };
  },
});

export const solve = action({
  args: { roster: v.array(v.object({ playerId: v.id("players"), pos: v.string(), proj: v.number() })) },
  handler: async (ctx, { roster }): Promise<{ starters: { playerId: string; pos: string; proj: number }[] }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    let user = await ctx.runQuery(api.functions.auth.getUser, {});
    if (!user) {
      user = await ctx.runMutation(api.functions.auth.ensureUser, {});
      if (!user) throw new Error("Unable to provision user");
    }
    const ents = await ctx.runQuery(api.functions.auth.getEntitlements, {});
    const ok = (ents as Doc<"entitlements">[]).some((e) => e.key === "start_sit_basic" && e.active);
    if (!ok) throw new Error("Missing entitlement: start_sit_basic");
    // Greedy by projection as placeholder
    const starters = roster.sort((a, b) => b.proj - a.proj).slice(0, Math.min(9, roster.length));
    return { starters };
  },
});


