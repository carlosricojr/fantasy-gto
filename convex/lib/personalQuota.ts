import { ConvexError } from "convex/values";
import { can, effectivePlan, entitlementsFor } from "../../lib/billing/entitlements";
import type { MutationCtx } from "../_generated/server";
import { requireUser, subscriptionFor } from "./auth";

export type PersonalOperation = "connection" | "roster" | "model" | "waiver" | "journal-save" | "journal-read" | "journal-refresh";
const WINDOW = 15 * 60_000;
const DAY = 24 * 60 * 60_000;

/** Atomic distributed admission; one stable row per owner/operation. Failed upstream attempts count. */
export async function admitPersonalOperation(ctx: MutationCtx, operation: PersonalOperation) {
  const user = await requireUser(ctx);
  const now = Date.now();
  const subscription = await subscriptionFor(ctx, user._id);
  const pro = effectivePlan(subscription, now) === "pro";
  const feature = operation === "waiver" ? "waiver_comparison" : operation.startsWith("journal-") ? "performance_history" : null;
  if ((operation === "model" && !pro) || (feature && !can(entitlementsFor(subscription, now), feature))) throw new ConvexError({ code: "entitlement", message: "This operation requires Pro. Roster-only imports and connection lookup are available on Free." });
  const limits: Record<PersonalOperation, [number, number]> = {
    connection: [6, pro ? 60 : 20], roster: [6, pro ? 60 : 20], model: [6, 40],
    waiver: [6, 30], "journal-save": [10, 100], "journal-read": [60, 500], "journal-refresh": [6, 30],
  };
  const [windowLimit, dayLimit] = limits[operation];
  const windowStart = Math.floor(now / WINDOW) * WINDOW;
  const dayStart = Math.floor(now / DAY) * DAY;
  const row = await ctx.db.query("personalUsage").withIndex("by_user_operation", (q) => q.eq("userId", user._id).eq("operation", operation)).first();
  const windowCount = row?.windowStart === windowStart ? row.windowCount : 0;
  const dayCount = row?.dayStart === dayStart ? row.dayCount : 0;
  if (windowCount >= windowLimit || dayCount >= dayLimit) {
    const retryAt = Math.max(windowCount >= windowLimit ? windowStart + WINDOW : now, dayCount >= dayLimit ? dayStart + DAY : now);
    throw new ConvexError({ code: "rate_limit", message: `This operation's allowance is temporarily exhausted. Try again after ${new Date(retryAt).toISOString()}. No upstream request was admitted.`, retryAfterSeconds: Math.max(1, Math.ceil((retryAt - now) / 1000)) });
  }
  const values = { windowStart, windowCount: windowCount + 1, dayStart, dayCount: dayCount + 1 };
  if (row) await ctx.db.patch(row._id, values);
  else await ctx.db.insert("personalUsage", { userId: user._id, operation, ...values });
  return user;
}
