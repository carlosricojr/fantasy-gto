import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";

/**
 * Server-side entitlement enforcement.
 *
 * These are the tests that matter most in this repository. The defect that made the
 * original paywall unenforceable was not in the entitlement *logic* — it was in the
 * wiring: a client-callable action that granted access, and a webhook that resolved its
 * user from a session that does not exist. Unit-testing the pure resolver would not have
 * caught either. These exercise the actual Convex functions.
 *
 * `import.meta.glob` is how convex-test discovers the function modules under Vite. The
 * documented `!(*.*.*)` extglob silently matches nothing here — Vite's matcher does not
 * support it — so the patterns are spelled out, including the generated modules that
 * convex-test needs to locate the deployment root.
 */
const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../tests/**",
]);

/** A signed-in caller. convex-test derives the identity's subject from `subject`. */
function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject, issuer: "https://clerk.test" });
}

const STANDARD_SLOTS = [
  { slotId: "qb", slotLabel: "QB", eligiblePositions: ["QB"], playerId: null },
];

async function createLeague(
  t: ReturnType<typeof convexTest>,
  subject: string,
  name: string,
) {
  return asUser(t, subject).mutation(api.leagues.create, {
    name,
    season: 2025,
    platform: "manual",
    externalId: null,
    scoringId: "ppr",
    slots: STANDARD_SLOTS,
  });
}

describe("the free-tier league cap", () => {
  it("allows one league and refuses the second", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_free").mutation(api.users.ensure, {});

    await expect(createLeague(t, "user_free", "League 1")).resolves.toBeDefined();

    // The cap is enforced in the same transaction that creates the league, so no client
    // can bypass it by calling the mutation directly.
    await expect(createLeague(t, "user_free", "League 2")).rejects.toThrow(/Upgrade to Pro/);
  });

  it("reports the plan's limit rather than the current count", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_msg").mutation(api.users.ensure, {});
    await createLeague(t, "user_msg", "L1");
    // Singular, because the message is built from the shared formatter rather than
    // concatenating a number onto a hard-coded "leagues".
    await expect(createLeague(t, "user_msg", "L2")).rejects.toThrow(/includes 1 league\./);
  });

  it("does not cap a Pro subscriber", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_pro").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.setSubscription, {
      clerkUserId: "user_pro",
      planId: "pro",
      status: "active",
      clerkSubscriptionId: "sub_1",
      currentPeriodEnd: null,
    });

    for (const n of [1, 2, 3, 4, 5] as const) {
      await expect(createLeague(t, "user_pro", `League ${n}`)).resolves.toBeDefined();
    }
  });

  it("counts leagues from the leagues table, so deleting one frees capacity", async () => {
    // The original implementation counted audit rows tagged `league_import`, which drifted
    // from reality the moment a league was deleted.
    const t = convexTest(schema, modules);
    await asUser(t, "user_del").mutation(api.users.ensure, {});
    const first = await createLeague(t, "user_del", "A");
    await expect(createLeague(t, "user_del", "B")).rejects.toThrow();

    await asUser(t, "user_del").mutation(api.leagues.remove, { leagueId: first });
    await expect(createLeague(t, "user_del", "B")).resolves.toBeDefined();
  });

  it("refuses to create a league for an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.leagues.create, {
        name: "Anon",
        season: 2025,
        platform: "manual",
        externalId: null,
        scoringId: "ppr",
        slots: STANDARD_SLOTS,
      }),
    ).rejects.toThrow(/signed in/);
  });
});

describe("error payloads reach the client", () => {
  // Convex redacts the message of a non-ConvexError exception on a production deployment,
  // so a plain Error would surface as "Server Error" — a crash where the upgrade path
  // should be. convex-test does not redact, so asserting on the *message* passes either
  // way. Asserting on the structured `data` payload is what distinguishes them.
  it("carries a structured entitlement payload, not a bare message", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "payload_user").mutation(api.users.ensure, {});
    await createLeague(t, "payload_user", "L1");

    await expect(createLeague(t, "payload_user", "L2")).rejects.toMatchObject({
      data: {
        code: "entitlement",
        feature: "league_count",
        message: expect.stringContaining("Upgrade to Pro"),
      },
    });
  });

  it("carries a structured unauthenticated payload", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.leagues.create, {
        name: "Anon",
        season: 2025,
        platform: "manual",
        externalId: null,
        scoringId: "ppr",
        slots: STANDARD_SLOTS,
      }),
    ).rejects.toMatchObject({ data: { code: "unauthenticated" } });
  });

  it("carries a structured payload for a roster that names a player twice", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "dup_user").mutation(api.users.ensure, {});
    const leagueId = await createLeague(t, "dup_user", "Dup");

    await expect(
      asUser(t, "dup_user").mutation(api.leagues.setRoster, {
        leagueId,
        slots: [
          { slotId: "rb1", slotLabel: "RB", eligiblePositions: ["RB"], playerId: "p1" },
        ],
        bench: ["p1"],
      }),
    ).rejects.toMatchObject({ data: { code: "invalid" } });
  });
});

