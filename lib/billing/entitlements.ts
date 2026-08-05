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

/**
 * An unlimited numeric cap.
 *
 * Not `Infinity`: entitlements cross the wire as JSON, and `Infinity` serializes to
 * `null`. A Pro subscriber's client would then read `league_count: null`, and a
 * client-side `canAddLeague` would compute `count < 0` and tell a paying customer they had
 * hit their limit. `MAX_SAFE_INTEGER` is unlimited for every practical purpose and
 * survives serialization intact.
 */
export const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** A boolean capability, or a numeric cap where `UNLIMITED` means no limit. */
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
  /**
   * **Pro's only implemented differentiator today is unlimited leagues.**
   *
   * That is an uncomfortable thing for a paid tier to admit, and it is the truth. Every
   * other capability in this table is `false` because nothing in the codebase reads it:
   *
   * - `accuracy_dashboard` — `/accuracy` is a public marketing page with no gate.
   * - `import_export` — `lib/nfl/lineup-csv.ts` is complete and tested but no route or
   *   screen imports it.
   * - `daily_refresh` — the cron in `convex/crons.ts` rewrites the shared `projections`
   *   rows, and `projections.forWeek` is a public query with no staleness tier. A free
   *   visitor sees the identical freshly recomputed rows. Billing for it would be
   *   charging for a difference that does not exist.
   * - `waivers_faab`, `dst_streamer`, `alerts`, `performance_history` — not built.
   *
   * Each flips to `true` in the same change that implements it, and the pricing page
   * renders both columns from this table so it cannot claim otherwise.
   */
  pro: {
    start_sit: true,
    league_count: UNLIMITED,
    daily_refresh: false,
    waivers_faab: false,
    dst_streamer: false,
    alerts: false,
    accuracy_dashboard: false,
    import_export: false,
    performance_history: false,
  },
};

/**
 * Capabilities named in the plan but not implemented.
 *
 * A key belongs here when nothing in the codebase reads it — including when the
 * underlying feature exists but is ungated (`accuracy_dashboard`) or undifferentiated
 * between tiers (`daily_refresh`). The test suite asserts none of these is granted.
 */
export const UNIMPLEMENTED_FEATURES: readonly FeatureKey[] = [
  "daily_refresh",
  "waivers_faab",
  "dst_streamer",
  "alerts",
  "accuracy_dashboard",
  "import_export",
  "performance_history",
];

// Entitlement records are handed out by reference on every check. Freezing them means a
// caller cannot widen its own access by mutating the shared object.
Object.freeze(ENTITLEMENTS.free);
Object.freeze(ENTITLEMENTS.pro);
Object.freeze(ENTITLEMENTS);

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
      //
      // A missing `pastDueSince` means the grace window has no start, so it can never
      // expire. Granting Pro there would be an unbounded free ride on a failed payment,
      // so an absent timestamp fails closed. The writer always sets it (see
      // convex/billing.ts), which makes this defense in depth rather than a live path.
      if (subscription.pastDueSince === null) return "free";
      return now - subscription.pastDueSince < GRACE_PERIOD_MS ? "pro" : "free";
    }

    case "canceled":
      // A canceled subscription runs to the end of the period already paid for.
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

/**
 * What a plan grants in the abstract, ignoring subscription state.
 *
 * **Not an authorization API.** Deliberately named so that reaching for it in an access
 * check looks wrong: it cannot see whether the subscription is active, past due, or
 * canceled, so it would happily report Pro capabilities for a lapsed account. Every
 * access decision must go through `entitlementsFor(subscription, now)`.
 *
 * It exists for describing plans — a pricing table — and for tests that assert the shape
 * of the table itself.
 */
export function planCapabilities(planId: PlanId): Entitlements {
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

/** True when a numeric cap is effectively unlimited, for interface copy. */
export function isUnlimited(value: EntitlementValue): boolean {
  return typeof value === "number" && value >= UNLIMITED;
}

/**
 * True when a user is in the post-failure grace window.
 *
 * The interface uses this to warn before access is lost, which is the only reason the
 * grace period is worth having — so it must agree with `effectivePlan`. A free-plan row
 * carrying a `past_due` status has no Pro access to lose, and reporting it as "in grace"
 * would warn the user about losing something they never had.
 */
export function isInGracePeriod(subscription: Subscription, now: number): boolean {
  return (
    subscription.planId === "pro" &&
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
 * Clerk price keys that grant Pro.
 *
 * An explicit allowlist rather than a `pro_` prefix match. A prefix match fails *open*
 * within its namespace: a price added later as `pro_lite` or `pro_trial`, intended as a
 * cheaper tier, would silently grant full Pro. Adding a price to this set is a deliberate
 * code change, which is the point.
 */
export const PRO_PLAN_KEYS: ReadonlySet<string> = new Set([
  "pro",
  "pro_monthly",
  "pro_annual",
  "pro_seasonal",
]);

/**
 * Maps a Clerk plan identifier to ours.
 *
 * Anything not on the allowlist resolves to `free`. Failing closed matters: a renamed or
 * newly added price in the billing dashboard must never silently hand out Pro.
 *
 * A new Pro price therefore requires adding its key here. That is intentional — see
 * `isKnownPlanKey`, which lets the webhook record an unrecognized key so the
 * misconfiguration is visible rather than silently downgrading a paying customer.
 */
export function planFromClerkKey(key: string | null | undefined): PlanId {
  if (!key) return "free";
  return PRO_PLAN_KEYS.has(key.trim().toLowerCase()) ? "pro" : "free";
}

/**
 * True when a plan key is one we recognize.
 *
 * Distinguishes "deliberately free" from "unrecognized", so an unknown key can be audited
 * instead of quietly treated as a downgrade.
 */
export function isKnownPlanKey(key: string | null | undefined): boolean {
  if (!key) return true; // absent means free, which is a known state
  const normalized = key.trim().toLowerCase();
  return normalized === "free" || PRO_PLAN_KEYS.has(normalized);
}

/**
 * Whether a Clerk status is one `statusFromClerk` actually recognizes.
 *
 * Needed because `statusFromClerk` maps the unrecognized and the genuinely-ended to the
 * same `"none"`. Those must be handled differently: ending a subscription should revoke
 * access, whereas a status we simply do not model tells us nothing and must not.
 */
export function isKnownSubscriptionStatus(raw: string | null | undefined): boolean {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "") return true; // absent is a known state: no subscription
  return KNOWN_CLERK_STATUSES.has(normalized);
}

const KNOWN_CLERK_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "trial",
  "past_due",
  "unpaid",
  "canceled",
  "cancelled",
  // Clerk's terminal spellings. These do mean "no longer entitled", so they map to
  // "none" deliberately rather than by falling through.
  "ended",
  "expired",
]);

/**
 * Maps a Clerk subscription status to ours, failing closed on anything unrecognized.
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
    case "ended":
    case "expired":
      return "none";
    default:
      return "none";
  }
}
