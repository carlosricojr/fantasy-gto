import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../tests/**",
]);

function asUser(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject, issuer: "https://clerk.test" });
}

const SLOTS = [
  { slotId: "qb", slotLabel: "QB", eligiblePositions: ["QB"], playerId: null },
];

const RULES = {
  teams: 12,
  scoringId: "ppr",
  playoffTeams: 6,
  championshipWeek: 17,
};

async function createLeague(
  t: ReturnType<typeof convexTest>,
  subject = "owner",
) {
  return asUser(t, subject).mutation(api.leagues.create, {
    name: "Rules league",
    season: 2026,
    platform: "manual",
    externalId: null,
    ...RULES,
    slots: SLOTS,
  });
}

async function readyTest(subject = "owner") {
  const t = convexTest(schema, modules);
  await asUser(t, subject).mutation(api.users.ensure, {});
  return t;
}

describe("league rules persistence", () => {
  it("creates a league with every rule persisted beside, not inside, its roster", async () => {
    const t = await readyTest();
    const leagueId = await createLeague(t);

    const saved = await asUser(t, "owner").query(api.leagues.withRoster, {
      leagueId,
    });
    expect(saved?.league).toMatchObject(RULES);
    expect(saved?.roster?.slots).toEqual(SLOTS);
  });

  it.each([
    ["unknown scoring", { scoringId: "commissioner_special" }],
    ["unsupported team count", { teams: 17 }],
    ["unsupported playoff field", { playoffTeams: 5 }],
    ["unsupported championship week", { championshipWeek: 18 }],
    ["a playoff field as large as the league", { teams: 6, playoffTeams: 6 }],
  ])(
    "rejects create with %s as a structured invalid error",
    async (_name, override) => {
      const t = await readyTest();

      await expect(
        asUser(t, "owner").mutation(api.leagues.create, {
          name: "Invalid rules",
          season: 2026,
          platform: "manual",
          externalId: null,
          ...RULES,
          ...override,
          slots: SLOTS,
        }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    },
  );

  it("updates all rules without changing the denormalized roster", async () => {
    const t = await readyTest();
    const leagueId = await createLeague(t);
    const before = await asUser(t, "owner").query(api.leagues.withRoster, {
      leagueId,
    });

    await asUser(t, "owner").mutation(api.leagues.updateRules, {
      leagueId,
      teams: 10,
      scoringId: "standard",
      playoffTeams: 4,
      championshipWeek: 15,
    });

    const after = await asUser(t, "owner").query(api.leagues.withRoster, {
      leagueId,
    });
    expect(after?.league).toMatchObject({
      teams: 10,
      scoringId: "standard",
      playoffTeams: 4,
      championshipWeek: 15,
    });
    expect(after?.roster).toEqual(before?.roster);
  });

  it.each([
    ["unknown scoring", { scoringId: "commissioner_special" }],
    ["unsupported team count", { teams: 17 }],
    ["unsupported playoff field", { playoffTeams: 5 }],
    ["unsupported championship week", { championshipWeek: 18 }],
    ["a playoff field as large as the league", { teams: 6, playoffTeams: 6 }],
  ])(
    "rejects updateRules with %s as a structured invalid error",
    async (_name, override) => {
      const t = await readyTest();
      const leagueId = await createLeague(t);

      await expect(
        asUser(t, "owner").mutation(api.leagues.updateRules, {
          leagueId,
          ...RULES,
          ...override,
        }),
      ).rejects.toMatchObject({ data: { code: "invalid" } });
    },
  );

  it("does not let another user update a league's rules", async () => {
    const t = await readyTest();
    await asUser(t, "other").mutation(api.users.ensure, {});
    const leagueId = await createLeague(t);

    await expect(
      asUser(t, "other").mutation(api.leagues.updateRules, {
        leagueId,
        ...RULES,
      }),
    ).rejects.toMatchObject({ data: { code: "not_found" } });
  });

  it("reads a league recorded before complete rules persistence as not recorded", async () => {
    const t = await readyTest();
    const legacyId = await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", "owner"))
        .unique();
      if (!user) throw new Error("expected test user");
      const leagueId = await ctx.db.insert("leagues", {
        userId: user._id,
        sport: "nfl",
        platform: "manual",
        externalId: null,
        name: "Legacy league",
        season: 2025,
        scoringId: "ppr",
        createdAt: 1,
      });
      await ctx.db.insert("rosters", {
        leagueId,
        userId: user._id,
        name: "My team",
        slots: SLOTS,
        bench: [],
        updatedAt: 1,
      });
      return leagueId;
    });

    const saved = await asUser(t, "owner").query(api.leagues.withRoster, {
      leagueId: legacyId,
    });
    expect(saved?.league.teams).toBeUndefined();
    expect(saved?.league.playoffTeams).toBeUndefined();
    expect(saved?.league.championshipWeek).toBeUndefined();
    expect(saved?.roster?.slots).toEqual(SLOTS);
  });
});
