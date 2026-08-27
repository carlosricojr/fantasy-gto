import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
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
  marketValueBasis: v.union(
    v.literal("adp-ordered"),
    v.literal("position-mean"),
    v.literal("pooled-mean"),
    v.null(),
  ),
  blendedPoints: v.number(),
  adp: v.union(v.number(), v.null()),
  adpStdev: v.union(v.number(), v.null()),
  byeWeek: v.union(v.number(), v.null()),
  availability: v.number(),
  p10: v.number(),
  p90: v.number(),
  quantileProvenance: v.union(v.literal("measured"), v.literal("placeholder")),
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
    const run = await publishedRun(ctx, season, scoringId, teams);
    if (run === null) return [];
    const published = run.publishedAt;

    const rows = await ctx.db
      .query("draftBoard")
      .withIndex("by_board_run", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams)
          .eq("computedAt", published),
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
      // Older published runs predate this field. `null` means the client knows no basis;
      // it must not infer one from equal, rounded player values.
      marketValueBasis: row.marketValueBasis ?? null,
      blendedPoints: row.blendedPoints,
      adp: row.adp,
      adpStdev: row.adpStdev,
      byeWeek: row.byeWeek,
      availability: row.availability,
      p10: row.p10,
      p90: row.p90,
      // Carried to the client so the interface can decline to present an assumed spread
      // as evidence. Nothing renders a range today; the marker exists so that when
      // something does, it cannot do so without knowing which kind it has.
      quantileProvenance: row.quantileProvenance,
    }));
  },
});

/**
 * When the board was last rebuilt, where its prices came from, and how the last attempt to
 * rebuild it went.
 *
 * The last of those is the one that was missing, and its absence produced the failure this
 * query now exists to prevent: a scheduled rebuild fails, the previous board survives intact
 * — which is the *correct* behaviour and why `publishBoard` is atomic — and the interface
 * shows a timestamp that is only hours old and looks entirely healthy. Nothing distinguished
 * "rebuilt successfully at 11:00" from "tried to rebuild at 11:00 and could not".
 *
 * Deliberately public, like the board itself. `jobs.latest` requires a user, and this needs
 * to answer for somebody deciding whether to trust a board before they have an account.
 * Only the shape of the attempt is exposed — when, and whether it succeeded — never the
 * error text, which can carry a provider URL.
 */
export const boardFreshness = query({
  args: { season: v.number(), scoringId: v.string(), teams: v.number() },
  handler: async (ctx, { season, scoringId, teams }) => {
    // The published run's own timestamp, which is the one figure that describes the board
    // as a whole. This used to take `.first()` from the board itself — index order, which
    // has nothing to do with write time — so mid-rebuild it could call a mostly stale
    // board fresh or a mostly new one stale.
    const run = await publishedRun(ctx, season, scoringId, teams);
    // The attempt is reported whether or not a board exists. A shape that has *never* built
    // and a shape whose last three attempts failed are different problems, and returning
    // `null` for both collapses them.
    const attempt = await ctx.db
      .query("jobs")
      .withIndex("by_kind_started", (q) =>
        q.eq("kind", boardJobKind(season, scoringId, teams)),
      )
      .order("desc")
      .first();

    if (run === null && attempt === null) return null;
    return {
      computedAt: run?.publishedAt ?? null,
      // `null` where the run predates the field, which reads as "unknown provenance" rather
      // than as "published directly". They are different claims, and defaulting to the
      // reassuring one is how a derived board would come to be presented as a real one.
      adpSourceTeams: run?.adpSourceTeams ?? null,
      lastAttemptAt: attempt?.startedAt ?? null,
      // `running` is carried through rather than folded into a boolean, because a rebuild in
      // flight must outrank every warning: telling somebody to fix a board that is already
      // being replaced sends them to fix what is fixing itself.
      lastAttemptStatus: attempt?.status ?? null,
    };
  },
});

/**
 * The `jobs.kind` a board build records itself under.
 *
 * One definition, used by the writer in `ingest.ts` and the reader above. They were the same
 * template string written twice, which is a join that silently returns nothing when one side
 * changes — and "no attempt recorded" is indistinguishable from "no attempt made".
 */
