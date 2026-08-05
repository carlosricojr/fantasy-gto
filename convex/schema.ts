import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex schema.
 *
 * Two rules govern what lives here.
 *
 * **Every query must use an index.** The previous schema declared indexes but every read
 * called `.collect()` on a whole table and filtered in JavaScript, which cannot meet the
 * product's latency target and degrades with every user added. Each index below is
 * justified by a named query.
 *
 * **Raw history is not persisted.** Upstream publishes ~18,500 player-weeks per season.
 * Copying that into Convex would be expensive and pointless, since it is immutable public
 * data the ingest job can re-read at will. Only derived output — projections — and
 * genuinely user-owned state are stored.
 */
export default defineSchema({
  /**
   * A person. Created on first authenticated request and by the Clerk webhook, whichever
   * happens first, so the two race safely.
   */
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    createdAt: v.number(),
  })
    // Resolving the caller from a Clerk identity, on effectively every request.
    .index("by_clerk_id", ["clerkUserId"]),

  /**
   * Billing state, the source of truth from which entitlements are derived.
   *
   * Entitlements are deliberately not stored. They are a pure function of these fields
   * plus the clock (`lib/billing/entitlements.ts`), so there is no row a client could
   * cause to be written that would grant access.
   */
  subscriptions: defineTable({
    userId: v.id("users"),
    planId: v.union(v.literal("free"), v.literal("pro")),
    status: v.union(
      v.literal("none"),
      v.literal("trialing"),
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
    ),
    pastDueSince: v.union(v.number(), v.null()),
    currentPeriodEnd: v.union(v.number(), v.null()),
    clerkSubscriptionId: v.union(v.string(), v.null()),
    updatedAt: v.number(),
    /**
     * The provider timestamp of the event that last wrote this row.
     *
     * Svix does not guarantee delivery order, and the webhook returns 500 on a mutation
     * failure to force a retry — which re-queues that delivery behind newer ones. Without
     * this, a delayed upgrade landing after a cancellation rewrites the account back to
     * active and it holds Pro indefinitely with no live subscription. Both directions are
     * terminal: no later event corrects the state.
     */
    lastEventAt: v.union(v.number(), v.null()),
  })
    // One row per user; read on every entitlement check.
    .index("by_user", ["userId"]),

  /** A fantasy league a user has connected or created. */
  leagues: defineTable({
    userId: v.id("users"),
    sport: v.string(),
    /** Provider id, e.g. `manual`, `csv`, `espn`. */
    platform: v.string(),
    /** Identifier within that platform, or null for manually created leagues. */
    externalId: v.union(v.string(), v.null()),
    name: v.string(),
    season: v.number(),
    scoringId: v.string(),
    createdAt: v.number(),
  })
    // Listing a user's leagues, and counting them to enforce the free-tier cap.
    .index("by_user", ["userId"])
    // Idempotent re-import: find an existing league before creating a duplicate.
    .index("by_user_platform_external", ["userId", "platform", "externalId"]),

  /**
   * A roster within a league.
   *
   * Slots are stored as an array rather than as rows because a roster is always read and
   * written whole, and a lineup is meaningless as a partial record.
   */
  rosters: defineTable({
    leagueId: v.id("leagues"),
    userId: v.id("users"),
    name: v.string(),
    slots: v.array(
      v.object({
        slotId: v.string(),
        slotLabel: v.string(),
        eligiblePositions: v.array(v.string()),
        playerId: v.union(v.string(), v.null()),
      }),
    ),
    bench: v.array(v.string()),
    updatedAt: v.number(),
  })
    .index("by_league", ["leagueId"])
    .index("by_user", ["userId"]),

  /**
   * Player identity, keyed by the upstream nflverse id.
   *
   * Small (a few thousand rows) and slow-changing, so it is worth persisting to avoid
   * re-fetching a full season CSV just to render a name.
   */
  players: defineTable({
    externalId: v.string(),
    sport: v.string(),
    name: v.string(),
    position: v.string(),
    team: v.union(v.string(), v.null()),
    updatedAt: v.number(),
  })
    // Resolving a roster's player ids to names and positions.
    .index("by_external_id", ["externalId"])
    // Free-agent and waiver browsing by position.
    .index("by_sport_position", ["sport", "position"]),

  /**
   * Season-long draft valuations.
   *
   * Separate from `projections` because it answers a different question. A projection is
   * for one week and is recomputed as form changes; a draft board is for a whole season
   * and is rebuilt when the market moves. Storing them in one table would mean a weekly
   * refresh silently overwrote draft values, or vice versa.
   *
   * Both components are kept alongside the blend, so the interface can show what the
   * market thinks and what the model thinks rather than only their average. The blend is
   * the recommendation; the disagreement is the interesting part.
   */
  draftBoard: defineTable({
    sport: v.string(),
    season: v.number(),
    scoringId: v.string(),
    /** League size, because ADP is only meaningful against one. */
    teams: v.number(),
    playerId: v.string(),
    name: v.string(),
    position: v.string(),
    team: v.union(v.string(), v.null()),
    /**
     * Our own season projection, or `null` where the model has no opinion — a rookie with
     * no prior games, a kicker, a defense. Stored as null rather than zero so the
     * interface can tell "we project nothing" from "we have nothing to say", which is the
     * distinction the blend itself turns on.
     */
    modelPoints: v.union(v.number(), v.null()),
    /** The market's implied points for this draft slot, or null if it has no opinion. */
    marketPoints: v.union(v.number(), v.null()),
    /** What the board ranks on. */
    blendedPoints: v.number(),
    adp: v.union(v.number(), v.null()),
    adpStdev: v.union(v.number(), v.null()),
    /** The week this player's team is idle. Drives bye-collision cost in the simulation. */
    byeWeek: v.union(v.number(), v.null()),
    /**
     * Probability he is fit in a given week, shrunk from his own games-played history.
     * Drives how much the depth behind him is worth.
     */
    availability: v.number(),
    /** Spread of actual/projected for his position, for weekly variance. */
    p10: v.number(),
    p90: v.number(),
    /**
     * Whether that spread was measured or assumed.
     *
     * Stored rather than inferred, for the same reason `modelPoints` is nullable: a row
     * that cannot say where its numbers came from will eventually be presented as though
     * they were all measured. Kickers and defenses carry `placeholder`, and so does any
     * position `OUTCOME_QUANTILES` has no entry for.
     *
     * Required, like the four fields beside it — and a required field on a populated table
     * is rejected by Convex outright, so adding it breaks the next push until the table is
     * cleared. That is the correct trade here and not a hazard to route around, because
     * every row in this table is derived: `upsertBoardBatch` is the only writer, the cron
     * rebuilds every board twice daily through the preseason, and `pruneBoard` deletes from
     * it as a matter of course. Nothing in it is worth preserving across a schema change.
     *
     * Optional was tried and reverted, and the reverting argument was wrong in a way worth
     * recording, because it has now been tested. It claimed the push would fail on
     * `byeWeek` first — those four having been added as required fields in e82a9f4 — so
     * softening one field of five would achieve nothing. It does not fail on `byeWeek`. A
     * board built between e82a9f4 and this commit carries all four and lacks only this one,
     * which is exactly the state a configured dev deployment was found in on 2026-08-05:
     *
     *     Object is missing the required field `quantileProvenance`
     *     Object: {adp: 136.6, ..., byeWeek: 8.0, p10: 0.171, p90: 1.772, ...}
     *
     * So the choice stands but its justification does not. Clearing the table is the
     * operation this field costs, it costs it once per environment, and README records it
     * beside the seeding command rather than leaving it to be rediscovered from a failed
     * deploy.
     */
    quantileProvenance: v.union(v.literal("measured"), v.literal("placeholder")),
    computedAt: v.number(),
  })
    .index("by_board", ["sport", "season", "scoringId", "teams"])
    // Selects one run. Without it every run-scoped read — serving the published board,
    // and pruning the stale ones — has to scan the whole league shape and discard the
    // rest, and that discarded set grows with the number of failed rebuilds rather than
    // with the size of a board.
    .index("by_board_run", ["sport", "season", "scoringId", "teams", "computedAt"])
    .index("by_board_player", ["sport", "season", "scoringId", "teams", "playerId"]),


  /**
   * The run whose rows are currently the board, per league shape.
   *
   * `draftBoard` is written batch by batch, so mid-rebuild the table holds a mix of the
   * run in progress and the one before it. If a batch fails partway the job is marked
   * failed and the mixed state simply stays there, and every reader was served that
   * mixture with nothing to indicate it — part this week's prices, part last week's, and
   * a freshness line confidently reporting one of them.
   *
   * A run publishes itself here only after every batch has landed. Readers serve the rows
   * carrying `publishedAt` and ignore everything else, so a failed run is invisible rather
   * than half-visible, and the previous board survives intact until a replacement is
   * complete.
   */
  draftBoardRuns: defineTable({
    sport: v.string(),
    season: v.number(),
    scoringId: v.string(),
    teams: v.number(),
    /** `computedAt` of the last run that finished writing every batch. */
    publishedAt: v.number(),
  }).index("by_board", ["sport", "season", "scoringId", "teams"]),
  /**
   * Model output. The product's primary read.
   *
   * `contributions` is stored alongside the number because the explanation is a feature,
   * not a debugging aid, and recomputing it on read would require the full history.
   */
  projections: defineTable({
    sport: v.string(),
    season: v.number(),
    week: v.number(),
    playerId: v.string(),
    position: v.string(),
    scoringId: v.string(),
    /**
     * The player's team and that week's opponent.
     *
     * Both are non-nullable, and that is the point. A projection only exists for a player
     * whose team actually plays that week — a player on a bye will score zero, so ingest
     * skips them. Making these required means a bye-week row cannot be written at all,
     * rather than relying on every caller to remember to check.
     */
    team: v.string(),
    opponent: v.string(),
    mean: v.number(),
    floor: v.number(),
    ceiling: v.number(),
    contributions: v.array(
      v.object({
        key: v.string(),
        label: v.string(),
        points: v.number(),
        detail: v.string(),
      }),
    ),
    modelVersion: v.string(),
    computedAt: v.number(),
  })
    // The main board: every projection for a week under one ruleset, ranked.
    .index("by_week_scoring", ["sport", "season", "week", "scoringId"])
    // A single player's projection, and idempotent upsert on re-run.
    .index("by_player_week_scoring", ["playerId", "season", "week", "scoringId"]),

  /** Schedule and market lines for a week, used for game context and the Vegas term. */
  contests: defineTable({
    sport: v.string(),
    externalId: v.string(),
    season: v.number(),
    week: v.number(),
    homeTeam: v.string(),
    awayTeam: v.string(),
    startsAt: v.union(v.string(), v.null()),
    spread: v.union(v.number(), v.null()),
    total: v.union(v.number(), v.null()),
    homeScore: v.union(v.number(), v.null()),
    awayScore: v.union(v.number(), v.null()),
    updatedAt: v.number(),
  })
    .index("by_sport_season_week", ["sport", "season", "week"])
    .index("by_external_id", ["externalId"]),

  /**
   * Ingest and projection job records.
   *
   * Upstream is a large CSV that cannot be processed inside one Convex transaction, so
   * work is chunked and progress recorded here to make a run resumable and observable.
   */
  jobs: defineTable({
    kind: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    detail: v.string(),
    processed: v.number(),
    total: v.number(),
    error: v.union(v.string(), v.null()),
    startedAt: v.number(),
    finishedAt: v.union(v.number(), v.null()),
  })
    // Latest run of a kind, for the admin view and for listing a kind's runs newest-first.
    .index("by_kind_started", ["kind", "startedAt"]),

  /**
   * Append-only audit trail for billing and administrative actions.
   *
   * Retained because entitlement changes affect what a paying customer can do, and
   * "why did this account lose access" must be answerable after the fact.
   */
  audit: defineTable({
    kind: v.string(),
    userId: v.union(v.id("users"), v.null()),
    detail: v.string(),
    at: v.number(),
  })
    .index("by_kind_at", ["kind", "at"])
    .index("by_user_at", ["userId", "at"]),
});