describe("ownership", () => {
  it("does not let one user read another's league", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_a").mutation(api.users.ensure, {});
    await asUser(t, "user_b").mutation(api.users.ensure, {});
    const leagueId = await createLeague(t, "user_a", "A's league");

    await expect(
      asUser(t, "user_b").query(api.leagues.withRoster, { leagueId }),
    ).resolves.toBeNull();
  });

  it("does not let one user delete another's league", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_a").mutation(api.users.ensure, {});
    await asUser(t, "user_b").mutation(api.users.ensure, {});
    const leagueId = await createLeague(t, "user_a", "A's league");

    await expect(
      asUser(t, "user_b").mutation(api.leagues.remove, { leagueId }),
    ).rejects.toThrow(/does not exist/);

    // Still there for its owner.
    await expect(
      asUser(t, "user_a").query(api.leagues.withRoster, { leagueId }),
    ).resolves.not.toBeNull();
  });

  it("lists only the caller's own leagues", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_a").mutation(api.users.ensure, {});
    await asUser(t, "user_b").mutation(api.users.ensure, {});
    await createLeague(t, "user_a", "A1");
    await createLeague(t, "user_b", "B1");

    const forA = await asUser(t, "user_a").query(api.leagues.list, {});
    expect(forA).toHaveLength(1);
    expect(forA[0].name).toBe("A1");
  });

  it("returns no leagues for an anonymous caller rather than throwing", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.leagues.list, {})).resolves.toEqual([]);
  });
});

describe("rosters", () => {
  it("refuses a player appearing in two slots", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_r").mutation(api.users.ensure, {});
    const leagueId = await createLeague(t, "user_r", "R");

    await expect(
      asUser(t, "user_r").mutation(api.leagues.setRoster, {
        leagueId,
        slots: [
          { slotId: "rb1", slotLabel: "RB", eligiblePositions: ["RB"], playerId: "p1" },
          { slotId: "rb2", slotLabel: "RB", eligiblePositions: ["RB"], playerId: "p1" },
        ],
        bench: [],
      }),
    ).rejects.toThrow(/only appear once/);
  });

  it("refuses a player who is both started and benched", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_r2").mutation(api.users.ensure, {});
    const leagueId = await createLeague(t, "user_r2", "R2");

    await expect(
      asUser(t, "user_r2").mutation(api.leagues.setRoster, {
        leagueId,
        slots: [
          { slotId: "rb1", slotLabel: "RB", eligiblePositions: ["RB"], playerId: "p1" },
        ],
        bench: ["p1"],
      }),
    ).rejects.toThrow(/only appear once/);
  });
});

describe("me", () => {
  it("gives an anonymous visitor a usable free-tier shape", async () => {
    const t = convexTest(schema, modules);
    const me = await t.query(api.users.me, {});
    expect(me.signedIn).toBe(false);
    expect(me.plan).toBe("free");
    expect(me.entitlements.start_sit).toBe(true);
    expect(me.entitlements.league_count).toBe(1);
  });

  it("reports Pro once a subscription is recorded", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_me").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.setSubscription, {
      clerkUserId: "user_me",
      planId: "pro",
      status: "active",
      clerkSubscriptionId: null,
      currentPeriodEnd: null,
    });

    const me = await asUser(t, "user_me").query(api.users.me, {});
    expect(me.signedIn).toBe(true);
    expect(me.plan).toBe("pro");
    // Pro's only implemented differentiator today is the league cap, and it must survive
    // the wire rather than arriving as null.
    expect(me.entitlements.league_count).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("never grants a capability that is not implemented", async () => {
    const t = convexTest(schema, modules);
    await asUser(t, "user_unimpl").mutation(api.users.ensure, {});
    await t.mutation(internal.billing.setSubscription, {
      clerkUserId: "user_unimpl",
      planId: "pro",
      status: "active",
      clerkSubscriptionId: null,
      currentPeriodEnd: null,
    });

    const me = await asUser(t, "user_unimpl").query(api.users.me, {});
    for (const feature of ["waivers_faab", "dst_streamer", "alerts", "performance_history"]) {
      expect(me.entitlements[feature as keyof typeof me.entitlements]).toBe(false);
    }
  });
});
