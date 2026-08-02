import { v } from "convex/values";

import type { QueryCtx } from "./_generated/server";
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
    // Only the rows belonging to the last run that finished. The table is written batch by
    // batch, so a run that failed partway leaves its rows interleaved with the previous
    // board's — and served together they are part this week's prices and part last week's,
    // with nothing to say so.
    const published = await publishedRun(ctx, season, scoringId, teams);
    if (published === null) return [];

    const rows = (
      await ctx.db
        .query("draftBoard")
        .withIndex("by_board", (q) =>
          q
            .eq("sport", "nfl")
            .eq("season", season)
            .eq("scoringId", scoringId)
            .eq("teams", teams),
        )
        .collect()
    ).filter((row) => row.computedAt === published);

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
    // The published run's own timestamp, which is the one figure that describes the board
    // as a whole. This used to take `.first()` from the board itself — index order, which
    // has nothing to do with write time — so mid-rebuild it could call a mostly stale
    // board fresh or a mostly new one stale.
    const published = await publishedRun(ctx, season, scoringId, teams);
    return published === null ? null : { computedAt: published };
  },
});

/** `computedAt` of the last completed run for a league shape, or `null` if none has. */
async function publishedRun(
  ctx: QueryCtx,
  season: number,
  scoringId: string,
  teams: number,
): Promise<number | null> {
  const run = await ctx.db
    .query("draftBoardRuns")
    .withIndex("by_board", (q) =>
      q
        .eq("sport", "nfl")
        .eq("season", season)
        .eq("scoringId", scoringId)
        .eq("teams", teams),
    )
    .first();
  return run === null ? null : run.publishedAt;
}

/**
 * Marks a run's rows as the board, after every batch has landed.
 *
 * The last step of a rebuild, and the only one that changes what readers see. Until it
 * runs, a partially written board is invisible and the previous one is still whole.
 */
export const publishBoard = internalMutation({
  args: {
    season: v.number(),
    scoringId: v.string(),
    teams: v.number(),
    computedAt: v.number(),
  },
  handler: async (ctx, { season, scoringId, teams, computedAt }) => {
    const existing = await ctx.db
      .query("draftBoardRuns")
      .withIndex("by_board", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams),
      )
      .first();

    const doc = { sport: "nfl", season, scoringId, teams, publishedAt: computedAt };
    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("draftBoardRuns", doc);
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
      // Matched on the run as well as the player. Patching whichever row already existed
      // for this player overwrote the *live* board with a run that had not been published
      // yet — so a rebuild that failed halfway had already destroyed the rows it was going
      // to replace, and the previous board could not be served whole. A run writes its own
      // rows and leaves the last one alone until `publishBoard` swaps them.
      //
      // Still idempotent: a retried batch carries the same `computedAt`, finds its own row
      // and patches it rather than inserting a duplicate.
      const forPlayer = await ctx.db
        .query("draftBoard")
        .withIndex("by_board_player", (q) =>
          q
            .eq("sport", "nfl")
            .eq("season", season)
            .eq("scoringId", scoringId)
            .eq("teams", teams)
            .eq("playerId", row.playerId),
        )
        .collect();
      const thisRun = forPlayer.find((existing) => existing.computedAt === computedAt);

      const doc = { sport: "nfl", season, scoringId, teams, ...row, computedAt };
      if (thisRun) await ctx.db.patch(thisRun._id, doc);
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
