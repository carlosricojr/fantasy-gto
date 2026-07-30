/**
 * Entitlements.
 *
 * Entitlements are **derived** from a subscription, never stored as free-form grants.
 * That is the whole point of this module.
 *
 * The previous implementation had two defects that made the paywall unenforceable. A
 * client-callable action wrote `league_count: "unlimited"` for every signed-in user, and
 * the billing webhook resolved the acting user through `ctx.auth.getUserIdentity()` — which
 * is always null in a webhook, so no entitlement change was ever applied. Between them,
 * every user had every feature and no Clerk event could alter that.
 *
 * The fix is structural rather than a patch. Access is a pure function of
 * (plan, status, clock). There is no code path that grants an entitlement directly, so
 * there is nothing for a client to call and nothing to forge. Persisted entitlement rows
 * are a cache for fast reads, and every privileged server path re-derives from the stored
 * subscription rather than trusting the cache.
 */

/** Billing plans. Monthly, annual, and seasonal Pro prices all map to `pro`. */
export type PlanId = "free" | "pro";

/** Subscription lifecycle, mirroring the states Clerk reports. */
export type SubscriptionStatus =
  | "none"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled";

export interface Subscription {
  planId: PlanId;
  status: SubscriptionStatus;
  /**
   * When the first payment failure was recorded, in epoch milliseconds.
   * Drives the grace period; null when payments are healthy.
   */
  pastDueSince: number | null;
  /** End of the paid period, in epoch milliseconds. */
  currentPeriodEnd: number | null;
}

export const FREE_SUBSCRIPTION: Subscription = {
  planId: "free",
  status: "none",
  pastDueSince: null,
  currentPeriodEnd: null,
};

/**
 * Grace window after a failed payment, during which Pro access continues.
 *
 * Dunning takes a few days to resolve and cutting a paying customer off immediately over a
 * transient card decline is hostile. After this elapses, access falls back to free.
 */
export const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

/** Capability keys. Adding one here without adding it to `ENTITLEMENTS` fails typecheck. */
export const FEATURES = [
  "start_sit",
  "league_count",
  "daily_refresh",
  "waivers_faab",
  "dst_streamer",
  "alerts",
  "accuracy_dashboard",
  "import_export",
  "performance_history",
] as const;

export type FeatureKey = (typeof FEATURES)[number];

/** A boolean capability, or a numeric cap where `Infinity` means unlimited. */
export type EntitlementValue = boolean | number;

export type Entitlements = Readonly<Record<FeatureKey, EntitlementValue>>;

/**
 * The entitlement table.
 *
 * Free deliberately includes `start_sit` and three leagues. The product's whole argument
 * is that value must be demonstrated before payment is requested, and a free tier that
 * cannot answer "who do I start?" demonstrates nothing.
 */
const ENTITLEMENTS: Readonly<Record<PlanId, Entitlements>> = {
  free: {
    start_sit: true,
    league_count: 3,
    daily_refresh: false,
    waivers_faab: false,
    dst_streamer: false,
    alerts: false,
    accuracy_dashboard: false,
    import_export: false,
    performance_history: false,
  },
  pro: {
    start_sit: true,
    league_count: Number.POSITIVE_INFINITY,
    daily_refresh: true,
    waivers_faab: true,
    dst_streamer: true,
    alerts: true,
    accuracy_dashboard: true,
    import_export: true,
    performance_history: true,
  },
};

/**
 * Resolves which plan's entitlements actually apply right now.
 *
 * `now` is a parameter rather than a call to `Date.now()` so the grace-period boundary is
 * directly testable and so a server and a client evaluating the same subscription cannot
 * disagree because their clocks differ.
 */
export function effectivePlan(subscription: Subscription, now: number): PlanId {
  if (subscription.planId === "free") return "free";

  switch (subscription.status) {
    case "active":
    case "trialing":
      return "pro";

    case "past_due": {
      // Keep Pro during the grace window, then fall back.
      if (subscription.pastDueSince === null) return "pro";
      return now - subscription.pastDueSince < GRACE_PERIOD_MS ? "pro" : "free";
    }

    case "canceled":
      // A cancelled subscription runs to the end of the period already paid for.
      return subscription.currentPeriodEnd !== null && now < subscription.currentPeriodEnd
        ? "pro"
        : "free";

    case "none":
      return "free";
  }
}

/** The entitlements in force for a subscription at a point in time. */
export function entitlementsFor(subscription: Subscription, now: number): Entitlements {
  return ENTITLEMENTS[effectivePlan(subscription, now)];
}

/** The entitlements a plan grants, independent of any subscription state. */
export function entitlementsForPlan(planId: PlanId): Entitlements {
  return ENTITLEMENTS[planId];
}

/** True when a boolean capability is granted. Numeric entitlements are never truthy here. */
export function can(entitlements: Entitlements, feature: FeatureKey): boolean {
  return entitlements[feature] === true;
}

/** The numeric cap for a feature. Returns 0 for a capability that is not numeric. */
export function limit(entitlements: Entitlements, feature: FeatureKey): number {
  const value = entitlements[feature];
  return typeof value === "number" ? value : 0;
}

/** True when adding one more league stays within the plan's cap. */
export function canAddLeague(entitlements: Entitlements, currentCount: number): boolean {
  return currentCount < limit(entitlements, "league_count");
}

/**
 * True when a user is in the post-failure grace window.
 *
 * The interface uses this to warn before access is lost, which is the only reason the
 * grace period is worth having.
 */
export function isInGracePeriod(subscription: Subscription, now: number): boolean {
  return (
    subscription.status === "past_due" &&
    subscription.pastDueSince !== null &&
    now - subscription.pastDueSince < GRACE_PERIOD_MS
  );
}

/** Milliseconds until grace expires, or null when not applicable. */
export function graceRemainingMs(subscription: Subscription, now: number): number | null {
  if (!isInGracePeriod(subscription, now)) return null;
  return subscription.pastDueSince! + GRACE_PERIOD_MS - now;
}

/**
 * Maps a Clerk plan identifier to ours.
 *
 * Unknown identifiers resolve to `free`. Failing closed matters: a renamed price in the
 * billing dashboard must never silently hand out Pro.
 */
export function planFromClerkKey(key: string | null | undefined): PlanId {
  if (!key) return "free";
  const normalized = key.trim().toLowerCase();
  if (normalized === "pro" || normalized.startsWith("pro_")) return "pro";
  return "free";
}

/**
 * Maps a Clerk subscription status to ours, failing closed on anything unrecognised.
 */
export function statusFromClerk(raw: string | null | undefined): SubscriptionStatus {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "active":
      return "active";
    case "trialing":
    case "trial":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "none";
  }
}
