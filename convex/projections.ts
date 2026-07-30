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
 * than an arbitrary page. Position filtering happens in the database predicate where
 * possible and in memory only across the already-narrow week slice.
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
      .unique();
  },
});

/** Projections for a specific set of players, for rendering a roster. */
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
        .unique();
      if (row) results.push(row);
    }
    return results;
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
        mean: v.number(),
        floor: v.number(),
        ceiling: v.number(),
        contributions: v.array(contributionValidator),
        modelVersion: v.string(),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const now = Date.now();
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
        .unique();

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
        .unique();
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
        .unique();
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
