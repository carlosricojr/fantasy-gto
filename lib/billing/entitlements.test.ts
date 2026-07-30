import { describe, expect, it } from "vitest";

import {
  FEATURES,
  FREE_SUBSCRIPTION,
  GRACE_PERIOD_MS,
  PRO_PLAN_KEYS,
  UNIMPLEMENTED_FEATURES,
  type Subscription,
  can,
  canAddLeague,
  effectivePlan,
  entitlementsFor,
  entitlementsForPlan,
  graceRemainingMs,
  isInGracePeriod,
  isKnownPlanKey,
  limit,
  planFromClerkKey,
  statusFromClerk,
} from "./entitlements";

const NOW = 1_800_000_000_000;

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    planId: "pro",
    status: "active",
    pastDueSince: null,
    currentPeriodEnd: null,
    ...overrides,
  };
}

describe("entitlement table", () => {
  it("defines every feature for every plan", () => {
    for (const plan of ["free", "pro"] as const) {
      const entitlements = entitlementsForPlan(plan);
      for (const feature of FEATURES) {
        expect(entitlements[feature], `${plan} is missing ${feature}`).toBeDefined();
      }
    }
  });

  it("grants start/sit on the free tier", () => {
    // The product's argument is that value precedes payment. A free tier that cannot
    // answer "who do I start?" demonstrates nothing.
    expect(can(entitlementsForPlan("free"), "start_sit")).toBe(true);
  });

  it("caps free leagues at three and makes Pro unlimited", () => {
    expect(limit(entitlementsForPlan("free"), "league_count")).toBe(3);
    expect(limit(entitlementsForPlan("pro"), "league_count")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("withholds every paid capability on the free tier", () => {
    const free = entitlementsForPlan("free");
    for (const feature of [
      "daily_refresh",
      "waivers_faab",
      "dst_streamer",
      "alerts",
      "accuracy_dashboard",
      "import_export",
      "performance_history",
    ] as const) {
      expect(can(free, feature), `free must not grant ${feature}`).toBe(false);
    }
  });

  it("grants every implemented capability on Pro", () => {
    const pro = entitlementsForPlan("pro");
    for (const feature of FEATURES) {
      if (feature === "league_count") continue;
      if (UNIMPLEMENTED_FEATURES.includes(feature)) continue;
      expect(can(pro, feature), `pro must grant ${feature}`).toBe(true);
    }
  });

  it("withholds capabilities that are not built yet, even on Pro", () => {
    // Granting access to a feature that does not exist would entitle a paying subscriber
    // to nothing. These flip to true in the same change that implements them.
    const pro = entitlementsForPlan("pro");
    for (const feature of UNIMPLEMENTED_FEATURES) {
      expect(can(pro, feature), `${feature} is not implemented and must not be granted`).toBe(
        false,
      );
    }
  });

  it("never reports a numeric entitlement as a boolean capability", () => {
    expect(can(entitlementsForPlan("pro"), "league_count")).toBe(false);
    expect(limit(entitlementsForPlan("pro"), "start_sit")).toBe(0);
  });
});

describe("effectivePlan", () => {
  it("gives free users free entitlements regardless of status", () => {
    for (const status of ["active", "trialing", "past_due", "canceled", "none"] as const) {
      expect(effectivePlan({ ...FREE_SUBSCRIPTION, status }, NOW)).toBe("free");
    }
  });

  it("grants Pro while active or trialing", () => {
    expect(effectivePlan(subscription({ status: "active" }), NOW)).toBe("pro");
    expect(effectivePlan(subscription({ status: "trialing" }), NOW)).toBe("pro");
  });

  it("returns free for an unsubscribed account", () => {
    expect(effectivePlan(subscription({ status: "none" }), NOW)).toBe("free");
  });

  describe("payment failure grace period", () => {
    it("keeps Pro immediately after a failure", () => {
      expect(
        effectivePlan(subscription({ status: "past_due", pastDueSince: NOW }), NOW),
      ).toBe("pro");
    });

    it("keeps Pro one millisecond before the window closes", () => {
      const sub = subscription({ status: "past_due", pastDueSince: NOW - GRACE_PERIOD_MS + 1 });
      expect(effectivePlan(sub, NOW)).toBe("pro");
    });

    it("drops to free exactly when the window closes", () => {
      const sub = subscription({ status: "past_due", pastDueSince: NOW - GRACE_PERIOD_MS });
      expect(effectivePlan(sub, NOW)).toBe("free");
    });

    it("drops to free well after the window closes", () => {
      const sub = subscription({
        status: "past_due",
        pastDueSince: NOW - GRACE_PERIOD_MS * 10,
      });
      expect(effectivePlan(sub, NOW)).toBe("free");
    });

    it("reports remaining grace time", () => {
      const sub = subscription({ status: "past_due", pastDueSince: NOW - 1000 });
      expect(isInGracePeriod(sub, NOW)).toBe(true);
      expect(graceRemainingMs(sub, NOW)).toBe(GRACE_PERIOD_MS - 1000);
    });

    it("reports no grace when payments are healthy", () => {
      expect(isInGracePeriod(subscription(), NOW)).toBe(false);
      expect(graceRemainingMs(subscription(), NOW)).toBeNull();
    });

    it("fails closed when past_due carries no start timestamp", () => {
      // Without a start the window can never expire, so granting Pro would be an
      // unbounded free ride on a failed payment.
      const sub = subscription({ status: "past_due", pastDueSince: null });
      expect(effectivePlan(sub, NOW)).toBe("free");
      expect(isInGracePeriod(sub, NOW)).toBe(false);
      expect(graceRemainingMs(sub, NOW)).toBeNull();
    });
  });

  describe("cancellation", () => {
    it("honours the remainder of a paid period", () => {
      const sub = subscription({ status: "canceled", currentPeriodEnd: NOW + 60_000 });
      expect(effectivePlan(sub, NOW)).toBe("pro");
    });

    it("drops to free once the paid period ends", () => {
      const sub = subscription({ status: "canceled", currentPeriodEnd: NOW });
      expect(effectivePlan(sub, NOW)).toBe("free");
    });

    it("drops to free when no period end is known", () => {
      const sub = subscription({ status: "canceled", currentPeriodEnd: null });
      expect(effectivePlan(sub, NOW)).toBe("free");
    });
  });
});

describe("canAddLeague", () => {
  it("enforces the free cap", () => {
    const free = entitlementsFor(FREE_SUBSCRIPTION, NOW);
    expect(canAddLeague(free, 0)).toBe(true);
    expect(canAddLeague(free, 2)).toBe(true);
    expect(canAddLeague(free, 3)).toBe(false);
    expect(canAddLeague(free, 99)).toBe(false);
  });

  it("never caps Pro", () => {
    const pro = entitlementsFor(subscription(), NOW);
    expect(canAddLeague(pro, 0)).toBe(true);
    expect(canAddLeague(pro, 10_000)).toBe(true);
  });
});

describe("Clerk mapping", () => {
  it("recognises Pro plan keys", () => {
    expect(planFromClerkKey("pro")).toBe("pro");
    expect(planFromClerkKey("PRO")).toBe("pro");
    expect(planFromClerkKey("pro_annual")).toBe("pro");
    expect(planFromClerkKey("pro_seasonal")).toBe("pro");
  });

  it("fails closed on anything unrecognised", () => {
    // A renamed price in the billing dashboard must never silently grant Pro.
    for (const key of [null, undefined, "", "  ", "premium", "enterprise", "free", "professional"]) {
      expect(planFromClerkKey(key), `${String(key)} must not grant Pro`).toBe("free");
    }
  });

  it("grants Pro only for allowlisted price keys", () => {
    for (const key of PRO_PLAN_KEYS) {
      expect(planFromClerkKey(key)).toBe("pro");
      expect(planFromClerkKey(` ${key.toUpperCase()} `)).toBe("pro");
    }
  });

  it("does not grant Pro to an unlisted pro_-prefixed price", () => {
    // A prefix match would fail open within its own namespace: a price added later as a
    // cheaper tier would silently grant full Pro.
    expect(planFromClerkKey("pro_lite")).toBe("free");
    expect(planFromClerkKey("pro_trial_free")).toBe("free");
    expect(planFromClerkKey("pro_quarterly")).toBe("free");
  });

  it("distinguishes an unrecognised key from a deliberate free plan", () => {
    expect(isKnownPlanKey("free")).toBe(true);
    expect(isKnownPlanKey("pro_annual")).toBe(true);
    expect(isKnownPlanKey(null)).toBe(true);
    expect(isKnownPlanKey("pro_lite")).toBe(false);
    expect(isKnownPlanKey("mystery")).toBe(false);
  });

  it("maps subscription statuses and fails closed on the unknown", () => {
    expect(statusFromClerk("active")).toBe("active");
    expect(statusFromClerk("trialing")).toBe("trialing");
    expect(statusFromClerk("past_due")).toBe("past_due");
    expect(statusFromClerk("unpaid")).toBe("past_due");
    expect(statusFromClerk("cancelled")).toBe("canceled");
    expect(statusFromClerk("canceled")).toBe("canceled");
    expect(statusFromClerk("something_new")).toBe("none");
    expect(statusFromClerk(null)).toBe("none");
  });
});

describe("regression guards for the original defects", () => {
  it("has no way to grant an entitlement directly", () => {
    // Entitlements are a pure function of (plan, status, clock). The exported surface
    // offers no setter, which is what makes the previous "grant unlimited to everyone"
    // bug structurally impossible rather than merely fixed.
    const free = entitlementsFor(FREE_SUBSCRIPTION, NOW);
    expect(limit(free, "league_count")).toBe(3);
  });

  it("returns frozen records so a caller cannot widen its own access", () => {
    // The same object is handed out by reference on every check.
    const free = entitlementsForPlan("free");
    expect(Object.isFrozen(free)).toBe(true);
    expect(() => {
      (free as unknown as Record<string, unknown>).waivers_faab = true;
    }).toThrow();
    expect(can(entitlementsForPlan("free"), "waivers_faab")).toBe(false);
  });

  it("a free user never receives unlimited leagues under any status or clock", () => {
    const clocks = [0, NOW, NOW + GRACE_PERIOD_MS * 100];
    const statuses = ["none", "active", "trialing", "past_due", "canceled"] as const;
    for (const status of statuses) {
      for (const clock of clocks) {
        const entitlements = entitlementsFor(
          { ...FREE_SUBSCRIPTION, status, pastDueSince: 0, currentPeriodEnd: Infinity },
          clock,
        );
        expect(limit(entitlements, "league_count")).toBe(3);
      }
    }
  });
});
