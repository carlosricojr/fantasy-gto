import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { type MutationCtx, internalMutation } from "./_generated/server";

import {
  type PlanId,
  type SubscriptionStatus,
  isKnownPlanKey,
  isKnownSubscriptionStatus,
  planFromClerkKey,
  statusFromClerk,
} from "../lib/billing/entitlements";

/**
 * Billing writes.
 *
 * Every export is an `internalMutation`, reachable only from a verified webhook or another
 * server function — never from a browser. That is the structural fix for the original
 * defect, where a client-callable action granted `league_count: "unlimited"` to anyone who
 * signed in.
 *
 * These functions record *subscription state*. They never write entitlements, because
 * entitlements are derived (`lib/billing/entitlements.ts`). There is deliberately no
 * function anywhere that grants a capability directly.
 */

const planValidator = v.union(v.literal("free"), v.literal("pro"));
const statusValidator = v.union(
  v.literal("none"),
  v.literal("trialing"),
  v.literal("active"),
  v.literal("past_due"),
  v.literal("canceled"),
);

/**
 * Writes a user's subscription state.
 *
 * `pastDueSince` is preserved across repeated `past_due` events rather than being reset,
 * so a dunning system that retries daily cannot extend the grace period indefinitely by
 * restarting the clock. It is cleared as soon as the subscription recovers.
 */
export const setSubscription = internalMutation({
  args: {
    clerkUserId: v.string(),
    planId: planValidator,
    status: statusValidator,
    clerkSubscriptionId: v.union(v.string(), v.null()),
    currentPeriodEnd: v.union(v.number(), v.null()),
    eventAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();

    // Same reasoning as `applyClerkEvent`: a subscription event can arrive before the
    // user-created event, and auditing then dropping it loses the paid upgrade for good.
    // Provisioning keeps both writers consistent, so this one cannot quietly regress to
    // the lossy behaviour while the other is correct.
    const resolved =
      user ?? (await provisionUser(ctx, args.clerkUserId, "setSubscription", now));

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", resolved._id))
      .first();
    const pastDueSince =
      args.status === "past_due"
        ? (existing?.pastDueSince ?? now)
        : null;

    const next = {
      userId: resolved._id,
      planId: args.planId as PlanId,
      status: args.status as SubscriptionStatus,
      pastDueSince,
      currentPeriodEnd: args.currentPeriodEnd,
      clerkSubscriptionId: args.clerkSubscriptionId,
      updatedAt: now,
      lastEventAt: args.eventAt ?? existing?.lastEventAt ?? null,
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert("subscriptions", next);
    }

    await ctx.db.insert("audit", {
      kind: "billing.subscription_changed",
      userId: resolved._id,
      detail: `plan=${args.planId} status=${args.status}`,
      at: now,
    });
  },
});

/**
 * Creates a minimal user row for a Clerk id seen first on a billing event.
 *
 * Deliberately not exported. The only caller is the orphan-event path below, and the row
 * carries an empty email until a `user.*` event supplies one — a user who has paid but
 * whose profile has not arrived yet is a real state, and it is better represented than
 * discarded.
 */
async function provisionUser(
  ctx: MutationCtx,
  clerkUserId: string,
  eventType: string,
  now: number,
): Promise<Doc<"users">> {
  const userId = await ctx.db.insert("users", {
    clerkUserId,
    email: "",
    createdAt: now,
  });
  await ctx.db.insert("audit", {
    kind: "billing.provisioned_user",
    userId,
    detail: `${eventType} arrived before any user event for ${clerkUserId}; account created`,
    at: now,
  });
  const created = await ctx.db.get(userId);
  if (created === null) throw new Error("provisioned user vanished");
  return created;
}

/**
 * Applies a Clerk webhook event.
 *
 * Event names vary across Clerk's billing surface, so this matches on substrings rather
 * than an exact list. Anything unrecognised is audited and otherwise ignored: an unknown
 * event must never change access, in either direction.
 */
