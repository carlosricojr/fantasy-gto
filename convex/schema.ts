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
    // Latest run of a kind, for the admin view and to avoid concurrent duplicates.
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
