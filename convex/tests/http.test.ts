import { describe, expect, it } from "vitest";

import { __testing } from "../http";

/**
 * Webhook payload extraction.
 *
 * These are the pure parsers that sit between Clerk's payload and the billing mutations.
 * They are worth testing directly because every defect they can have is silent: a plan key
 * read from the wrong place does not throw, it writes a wrong-but-plausible subscription
 * and the subscriber's access changes without anything failing.
 */
const { extractPlanKey, extractClerkUserId, extractPeriodEnd } = __testing;

const event = (data: Record<string, unknown>) => ({ type: "subscription.updated", data });

describe("extractPlanKey", () => {
  it("prefers the item describing the current period over a scheduled one", () => {
    // Clerk represents a scheduled downgrade as an extra item on the same subscription.
    // Reading `items[0]` blindly can take the plan the subscriber is moving *to* as the
    // plan they are on; if the parent event's own status is `active`, the uninformative-
    // event guard does not fire and the future plan is written as current — revoking the
    // period they have already paid for.
    expect(
      extractPlanKey(
        event({
          items: [
            { status: "upcoming", plan: { slug: "free" } },
            { status: "active", plan: { slug: "pro_monthly" } },
          ],
        }),
      ),
    ).toBe("pro_monthly");
  });

  it("treats an unfamiliar item status as not live", () => {
    // Whitelist, not blacklist: an unknown spelling of "scheduled" must not be mistaken
    // for the active plan.
    expect(
      extractPlanKey(
        event({
          items: [
            { status: "some_future_state", plan: { slug: "free" } },
            { status: "trialing", plan: { slug: "pro_monthly" } },
          ],
        }),
      ),
    ).toBe("pro_monthly");
  });

  it("falls back to the first item when none carries a status", () => {
    expect(extractPlanKey(event({ items: [{ plan: { slug: "pro_monthly" } }] }))).toBe(
      "pro_monthly",
    );
  });

  it("falls back to the first item when none is live", () => {
    // Better to read something than nothing: an unresolved plan key is itself handled, but
    // silently returning null here would look like a payload we could not parse.
    expect(
      extractPlanKey(event({ items: [{ status: "ended", plan: { slug: "pro_monthly" } }] })),
    ).toBe("pro_monthly");
  });

  it("prefers a top-level plan over any item", () => {
    expect(
      extractPlanKey(
        event({
          plan: { slug: "pro_annual" },
          items: [{ status: "active", plan: { slug: "pro_monthly" } }],
        }),
      ),
    ).toBe("pro_annual");
  });

  it("reads a plan spelled only as a name", () => {
    expect(
      extractPlanKey(event({ items: [{ status: "active", plan: { name: "Pro" } }] })),
    ).toBe("Pro");
  });

  it("returns null when the payload carries no plan at all", () => {
    // Distinct from an unrecognised key: `billing.applyClerkEvent` treats absence as "this
    // event says nothing about the plan" and keeps the recorded one.
    expect(extractPlanKey(event({ items: [{ status: "active" }] }))).toBeNull();
    expect(extractPlanKey(event({}))).toBeNull();
  });
});

describe("extractClerkUserId", () => {
  it("reads the id from the shapes Clerk actually sends", () => {
    expect(extractClerkUserId(event({ user_id: "user_1" }))).toBe("user_1");
    expect(extractClerkUserId({ type: "user.created", data: { id: "user_2" } })).toBe(
      "user_2",
    );
  });

  it("returns null rather than guessing", () => {
    expect(extractClerkUserId(event({}))).toBeNull();
  });
});

describe("extractPeriodEnd", () => {
  it("returns null when absent, so the recorded value is kept", () => {
    expect(extractPeriodEnd(event({}))).toBeNull();
  });
});