export const applyClerkEvent = internalMutation({
  args: {
    eventType: v.string(),
    clerkUserId: v.union(v.string(), v.null()),
    planKey: v.union(v.string(), v.null()),
    status: v.union(v.string(), v.null()),
    subscriptionId: v.union(v.string(), v.null()),
    currentPeriodEnd: v.union(v.number(), v.null()),
    /** Provider timestamp, used to reject an out-of-order delivery. */
    eventAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ applied: boolean }> => {
    const now = Date.now();

    if (!args.clerkUserId) {
      await ctx.db.insert("audit", {
        kind: "billing.unresolvable_event",
        userId: null,
        detail: `${args.eventType} carried no Clerk user id`,
        at: now,
      });
      return { applied: false };
    }

    // Clerk spells billing events in camelCase (`paymentAttempt.updated`,
    // `subscriptionItem.active`), so matching is done on a lowercased form and covers both
    // conventions. A payment attempt is only a *failure* when its status says so —
    // treating every attempt as one would push healthy accounts into the grace path.
    const type = args.eventType.toLowerCase();
    const isSubscriptionEvent = type.includes("subscription");
    const isPaymentAttempt =
      type.includes("paymentattempt") || type.includes("payment_attempt");
    const rawStatus = (args.status ?? "").trim().toLowerCase();
    const isPaymentFailure =
      type.includes("payment_failed") ||
      type.includes("payment.failed") ||
      (isPaymentAttempt && (rawStatus === "failed" || rawStatus === "unpaid"));

    if (!isSubscriptionEvent && !isPaymentFailure) {
      await ctx.db.insert("audit", {
        kind: "billing.ignored_event",
        userId: null,
        detail: args.eventType,
        at: now,
      });
      return { applied: false };
    }

    // A subscription event can arrive before `user.created`. Auditing and dropping it
    // loses the upgrade permanently: the handler returns 200 so Svix never retries, and
    // nothing replays the audit row when the user later appears — the subscriber has paid
    // and is entitled to nothing. So the account is provisioned here instead.
    //
    // The email is filled in by whichever `user.*` event or first sign-in arrives next;
    // `upsertFromClerk` patches it, and `users.ensure` matches on the Clerk id, so the row
    // is adopted rather than duplicated.
    const user =
      (await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", args.clerkUserId!))
        .first()) ??
      (await provisionUser(ctx, args.clerkUserId, args.eventType, now));

    const existing = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();

    // Reject a delivery older than the one already applied. Svix does not guarantee
    // order, and a retried upgrade landing after a cancellation would otherwise restore
    // Pro permanently.
    if (
      args.eventAt !== undefined &&
      existing?.lastEventAt != null &&
      args.eventAt < existing.lastEventAt
    ) {
      await ctx.db.insert("audit", {
        kind: "billing.stale_event_ignored",
        userId: user._id,
        detail: `${args.eventType} at ${args.eventAt} is older than applied ${existing.lastEventAt}`,
        at: now,
      });
      return { applied: false };
    }

    // A subscription event that carries no resolvable plan key must NOT be read as a
    // downgrade. Clerk spells the plan in several places and this handler probes for it;
    // if none matched, the event tells us nothing about the plan, and resolving it to
    // "free" would drop a paying customer instantly — `effectivePlan` short-circuits on
    // planId === "free", so status, currentPeriodEnd, and the whole grace window stop
    // applying. The absence is recorded so the extraction gap is visible.
    const planUnresolved = !isPaymentFailure && args.planKey === null;
    if (planUnresolved) {
      await ctx.db.insert("audit", {
        kind: "billing.unresolved_plan_key",
        userId: user._id,
        detail: `${args.eventType} carried no plan key; keeping plan=${existing?.planId ?? "free"}`,
        at: now,
      });
    }

    // An unrecognised status is not evidence of anything, and must not be read as the
    // end of a subscription.
    //
    // `statusFromClerk` collapses "not modelled" and "ended" into the same `"none"`, and
    // `effectivePlan` treats `"none"` as free regardless of the period already paid for.
    // Clerk emits statuses this code does not model — `upcoming` on a scheduled plan
    // change, among others — so without this an active subscriber scheduling a change
    // drops to free mid-period. The plan-key path above already reasons this way; the
    // status path did not, and unlike the plan key it left no audit row to diagnose from.
    // Absent counts as uninformative too, on a subscription event.
    //
    // A subscription event with no status tells us nothing about whether the subscription
    // is live, yet `statusFromClerk(null)` returns "none" and `effectivePlan` reads that as
    // free — the same silent revocation, with no audit row at all. The plan-key path
    // already treats absence as "the event tells us nothing"; this now matches it.
    const rawStatusValue = (args.status ?? "").trim();
    const statusUninformative =
      !isPaymentFailure &&
      (rawStatusValue === "" || !isKnownSubscriptionStatus(args.status));

    // An event that does not describe the subscription's current state must not write any
    // of it.
    //
    // Gating only `status` is not enough, and gets the mirror image of the bug wrong:
    // Clerk represents a scheduled downgrade or cancel-at-period-end as an *upcoming* item
    // carrying the future plan key. Applying `planId` from that while preserving `status`
    // writes {planId: "free", status: "active"}, and `effectivePlan` short-circuits on a
    // free plan — so the subscriber loses the period they have already paid for, while the
    // audit row says "keeping status=active". `currentPeriodEnd` and the subscription id
    // describe the future item too. So the whole write is skipped rather than merged
    // field by field.
    if (statusUninformative) {
      await ctx.db.insert("audit", {
        kind: "billing.unknown_status",
        userId: user._id,
        detail:
          `${args.eventType} carried ${rawStatusValue === "" ? "no status" : `unrecognised status "${args.status}"`}; ` +
          `no subscription state written (plan=${existing?.planId ?? "free"}, ` +
          `status=${existing?.status ?? "none"} preserved)`,
        at: now,
      });
      return { applied: false };
    }

    // An unrecognised (as opposed to absent) price key resolves to free, which would
    // silently downgrade a paying customer. Record it so the misconfiguration is visible.
    if (!isPaymentFailure && !planUnresolved && !isKnownPlanKey(args.planKey)) {
      await ctx.db.insert("audit", {
        kind: "billing.unknown_plan_key",
        userId: user._id,
        detail: `${args.eventType} carried unrecognised plan key "${args.planKey}"; treated as free`,
        at: now,
      });
    }

    // A payment failure carries no plan, so the recorded one is kept. With no recorded
    // subscription there is nothing to keep, and defaulting to Pro would grant a paid plan
    // off the back of a *failed* payment — so it falls back to free.
    const planId: PlanId =
      isPaymentFailure || planUnresolved
        ? (existing?.planId ?? "free")
        : planFromClerkKey(args.planKey);

    const status: SubscriptionStatus = isPaymentFailure
      ? "past_due"
      : statusFromClerk(args.status);

    const pastDueSince = status === "past_due" ? (existing?.pastDueSince ?? now) : null;

    const next = {
      userId: user._id,
      planId,
      status,
      pastDueSince,
      // A payload that omits these carries no information about them. Overwriting with
      // null would erase a known period end and revoke a cancelled-but-paid customer's
      // remaining access.
      currentPeriodEnd: args.currentPeriodEnd ?? existing?.currentPeriodEnd ?? null,
      clerkSubscriptionId: args.subscriptionId ?? existing?.clerkSubscriptionId ?? null,
      updatedAt: now,
      lastEventAt: args.eventAt ?? existing?.lastEventAt ?? null,
    };

    if (existing) {
      await ctx.db.patch(existing._id, next);
    } else {
      await ctx.db.insert("subscriptions", next);
    }

    await ctx.db.insert("audit", {
      kind: "billing.applied",
      userId: user._id,
      detail: `${args.eventType} -> plan=${planId} status=${status}`,
      at: now,
    });

    return { applied: true };
  },
});
