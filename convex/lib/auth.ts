import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

import {
  FREE_SUBSCRIPTION,
  type Entitlements,
  type FeatureKey,
  type Subscription,
  can,
  canAddLeague,
  entitlementsFor,
} from "../../lib/billing/entitlements";

/**
 * Server-side authorisation.
 *
 * Everything here runs inside Convex, where the caller's identity comes from a verified
 * Clerk JWT and cannot be supplied by the client. Entitlements are re-derived from the
 * stored subscription on every check rather than read from a grant table, so a stale or
 * tampered cache cannot widen access.
 *
 * Callers should reach for `requireEntitlement` rather than checking a boolean by hand;
 * a guard that throws is much harder to forget than one that returns.
 */

export type Ctx = QueryCtx | MutationCtx;

/** Thrown when the caller is not signed in. */
export class UnauthenticatedError extends Error {
  constructor() {
    super("You need to be signed in to do that.");
    this.name = "UnauthenticatedError";
  }
}

/** Thrown when the caller's plan does not include a capability. */
export class EntitlementError extends Error {
  readonly feature: FeatureKey;
  constructor(feature: FeatureKey, message: string) {
    super(message);
    this.name = "EntitlementError";
    this.feature = feature;
  }
}

/** The signed-in user's row, or null when anonymous. */
export async function currentUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", identity.subject))
    .unique();
}

/** The signed-in user's row, or throws. */
export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const user = await currentUser(ctx);
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * The stored subscription for a user, defaulting to free.
 *
 * A missing row means "never subscribed", which is exactly the free plan. Defaulting here
 * rather than requiring the row to exist removes a class of null-handling from callers and
 * guarantees the safe answer when data is absent.
 */
export async function subscriptionFor(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<Subscription> {
  const row = await ctx.db
    .query("subscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (!row) return FREE_SUBSCRIPTION;
  return {
    planId: row.planId,
    status: row.status,
    pastDueSince: row.pastDueSince,
    currentPeriodEnd: row.currentPeriodEnd,
  };
}

/**
 * Entitlements in force for a user right now.
 *
 * `Date.now()` is read here, at the I/O boundary, and passed into the pure resolver. The
 * decision logic itself stays clock-free and therefore testable.
 */
export async function entitlementsForUser(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<Entitlements> {
  return entitlementsFor(await subscriptionFor(ctx, userId), Date.now());
}

/** Entitlements for the caller, or the free tier when anonymous. */
export async function callerEntitlements(ctx: Ctx): Promise<Entitlements> {
  const user = await currentUser(ctx);
  if (!user) return entitlementsFor(FREE_SUBSCRIPTION, Date.now());
  return entitlementsForUser(ctx, user._id);
}

const FEATURE_PROMPTS: Readonly<Record<FeatureKey, string>> = {
  start_sit: "Start/sit advice",
  league_count: "Additional leagues",
  daily_refresh: "Daily projection refreshes",
  waivers_faab: "Waiver and FAAB guidance",
  dst_streamer: "The defense streamer",
  alerts: "Alerts",
  accuracy_dashboard: "The accuracy dashboard",
  import_export: "Lineup import and export",
  performance_history: "Season performance history",
};

/**
 * Requires a capability, throwing a message the interface can show directly.
 *
 * Returns the user so callers can chain without a second lookup.
 */
export async function requireEntitlement(
  ctx: Ctx,
  feature: FeatureKey,
): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  const entitlements = await entitlementsForUser(ctx, user._id);
  if (!can(entitlements, feature)) {
    throw new EntitlementError(
      feature,
      `${FEATURE_PROMPTS[feature]} is part of Pro. Upgrade to unlock it.`,
    );
  }
  return user;
}

/**
 * Enforces the league cap before creating a league.
 *
 * The count is read through the `by_user` index rather than by scanning, and is computed
 * from the leagues table itself rather than from an audit log. The previous
 * implementation counted audit rows tagged `league_import`, which drifted from reality the
 * moment a league was deleted or an import was retried.
 */
export async function requireLeagueCapacity(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<void> {
  const entitlements = await entitlementsForUser(ctx, userId);
  const existing = await ctx.db
    .query("leagues")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  if (!canAddLeague(entitlements, existing.length)) {
    throw new EntitlementError(
      "league_count",
      `Your plan includes ${existing.length} leagues. Upgrade to Pro for unlimited leagues.`,
    );
  }
}
