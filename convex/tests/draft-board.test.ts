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
