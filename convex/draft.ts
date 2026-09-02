import { v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { OUTCOME_QUANTILES, PLACEHOLDER_QUANTILES } from "../lib/nfl/model/config";

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
  sleeperId: v.optional(v.string()),
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

const rosterStatusValidator = v.union(
  v.literal("active"),
  v.literal("cut"),
  v.literal("practice-squad"),
  v.literal("reserve"),
  v.literal("inactive"),
  v.literal("retired"),
  v.literal("traded"),
  v.literal("unknown"),
);

/** One current identity/status row, independent of any league's valuation. */
const catalogRowValidator = v.object({
  playerId: v.string(),
  sleeperId: v.optional(v.string()),
  name: v.string(),
  position: v.string(),
  team: v.union(v.string(), v.null()),
  byeWeek: v.union(v.number(), v.null()),
  rosterStatus: rosterStatusValidator,
  rosterStatusCode: v.string(),
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

    const catalogRun = await publishedCatalogRun(ctx, season);
    const catalogRows =
      catalogRun === null
        ? []
        : await ctx.db
            .query("draftPlayerCatalog")
            .withIndex("by_catalog_run", (q) =>
              q
                .eq("sport", "nfl")
                .eq("season", season)
                .eq("computedAt", catalogRun.publishedAt),
            )
            .collect();
    const catalogById = new Map(catalogRows.map((row) => [row.playerId, row]));
    const valuedIds = new Set(rows.map((row) => row.playerId));

    // A valuation and an identity/status snapshot move on different clocks. Join them at
    // read time: prices can stay atomic per league shape while one catalog refresh updates
    // every shape's roster truth at once.
    const served = rows.map((row) => {
      const current = catalogById.get(row.playerId);
      const isDefense = row.position === "DST";
      const rosterStatus =
        current?.rosterStatus ??
        (isDefense ? "active" : catalogRun === null ? null : "unknown");
      return {
        playerId: row.playerId,
        ...((current?.sleeperId ?? row.sleeperId) === undefined
          ? {}
          : { sleeperId: current?.sleeperId ?? row.sleeperId }),
        name: current?.name ?? row.name,
        position: current?.position ?? row.position,
        team: current?.team ?? row.team,
        modelPoints: row.modelPoints,
        marketPoints: row.marketPoints,
        // Older published runs predate this field. `null` means the client knows no basis;
        // it must not infer one from equal, rounded player values.
        marketValueBasis: row.marketValueBasis ?? null,
        blendedPoints: row.blendedPoints as number | null,
        adp: row.adp,
        adpStdev: row.adpStdev,
        byeWeek: current?.byeWeek ?? row.byeWeek,
        availability: row.availability as number | null,
        p10: row.p10,
        p90: row.p90,
        quantileProvenance: row.quantileProvenance,
        rosterStatus,
        rosterStatusCode:
          current?.rosterStatusCode ?? (isDefense ? "TEAM" : null),
        statusUpdatedAt: catalogRun?.checkedAt ?? null,
      };
    });

    // The catalog is the recordability contract. A missing valuation becomes an explicit
    // unpriced row instead of becoming a missing player. It is kept out of recommendation
    // inputs on the client, but remains searchable and can be attached to a real pick.
    for (const current of catalogRows) {
      if (valuedIds.has(current.playerId)) continue;
      const band =
        OUTCOME_QUANTILES[current.position as keyof typeof OUTCOME_QUANTILES] ??
        PLACEHOLDER_QUANTILES;
      served.push({
        playerId: current.playerId,
        ...(current.sleeperId === undefined ? {} : { sleeperId: current.sleeperId }),
        name: current.name,
        position: current.position,
        team: current.team,
        modelPoints: null,
        marketPoints: null,
        marketValueBasis: null,
        blendedPoints: null,
        adp: null,
        adpStdev: null,
        byeWeek: current.byeWeek,
        availability: null,
        p10: band.p10,
        p90: band.p90,
        quantileProvenance: band.provenance,
        rosterStatus: current.rosterStatus,
        rosterStatusCode: current.rosterStatusCode,
        statusUpdatedAt: catalogRun?.checkedAt ?? null,
      });
    }

    // Advice first, record-only identities second. Within those groups the original value
    // order remains total and deterministic. A current reserve player with an old high ADP
    // must not sit above healthy recommendations merely because the value snapshot predates
    // his designation.
    served.sort((a, b) => {
      const group = (row: (typeof served)[number]) => {
        const eligible = row.rosterStatus === null || row.rosterStatus === "active";
        if (eligible && row.blendedPoints !== null) return 0;
        if (eligible) return 1;
        if (row.rosterStatus === "unknown") return 3;
        return 2;
      };
      return (
        group(a) - group(b) ||
        (b.blendedPoints ?? Number.NEGATIVE_INFINITY) -
          (a.blendedPoints ?? Number.NEGATIVE_INFINITY) ||
        a.name.localeCompare(b.name) ||
        (a.playerId < b.playerId ? -1 : 1)
      );
    });

    return served;
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

/** Fingerprint of the live snapshot, for the refresh action's unchanged fast path. */
export const catalogRunState = internalQuery({
  args: { season: v.number() },
  handler: async (ctx, { season }) => {
    const run = await publishedCatalogRun(ctx, season);
    if (run === null) return null;
    return {
      publishedAt: run.publishedAt,
      checkedAt: run.checkedAt,
      fingerprint: run.fingerprint,
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

/** One job kind for the season-wide identity/status snapshot. */
export function catalogJobKind(season: number): string {
  return `draft-catalog:${season}`;
}

/**
 * Freshness and drift of the status layer, reported independently from valuation age.
 *
 * A six-hour-old price can be usable while a six-hour-old roster designation is not. One
 * timestamp for both lets the slower clock hide the faster one's failure, which is exactly
 * how a morning board still recommended an afternoon-exempt player.
 */
export const catalogFreshness = query({
  args: { season: v.number() },
  handler: async (ctx, { season }) => {
    const run = await publishedCatalogRun(ctx, season);
    const attempt = await ctx.db
      .query("jobs")
      .withIndex("by_kind_started", (q) => q.eq("kind", catalogJobKind(season)))
      .order("desc")
      .first();

    if (run === null && attempt === null) return null;
    return {
      computedAt: run?.checkedAt ?? null,
      playerCount: run?.playerCount ?? null,
      activeCount: run?.activeCount ?? null,
      unknownStatuses: run?.unknownStatuses ?? [],
      lastAttemptAt: attempt?.startedAt ?? null,
      lastAttemptStatus: attempt?.status ?? null,
    };
  },
});

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

/** The newest complete season catalog snapshot, or null before the first refresh. */
async function publishedCatalogRun(
  ctx: QueryCtx,
  season: number,
): Promise<Doc<"draftPlayerCatalogRuns"> | null> {
  const runs = await ctx.db
    .query("draftPlayerCatalogRuns")
    .withIndex("by_catalog", (q) => q.eq("sport", "nfl").eq("season", season))
    .collect();
  if (runs.length === 0) return null;
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

/** Writes one run-scoped batch of the complete draft player catalog. */
export const upsertCatalogBatch = internalMutation({
  args: {
    season: v.number(),
    computedAt: v.number(),
    rows: v.array(catalogRowValidator),
  },
  handler: async (ctx, { season, computedAt, rows }) => {
    let written = 0;
    for (const row of rows) {
      const forPlayer = await ctx.db
        .query("draftPlayerCatalog")
        .withIndex("by_catalog_player", (q) =>
          q.eq("sport", "nfl").eq("season", season).eq("playerId", row.playerId),
        )
        .collect();
      const thisRun = forPlayer.find((existing) => existing.computedAt === computedAt);
      const doc = { sport: "nfl", season, ...row, computedAt };
      if (thisRun) await ctx.db.patch(thisRun._id, doc);
      else await ctx.db.insert("draftPlayerCatalog", doc);
      written += 1;
    }
    return { written };
  },
});

/** Atomically makes a complete identity/status snapshot visible to every draft shape. */
export const publishCatalog = internalMutation({
  args: {
    season: v.number(),
    computedAt: v.number(),
    playerCount: v.number(),
    activeCount: v.number(),
    fingerprint: v.string(),
    unknownStatuses: v.array(v.object({ code: v.string(), count: v.number() })),
  },
  handler: async (
    ctx,
    { season, computedAt, playerCount, activeCount, fingerprint, unknownStatuses },
  ) => {
    const runs = await ctx.db
      .query("draftPlayerCatalogRuns")
      .withIndex("by_catalog", (q) => q.eq("sport", "nfl").eq("season", season))
      .collect();
    const [existing, ...duplicates] = runs;
    if (existing) {
      for (const duplicate of duplicates) await ctx.db.delete(duplicate._id);
      if (computedAt <= existing.publishedAt) return;
      await ctx.db.patch(existing._id, {
        publishedAt: computedAt,
        checkedAt: computedAt,
        fingerprint,
        playerCount,
        activeCount,
        unknownStatuses,
      });
      return;
    }
    await ctx.db.insert("draftPlayerCatalogRuns", {
      sport: "nfl",
      season,
      publishedAt: computedAt,
      checkedAt: computedAt,
      fingerprint,
      playerCount,
      activeCount,
      unknownStatuses,
    });
  },
});

/** Marks an unchanged snapshot freshly verified without rewriting hundreds of rows. */
export const touchCatalog = internalMutation({
  args: {
    season: v.number(),
    checkedAt: v.number(),
    fingerprint: v.string(),
  },
  handler: async (ctx, { season, checkedAt, fingerprint }) => {
    const runs = await ctx.db
      .query("draftPlayerCatalogRuns")
      .withIndex("by_catalog", (q) => q.eq("sport", "nfl").eq("season", season))
      .collect();
    if (runs.length === 0) return { touched: false };
    const newest = runs.reduce((latest, run) =>
      run.publishedAt > latest.publishedAt ? run : latest,
    );
    // The action read this fingerprint before asking to touch. If another refresh
    // published between those operations, do not put the new run under the old check time.
    if (newest.fingerprint !== fingerprint || checkedAt <= newest.checkedAt) {
      return { touched: false };
    }
    await ctx.db.patch(newest._id, { checkedAt });
    return { touched: true };
  },
});

/** Bounded cleanup of catalog runs no reader can see after publication. */
export const pruneCatalog = internalMutation({
  args: { season: v.number(), computedBefore: v.number() },
  handler: async (ctx, { season, computedBefore }) => {
    const stale = await ctx.db
      .query("draftPlayerCatalog")
      .withIndex("by_catalog_run", (q) =>
        q
          .eq("sport", "nfl")
          .eq("season", season)
          .lt("computedAt", computedBefore),
      )
      .take(PRUNE_PAGE + 1);
    const page = stale.slice(0, PRUNE_PAGE);
    for (const row of page) await ctx.db.delete(row._id);
    return { deleted: page.length, more: stale.length > PRUNE_PAGE };
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
