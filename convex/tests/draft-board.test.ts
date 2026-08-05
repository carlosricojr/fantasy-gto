import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";

/**
 * Publishing a draft board.
 *
 * The board is written batch by batch, which means there is always a window in which the
 * table holds part of the run in progress and part of the run before it. Nothing about a
 * failed run cleans that up — the job is marked failed and the mixed rows stay.
 *
 * Served together those rows are part this week's prices and part last week's, with a
 * freshness line confidently reporting one of the two timestamps. That is worse than an
 * outage: a user drafting against it has no way to tell. So a run becomes visible only
 * once every batch has landed, and until then readers keep seeing the previous board
 * whole.
 */
const modules = import.meta.glob([
  "../**/*.ts",
  "../**/*.js",
  "!../**/*.d.ts",
  "!../**/*.test.ts",
  "!../tests/**",
]);

const SEASON = 2026;
const SCORING = "ppr";
const TEAMS = 12;

function row(playerId: string, blendedPoints: number) {
  return {
    playerId,
    name: playerId,
    position: "RB",
    team: "SF",
    modelPoints: null,
    marketPoints: blendedPoints,
    blendedPoints,
    adp: 10,
    adpStdev: 5,
    byeWeek: 9,
    availability: 0.9,
    p10: 0.3,
    p90: 1.9,
    quantileProvenance: "measured" as const,
  };
}

const shape = { season: SEASON, scoringId: SCORING, teams: TEAMS };

