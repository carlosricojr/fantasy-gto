import { v } from "convex/values";

import { internalMutation, query } from "./_generated/server";

/**
 * Projection reads and writes.
 *
 * Every read goes through an index. The previous implementation called `.collect()` on the
 * whole projections table and filtered in JavaScript, which cannot meet the latency target
 * and gets slower with every week of data added.
 */

const contributionValidator = v.object({
  key: v.string(),
  label: v.string(),
  points: v.number(),
  detail: v.string(),
});

/**
 * Projections for a week, ranked by mean.
 *
 * `limit` is applied after sorting so the caller always receives the top players rather
 * than an arbitrary page. Position is filtered in memory: `by_week_scoring` carries no
 * position component, and adding one to narrow a slice that is already a single week of a
 * single ruleset would not pay for itself.
 */
export const forWeek = query({
  args: {
    season: v.number(),
    week: v.number(),
    scoringId: v.string(),
    position: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { season, week, scoringId, position, limit }) => {
    const rows = await ctx.db
      .query("projections")
      .withIndex("by_week_scoring", (q) =>
        q.eq("sport", "nfl").eq("season", season).eq("week", week).eq("scoringId", scoringId),
      )
      .collect();

    const filtered = position ? rows.filter((row) => row.position === position) : rows;
    filtered.sort((a, b) => b.mean - a.mean || (a.playerId < b.playerId ? -1 : 1));
    return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  },
});

/** A single player's projection for a week, with its explanation. */
export const forPlayer = query({
  args: {
    playerId: v.string(),
    season: v.number(),
    week: v.number(),
    scoringId: v.string(),
  },
  handler: async (ctx, { playerId, season, week, scoringId }) => {
    return await ctx.db
      .query("projections")
      .withIndex("by_player_week_scoring", (q) =>
        q.eq("playerId", playerId).eq("season", season).eq("week", week).eq("scoringId", scoringId),
      )
      .first();
  },
});

/**
 * Projections for a specific set of players, for rendering a roster.
 *
 * The reason this exists rather than reusing `forWeek`: that query is capped by `limit`,
 * so a page cannot rely on it to contain a player the user has already chosen. Switching
 * ruleset re-ranks everyone, and a player inside the cap under PPR can fall outside it
 * under Standard — at which point a lineup built from the capped board would quietly drop
 * them and still present the result as optimal.
 */
export const forPlayers = query({
  args: {
    playerIds: v.array(v.string()),
    season: v.number(),
    week: v.number(),
    scoringId: v.string(),
  },
  handler: async (ctx, { playerIds, season, week, scoringId }) => {
    const results = [];
    for (const playerId of playerIds) {
      const row = await ctx.db
        .query("projections")
        .withIndex("by_player_week_scoring", (q) =>
          q
            .eq("playerId", playerId)
            .eq("season", season)
            .eq("week", week)
            .eq("scoringId", scoringId),
        )
        .first();
      if (row) results.push(row);
    }
    return results;
  },
});

/**
 * Deletes rows for a week that the run which just completed did not rewrite.
 *
 * Upserts alone leave a stale board. A player projected on Tuesday who is then traded to a
 * team on bye is simply skipped by Wednesday's run — no row is written for them and no row
 * is removed, so the Tuesday row keeps being served with its old team and old opponent.
 * `forWeek` filters on neither freshness nor job status, so `/lineup` would start a player
 * who cannot score, from a solver advertised as provably optimal.
 *
 * Called once per week after a run passes its coverage check, so a failed run never prunes
 * a good board, and scoped to the rulesets that run actually rewrote.
 */
