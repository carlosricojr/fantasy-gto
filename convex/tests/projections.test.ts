import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";

/**
 * Projection storage.
 *
 * The invariant here is that the board a user reads describes the week as it stands now.
 * Upserts alone cannot maintain that: a run only writes the players it still projects, so
 * a player who has become ineligible since the last run leaves a row behind that nothing
 * would ever remove.
 */
const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../tests/**",
]);

const SEASON = 2025;
const WEEK = 5;

function row(playerId: string, team: string, scoringId = "ppr") {
  return {
    season: SEASON,
    week: WEEK,
    playerId,
    position: "WR",
    scoringId,
    team,
    opponent: "SF",
    mean: 12,
    floor: 4,
    ceiling: 22,
    contributions: [{ key: "base", label: "Base", points: 12, detail: "" }],
    modelVersion: "test",
  };
}

describe("pruneStale", () => {
  it("removes rows an earlier run wrote and this one did not", async () => {
    const t = convexTest(schema, modules);

    // A first run projects two players.
    await t.mutation(internal.projections.upsertBatch, {
      rows: [row("traded", "KC"), row("kept", "BUF")],
      computedAt: 1_000,
    });

    // The second run re-projects only one of them — the other has since been traded to a
    // team on bye, so no row is written for them at all.
    await t.mutation(internal.projections.upsertBatch, {
      rows: [row("kept", "BUF")],
      computedAt: 2_000,
    });

    const { deleted } = await t.mutation(internal.projections.pruneStale, {
      season: SEASON,
      week: WEEK,
      computedBefore: 2_000,
    });

    expect(deleted).toBe(1);
    const served = await t.query(api.projections.forWeek, {
      season: SEASON,
      week: WEEK,
      scoringId: "ppr",
    });
    expect(served.map((p) => p.playerId)).toEqual(["kept"]);
  });

  it("keeps every ruleset's rows, not just the one that was rewritten", async () => {
    // `pruneStale` scans on a prefix of by_week_scoring, so it sees all rulesets at once.
    // The cutoff, not the ruleset, has to be what decides — otherwise a Half PPR board
    // would be deleted by a PPR run.
    const t = convexTest(schema, modules);

    await t.mutation(internal.projections.upsertBatch, {
      rows: [row("a", "KC", "ppr"), row("a", "KC", "half_ppr")],
      computedAt: 2_000,
    });

    const { deleted } = await t.mutation(internal.projections.pruneStale, {
      season: SEASON,
      week: WEEK,
      computedBefore: 2_000,
    });

    expect(deleted).toBe(0);
    for (const scoringId of ["ppr", "half_ppr"]) {
      const served = await t.query(api.projections.forWeek, {
        season: SEASON,
        week: WEEK,
        scoringId,
      });
      expect(served).toHaveLength(1);
    }
  });

  it("leaves other weeks alone", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.projections.upsertBatch, {
      rows: [row("a", "KC"), { ...row("a", "KC"), week: WEEK + 1 }],
      computedAt: 1_000,
    });

    await t.mutation(internal.projections.pruneStale, {
      season: SEASON,
      week: WEEK,
      computedBefore: 2_000,
    });

    const next = await t.query(api.projections.forWeek, {
      season: SEASON,
      week: WEEK + 1,
      scoringId: "ppr",
    });
    expect(next).toHaveLength(1);
  });
});