describe("draft board publishing", () => {
  it("serves nothing until a run has completed", async () => {
    const t = convexTest(schema, modules);
    // Rows written but never published: a run that died before its last batch.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 1_000,
      rows: [row("a", 200)],
    });

    expect(await t.query(api.draft.board, shape)).toEqual([]);
    expect(await t.query(api.draft.boardFreshness, shape)).toBeNull();
  });

  it("keeps serving the previous board whole when a rebuild dies mid-write", async () => {
    const t = convexTest(schema, modules);

    // A complete run at t=1000.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 1_000,
      rows: [row("a", 200), row("b", 150)],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 1_000 });

    // A second run that lands one batch and then fails: no publish, no prune.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 2_000,
      rows: [row("a", 999)],
    });

    // The old board, entire and unmixed — not one row at the new price and one at the old.
    const served = await t.query(api.draft.board, shape);
    expect(served.map((r) => r.playerId)).toEqual(["a", "b"]);
    expect(served.find((r) => r.playerId === "a")?.blendedPoints).toBe(200);
    expect(await t.query(api.draft.boardFreshness, shape)).toEqual({ computedAt: 1_000 });
  });

  it("swaps the whole board at once when the rebuild finishes", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 1_000,
      rows: [row("a", 200), row("gone", 150)],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 1_000 });

    // The replacement drops `gone` and reprices `a`.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 2_000,
      rows: [row("a", 111), row("c", 90)],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 2_000 });
    await t.mutation(internal.draft.pruneBoard, { ...shape, computedBefore: 2_000 });

    const served = await t.query(api.draft.board, shape);
    expect(served.map((r) => r.playerId)).toEqual(["a", "c"]);
    expect(served.find((r) => r.playerId === "a")?.blendedPoints).toBe(111);
    expect(await t.query(api.draft.boardFreshness, shape)).toEqual({ computedAt: 2_000 });
  });

  it("serves the provenance it stored, both values", async () => {
    // Pinned in both directions. Asserting only one lets the read be replaced by that
    // constant with the suite still green — which is what a previous version of this test
    // allowed, since it covered a fallback and never a stored value.
    const t = convexTest(schema, modules);
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 1_000,
      rows: [
        { ...row("measured-player", 200), quantileProvenance: "measured" as const },
        { ...row("placeholder-player", 100), quantileProvenance: "placeholder" as const },
      ],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 1_000 });

    const served = await t.query(api.draft.board, shape);
    const byId = new Map(served.map((r) => [r.playerId, r.quantileProvenance]));
    expect(byId.get("measured-player")).toBe("measured");
    expect(byId.get("placeholder-player")).toBe("placeholder");
  });

  it("does not let a stale run that finishes late take the current board with it", async () => {
    const t = convexTest(schema, modules);

    // The newer rebuild lands and publishes first.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 5_000,
      rows: [row("new", 200)],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 5_000 });

    // An older one — a retry, or a manual run beside the cron — finishes afterwards. If it
    // moved the pointer back to 4000, its own prune would then delete every row with
    // `computedAt < 4000` and the newer board would be what `computedAt >= 4000` kept, but
    // the *pointer* would be serving 4000's rows: the live board replaced by a stale one
    // that happened to be slower. The published pointer only ever moves forward.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 4_000,
      rows: [row("old", 111)],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 4_000 });

    expect(await t.query(api.draft.boardFreshness, shape)).toEqual({ computedAt: 5_000 });
    expect((await t.query(api.draft.board, shape)).map((r) => r.playerId)).toEqual(["new"]);

    // And the stale run's own prune cannot remove the live board either.
    await t.mutation(internal.draft.pruneBoard, { ...shape, computedBefore: 4_000 });
    expect((await t.query(api.draft.board, shape)).map((r) => r.playerId)).toEqual(["new"]);
  });

  it("serves the newest run if a second pointer row ever appears", async () => {
    // One row per board shape is the invariant: `publishBoard` patches when it finds one,
    // and Convex mutations are serializable so two concurrent publishes cannot both find
    // none. But `by_board` is not a unique index and nothing in the database enforces it —
    // a migration or a manual write could leave two. Reading the first row would then serve
    // whichever the index happened to return, which may be the older.
    //
    // Written directly through the harness, because no code path produces this state; the
    // point is what happens if one ever does.
    const t = convexTest(schema, modules);
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 1_000,
      rows: [row("old", 111)],
    });
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 2_000,
      rows: [row("new", 222)],
    });
    await t.run(async (ctx) => {
      for (const publishedAt of [1_000, 2_000]) {
        await ctx.db.insert("draftBoardRuns", {
          sport: "nfl",
          season: SEASON,
          scoringId: SCORING,
          teams: TEAMS,
          publishedAt,
        });
      }
    });

    // The newer run is served, not whichever row came back first.
    expect(await t.query(api.draft.boardFreshness, shape)).toEqual({ computedAt: 2_000 });
    expect((await t.query(api.draft.board, shape)).map((r) => r.playerId)).toEqual(["new"]);

    // And the next publish collapses them rather than half-updating one.
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 3_000 });
    const remaining = await t.run(async (ctx) => ctx.db.query("draftBoardRuns").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].publishedAt).toBe(3_000);
  });

  it("does not let a rebuild of one league size disturb another", async () => {
    const t = convexTest(schema, modules);
    const ten = { season: SEASON, scoringId: SCORING, teams: 10 };

    for (const s of [shape, ten]) {
      await t.mutation(internal.draft.upsertBoardBatch, {
        ...s,
        computedAt: 1_000,
        rows: [row("a", 200)],
      });
      await t.mutation(internal.draft.publishBoard, { ...s, computedAt: 1_000 });
    }

    // Republish the 12-team board only.
    await t.mutation(internal.draft.upsertBoardBatch, {
      ...shape,
      computedAt: 3_000,
      rows: [row("a", 42)],
    });
    await t.mutation(internal.draft.publishBoard, { ...shape, computedAt: 3_000 });
    await t.mutation(internal.draft.pruneBoard, { ...shape, computedBefore: 3_000 });

    expect((await t.query(api.draft.board, ten))[0].blendedPoints).toBe(200);
    expect(await t.query(api.draft.boardFreshness, ten)).toEqual({ computedAt: 1_000 });
    expect((await t.query(api.draft.board, shape))[0].blendedPoints).toBe(42);
  });
});