export const pruneStale = internalMutation({
  args: {
    season: v.number(),
    week: v.number(),
    /**
     * Only these rulesets are pruned.
     *
     * `projectWeek` defaults to PPR alone, which is also the natural shape of a manual
     * re-run. Pruning the whole week would delete the Half PPR and Standard boards that
     * run never rewrote, leaving `forWeek` serving nothing for them until the next full
     * cron.
     */
    scoringIds: v.array(v.string()),
    computedBefore: v.number(),
  },
  handler: async (ctx, { season, week, scoringIds, computedBefore }) => {
    let deleted = 0;

    for (const scoringId of scoringIds) {
      // Strictly less-than: rows stamped with this run's own value are the current board.
      const stale = await ctx.db
        .query("projections")
        .withIndex("by_week_scoring", (q) =>
          q
            .eq("sport", "nfl")
            .eq("season", season)
            .eq("week", week)
            .eq("scoringId", scoringId),
        )
        .filter((q) => q.lt(q.field("computedAt"), computedBefore))
        .collect();

      for (const row of stale) await ctx.db.delete(row._id);
      deleted += stale.length;
    }

    return { deleted };
  },
});

/**
 * Writes a batch of projections.
 *
 * Internal-only and idempotent: a re-run patches the existing row for a
 * (player, season, week, ruleset) rather than inserting a duplicate. Ingest is chunked, so
 * this is called many times per run and must be safe to repeat after a partial failure.
 */
export const upsertBatch = internalMutation({
  args: {
    rows: v.array(
      v.object({
        season: v.number(),
        week: v.number(),
        playerId: v.string(),
        position: v.string(),
        scoringId: v.string(),
        team: v.string(),
        opponent: v.string(),
        mean: v.number(),
        floor: v.number(),
        ceiling: v.number(),
        contributions: v.array(contributionValidator),
        modelVersion: v.string(),
      }),
    ),
    /**
     * The stamp every row in this run carries.
     *
     * Supplied by the caller rather than read from the clock here, because a run spans
     * many transactions and `pruneStale` distinguishes this run's rows from an earlier
     * run's by exact comparison against it. Reading `Date.now()` per batch would make
     * that boundary depend on how the batches happened to fall across milliseconds.
     */
    computedAt: v.optional(v.number()),
  },
  handler: async (ctx, { rows, computedAt }) => {
    const now = computedAt ?? Date.now();
    let inserted = 0;
    let updated = 0;

    for (const row of rows) {
      const existing = await ctx.db
        .query("projections")
        .withIndex("by_player_week_scoring", (q) =>
          q
            .eq("playerId", row.playerId)
            .eq("season", row.season)
            .eq("week", row.week)
            .eq("scoringId", row.scoringId),
        )
        .first();

      const doc = { sport: "nfl", ...row, computedAt: now };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
        updated += 1;
      } else {
        await ctx.db.insert("projections", doc);
        inserted += 1;
      }
    }

    return { inserted, updated };
  },
});

/** Upserts player identity records. Internal-only. */
export const upsertPlayers = internalMutation({
  args: {
    players: v.array(
      v.object({
        externalId: v.string(),
        name: v.string(),
        position: v.string(),
        team: v.union(v.string(), v.null()),
      }),
    ),
  },
  handler: async (ctx, { players }) => {
    const now = Date.now();
    for (const player of players) {
      const existing = await ctx.db
        .query("players")
        .withIndex("by_external_id", (q) => q.eq("externalId", player.externalId))
        .first();
      const doc = { sport: "nfl", ...player, updatedAt: now };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
      } else {
        await ctx.db.insert("players", doc);
      }
    }
    return { count: players.length };
  },
});

/** Resolves player identities for a roster. */
export const playersByIds = query({
  args: { externalIds: v.array(v.string()) },
  handler: async (ctx, { externalIds }) => {
    const results = [];
    for (const externalId of externalIds) {
      const row = await ctx.db
        .query("players")
        .withIndex("by_external_id", (q) => q.eq("externalId", externalId))
        .first();
      if (row) results.push(row);
    }
    return results;
  },
});

/** Searchable player list for a position, used by roster building and waivers. */
export const playersByPosition = query({
  args: { position: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { position, limit }) => {
    return await ctx.db
      .query("players")
      .withIndex("by_sport_position", (q) => q.eq("sport", "nfl").eq("position", position))
      .take(limit ?? 200);
  },
});