export function boardJobKind(
  season: number,
  scoringId: string,
  teams: number,
): string {
  return `draft:${season}-${scoringId}-${teams}`;
}

/** `computedAt` of the last completed run for a league shape, or `null` if none has. */
async function publishedRun(
  ctx: QueryCtx,
  season: number,
  scoringId: string,
  teams: number,
): Promise<Doc<"draftBoardRuns"> | null> {
  // The greatest `publishedAt`, not the first row. One row per shape is the invariant —
  // `publishBoard` patches rather than inserting when one exists, and Convex mutations are
  // serializable, so two concurrent publishes cannot both find none — but `by_board` is not
  // a unique index and nothing in the database enforces it. Reading `.first()` meant that
  // if the invariant ever broke, the board served would be whichever row the index happened
  // to return, which could be the older one.
  //
  // Taking the maximum makes a corrupted state fail toward the newest board rather than an
  // arbitrary one, and costs nothing: the range holds one row.
  const runs = await ctx.db
    .query("draftBoardRuns")
    .withIndex("by_board", (q) =>
      q
        .eq("sport", "nfl")
        .eq("season", season)
        .eq("scoringId", scoringId)
        .eq("teams", teams),
    )
    .collect();
  if (runs.length === 0) return null;
  // The whole row rather than only its timestamp, because callers now need the provenance
  // alongside it and reading them from two separate maxima could pair one run's timestamp
  // with another's source.
  return runs.reduce((newest, run) =>
    run.publishedAt > newest.publishedAt ? run : newest,
  );
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
    /** The league size the market prices were published for. */
    adpSourceTeams: v.number(),
  },
  handler: async (ctx, { season, scoringId, teams, computedAt, adpSourceTeams }) => {
    const rows = await ctx.db
      .query("draftBoardRuns")
      .withIndex("by_board", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams),
      )
      .collect();

    // Collapsed rather than half-updated. One row per shape is the invariant and nothing in
    // the database enforces it, so if a second ever appears — a migration, a manual write —
    // patching only the one the index returned first would leave the other claiming to be
    // current. The survivor carries the newest timestamp either row held.
    const [existing, ...duplicates] = rows;
    for (const duplicate of duplicates) {
      if (duplicate.publishedAt > existing.publishedAt) {
        await ctx.db.patch(existing._id, { publishedAt: duplicate.publishedAt });
        existing.publishedAt = duplicate.publishedAt;
      }
      await ctx.db.delete(duplicate._id);
    }

    // Monotonic. Two rebuilds for one shape can overlap — a retry, or a manual run beside
    // the cron — and if the older one publishes last the pointer retreats. `pruneBoard`
    // then deletes everything with `computedAt < computedBefore`, which is the *newer*
    // board, so a late-finishing stale run would take the current one with it.
    if (existing) {
      if (computedAt > existing.publishedAt) {
        // Both together. The provenance describes the run being published, so patching the
        // timestamp without it would leave a new board wearing the previous run's source —
        // and the one case where that changes is the one where it matters, a size whose
        // published board appeared or disappeared between rebuilds.
        await ctx.db.patch(existing._id, {
          publishedAt: computedAt,
          adpSourceTeams,
        });
      }
      return;
    }
    await ctx.db.insert("draftBoardRuns", {
      sport: "nfl",
      season,
      scoringId,
      teams,
      publishedAt: computedAt,
      adpSourceTeams,
    });
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
/** Rows deleted per `pruneBoard` call, so one mutation stays inside its limits. */
const PRUNE_PAGE = 256;

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
      .withIndex("by_board_run", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .eq("scoringId", scoringId)
          .eq("teams", teams)
          .lt("computedAt", computedBefore),
      )
      .take(PRUNE_PAGE + 1);

    // Bounded, and the caller is told whether to come back. A failed rebuild leaves its
    // rows behind — `publishBoard` never pointed at them and the ingest path only prunes
    // after a successful publish — so the stale set is not bounded by one run's size, and
    // a single mutation deleting all of it eventually exceeds what a transaction can do.
    // Failing there would mean the pruning never happens at all.
    const page = stale.slice(0, PRUNE_PAGE);
    for (const row of page) await ctx.db.delete(row._id);
    return { deleted: page.length, more: stale.length > PRUNE_PAGE };
  },
});
