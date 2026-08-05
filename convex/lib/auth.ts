import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

import {
  FREE_SUBSCRIPTION,
  type Entitlements,
  type FeatureKey,
  type Subscription,
  can,
  canAddLeague,
  describeLeagueCap,
  entitlementsFor,
} from "../../lib/billing/entitlements";

/**
 * Server-side authorization.
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

/**
 * Application errors are thrown as `ConvexError`, not `Error`.
 *
 * Convex redacts the message of any non-`ConvexError` exception on a production
 * deployment — the client receives "Server Error" and nothing else. These messages exist
 * precisely to be read by a user (a free subscriber hitting the league cap needs the
 * upgrade path, not a crash), so they must travel in `ConvexError` data.
 *
 * This is invisible in tests: `convex-test` is a local simulator and does not redact, so a
 * plain `Error` passes every assertion here while breaking in production.
 */
export type AppErrorCode = "unauthenticated" | "entitlement" | "not_found" | "invalid";

/**
 * The payload carried to the client.
 *
 * The index signature is required by Convex's `Value` constraint on `ConvexError`; the
 * named fields are what callers actually read.
 */
export type AppErrorData = {
  code: AppErrorCode;
  message: string;
  feature?: FeatureKey;
  [key: string]: string | undefined;
};

/** Thrown when the caller is not signed in. */
export function unauthenticated(): ConvexError<AppErrorData> {
  return new ConvexError<AppErrorData>({
    code: "unauthenticated",
    message: "You need to be signed in to do that.",
  });
}

/** Thrown when the caller's plan does not include a capability. */
export function entitlementRequired(
  feature: FeatureKey,
  message: string,
): ConvexError<AppErrorData> {
  return new ConvexError<AppErrorData>({ code: "entitlement", message, feature });
}

/** Thrown when a record is absent, or is not the caller's to see. */
export function notFound(message: string): ConvexError<AppErrorData> {
  return new ConvexError<AppErrorData>({ code: "not_found", message });
}

/** Thrown when arguments are internally inconsistent. */
export function invalid(message: string): ConvexError<AppErrorData> {
  return new ConvexError<AppErrorData>({ code: "invalid", message });
}

/**
 * The signed-in user's row, or null when anonymous.
 *
 * Uses `.first()` rather than `.unique()` deliberately. Two paths create users — an
 * authenticated request and the Clerk webhook — and while Convex's serializable mutations
 * should prevent a duplicate, `.unique()` *throws* when it finds one. That would turn a
 * rare, recoverable data anomaly into a hard failure on every subsequent request from that
 * account. Reading the first row degrades instead, and the duplicate can be reconciled
 * out of band.
 */
export async function currentUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", identity.subject))
    .first();
}

/** The signed-in user's row, or throws. */
export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const user = await currentUser(ctx);
  if (!user) throw unauthenticated();
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
    .first();
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
    throw entitlementRequired(
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
    throw entitlementRequired(
      "league_count",
      `Your plan includes ${describeLeagueCap(entitlements)}. Upgrade to Pro for unlimited leagues.`,
    );
  }
}
