import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";

/**
 * Draft board reads and writes.
 *
 * The board is public, like projections. A draft is the moment a fantasy product is most
 * useful and most likely to be tried for the first time; putting it behind an account
 * would mean nobody ever sees whether it works.
 */

/** One row of the board, as the interface consumes it. */
const boardRowValidator = v.object({
  playerId: v.string(),
  name: v.string(),
  position: v.string(),
  team: v.union(v.string(), v.null()),
  modelPoints: v.union(v.number(), v.null()),
  marketPoints: v.union(v.number(), v.null()),
  blendedPoints: v.number(),
  adp: v.union(v.number(), v.null()),
  adpStdev: v.union(v.number(), v.null()),
  byeWeek: v.union(v.number(), v.null()),
  availability: v.number(),
  p10: v.number(),
  p90: v.number(),
});

/**
 * The whole board for a league shape, ranked by blended value.
 *
 * Deliberately unpaginated. A draft board is a few hundred rows, the client needs all of
 * them to compute recommendations against an arbitrary roster, and a capped board would
 * silently make late-round players undraftable — the same defect the lineup picker had.
 */
export const board = query({
  args: {
    season: v.number(),
    scoringId: v.string(),
    teams: v.number(),
  },
  handler: async (ctx, { season, scoringId, teams }) => {
    const rows = await ctx.db
      .query("draftBoard")
      .withIndex("by_board", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams),
      )
      .collect();

    rows.sort(
      (a, b) =>
        b.blendedPoints - a.blendedPoints || (a.playerId < b.playerId ? -1 : 1),
    );

    return rows.map((row) => ({
      playerId: row.playerId,
      name: row.name,
      position: row.position,
      team: row.team,
      modelPoints: row.modelPoints,
      marketPoints: row.marketPoints,
      blendedPoints: row.blendedPoints,
      adp: row.adp,
      adpStdev: row.adpStdev,
      byeWeek: row.byeWeek,
      availability: row.availability,
      p10: row.p10,
      p90: row.p90,
    }));
  },
});

/** When the board was last rebuilt, so the interface can say rather than imply. */
export const boardFreshness = query({
  args: { season: v.number(), scoringId: v.string(), teams: v.number() },
  handler: async (ctx, { season, scoringId, teams }) => {
    // The newest `computedAt` on the board, not the first row the index happens to yield.
    // Index order is by the board key and has nothing to do with when a row was written,
    // and `upsertBoardBatch` writes batch by batch — so mid-rebuild the board holds a mix
    // of old and new timestamps and `.first()` could return either. The interface states
    // this figure to the user as the board's freshness, which `.first()` cannot support:
    // it could call a mostly-stale board fresh, or a mostly-new one stale.
    const rows = await ctx.db
      .query("draftBoard")
      .withIndex("by_board", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams),
      )
      .collect();
    if (rows.length === 0) return null;
    return { computedAt: Math.max(...rows.map((row) => row.computedAt)) };
  },
});

/** Writes a batch of board rows. Idempotent per (board, player). */
export const upsertBoardBatch = internalMutation({
  args: {
    season: v.number(),
    scoringId: v.string(),
    teams: v.number(),
    computedAt: v.number(),
    rows: v.array(boardRowValidator),
  },
  handler: async (ctx, { season, scoringId, teams, computedAt, rows }) => {
    let written = 0;
    for (const row of rows) {
      const existing = await ctx.db
        .query("draftBoard")
        .withIndex("by_board_player", (q) =>
          q
            .eq("sport", "nfl")
            .eq("season", season)
            .eq("scoringId", scoringId)
            .eq("teams", teams)
            .eq("playerId", row.playerId),
        )
        .first();

      const doc = { sport: "nfl", season, scoringId, teams, ...row, computedAt };
      if (existing) await ctx.db.patch(existing._id, doc);
      else await ctx.db.insert("draftBoard", doc);
      written += 1;
    }
    return { written };
  },
});

/**
 * Removes rows the run that just completed did not rewrite.
 *
 * Same reasoning as `projections.pruneStale`: without it, a player who drops off the
 * market's board keeps being served with a stale price, and the board slowly accumulates
 * players nobody is drafting. Scoped to one league shape so rebuilding the 12-team board
 * cannot empty the 10-team one.
 */
export const pruneBoard = internalMutation({
  args: {
    season: v.number(),
    scoringId: v.string(),
    teams: v.number(),
    computedBefore: v.number(),
  },
  handler: async (ctx, { season, scoringId, teams, computedBefore }) => {
    const stale = await ctx.db
      .query("draftBoard")
      .withIndex("by_board", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams),
      )
      .filter((q) => q.lt(q.field("computedAt"), computedBefore))
      .collect();

    for (const row of stale) await ctx.db.delete(row._id);
    return { deleted: stale.length };
  },
});
