import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type ServerCtx = MutationCtx | QueryCtx; // actions don't have db; call queries/mutations from actions

export async function getCurrentUser(ctx: ServerCtx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("byClerk", (q) => q.eq("clerkUserId", identity.subject))
    .first();
  if (!user) throw new Error("User not provisioned");
  return user;
}

export async function ensureEntitlement(
  ctx: ServerCtx,
  userId: Id<"users">,
  entitlementKey: string,
): Promise<void> {
  const ent = await ctx.db
    .query("entitlements")
    .withIndex("byUserKey", (q) => q.eq("userId", userId).eq("key", entitlementKey))
    .first();
  if (!ent || !ent.active) throw new Error(`Missing entitlement: ${entitlementKey}`);
}

export async function getNumericEntitlement(
  ctx: ServerCtx,
  userId: Id<"users">,
  entitlementKey: string,
  defaultValue: number,
): Promise<number> {
  const ent = await ctx.db
    .query("entitlements")
    .withIndex("byUserKey", (q) => q.eq("userId", userId).eq("key", entitlementKey))
    .first();
  if (!ent || !ent.active) return defaultValue;
  const val = ent.value;
  if (val === "unlimited") return Number.POSITIVE_INFINITY;
  const n = typeof val === "number" ? val : Number(val);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

export async function ensureLeagueCountAllowed(
  ctx: ServerCtx,
  userId: Id<"users">,
): Promise<void> {
  const limit = await getNumericEntitlement(ctx, userId, "league_count", 3);
  if (!Number.isFinite(limit)) return; // unlimited
  const count = await ctx.runQuery(require("../_generated/api").api.functions.audit.countByActorAndKind, {
    actorUserId: userId,
    kind: "league_import",
  });
  if (count >= limit) throw new Error("League import limit reached for current plan");
}

// This module exports helpers only. Use queries/mutations in other modules to interact with DB.


