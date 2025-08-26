import { action } from "../_generated/server";
import { v } from "convex/values";
import { getCurrentUser, ensureEntitlement } from "./_guards";

export const importCsv = action({
  args: { csv: v.string() },
  handler: async (ctx, { csv }) => {
    const user = await getCurrentUser(ctx);
    await ensureEntitlement(ctx, user._id, "import_export");
    const rows = csv.trim().split(/\r?\n/).map((l) => l.split(","));
    const header = rows.shift() || [];
    const items = rows.map((r) => Object.fromEntries(r.map((v, i) => [header[i] || `col${i}`, v])));
    return { ok: true, items };
  },
});

export const exportCsv = action({
  args: { lineup: v.array(v.object({ player: v.string(), pos: v.string() })) },
  handler: async (ctx, { lineup }) => {
    const user = await getCurrentUser(ctx);
    await ensureEntitlement(ctx, user._id, "import_export");
    const header = ["player", "pos"];
    const rows = lineup.map((r) => [r.player, r.pos]);
    const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
    return { csv };
  },
});

export const solve = action({
  args: { roster: v.array(v.object({ playerId: v.id("players"), pos: v.string(), proj: v.number() })) },
  handler: async (ctx, { roster }) => {
    const user = await getCurrentUser(ctx);
    await ensureEntitlement(ctx, user._id, "start_sit_basic");
    // Greedy by projection as placeholder
    const starters = roster.sort((a, b) => b.proj - a.proj).slice(0, Math.min(9, roster.length));
    return { starters };
  },
});


