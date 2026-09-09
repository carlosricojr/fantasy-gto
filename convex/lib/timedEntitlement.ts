import { can, entitlementsFor, type FeatureKey } from "../../lib/billing/entitlements";
import { entitlementRequired, requireUser, subscriptionFor, type Ctx } from "./auth";

/** Internal query callers receive time only from an authenticated server action. */
export async function requireTimedEntitlement(ctx: Ctx, feature: FeatureKey, now: number) {
  const user = await requireUser(ctx);
  if (!can(entitlementsFor(await subscriptionFor(ctx, user._id), now), feature)) throw entitlementRequired(feature, feature === "performance_history" ? "Private decision history is part of Pro." : "One-week waiver comparisons are part of Pro.");
  return user;
}
