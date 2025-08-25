import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    email: v.string(),
    planDisplay: v.string(),
    createdAt: v.number(),
  }).index("byClerk", ["clerkUserId"]),

  entitlements: defineTable({
    userId: v.id("users"),
    key: v.string(),
    value: v.optional(v.any()),
    active: v.boolean(),
    source: v.literal("clerk"),
    updatedAt: v.number(),
  }).index("byUserKey", ["userId", "key"]),

  leagues: defineTable({
    platform: v.union(v.literal("ESPN"), v.literal("SLEEPER"), v.literal("YAHOO")),
    name: v.string(),
    season: v.number(),
    scoring: v.any(),
    rules: v.any(),
  }).index("byPlatformSeason", ["platform", "season"]),

  teams: defineTable({
    leagueId: v.id("leagues"),
    externalId: v.string(),
    name: v.string(),
    manager: v.string(),
  }).index("byLeague", ["leagueId"]),

  players: defineTable({
    extId: v.string(),
    name: v.string(),
    pos: v.string(),
    team: v.string(),
    crosswalk: v.any(),
  }).index("byExtId", ["extId"]),

  weeklyStats: defineTable({
    season: v.number(),
    week: v.number(),
    playerId: v.id("players"),
    raw: v.any(),
  }).index("byPlayerWeek", ["playerId", "season", "week"]),

  features: defineTable({
    season: v.number(),
    week: v.number(),
    playerId: v.id("players"),
    usage: v.any(),
    context: v.any(),
    ema: v.any(),
  }).index("byPlayerWeek", ["playerId", "season", "week"]),

  projections: defineTable({
    season: v.number(),
    week: v.number(),
    playerId: v.id("players"),
    pos: v.string(),
    mean: v.number(),
    floor: v.number(),
    ceiling: v.number(),
    contributions: v.any(),
    sourceVersion: v.string(),
  }).index("byPlayerWeek", ["playerId", "season", "week"]),

  recommendations: defineTable({
    leagueId: v.id("leagues"),
    week: v.number(),
    type: v.union(v.literal("STARTSIT"), v.literal("WAIVER"), v.literal("DST")),
    payload: v.any(),
  }).index("byLeagueWeek", ["leagueId", "week"]),

  jobs: defineTable({
    type: v.string(),
    status: v.string(),
    progress: v.number(),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    costUnits: v.optional(v.number()),
  }).index("byTypeStatus", ["type", "status"]),

  alerts: defineTable({
    leagueId: v.id("leagues"),
    priority: v.number(),
    kind: v.string(),
    message: v.string(),
    read: v.boolean(),
  }).index("byLeague", ["leagueId"]),

  audit: defineTable({
    kind: v.string(),
    actorUserId: v.optional(v.id("users")),
    payload: v.any(),
    ts: v.number(),
  }).index("byKindTs", ["kind", "ts"]),

  userPerformance: defineTable({
    userId: v.id("users"),
    season: v.number(),
    week: v.number(),
    leagueId: v.id("leagues"),
    wins: v.number(),
    losses: v.number(),
    pointsFor: v.number(),
    pointsAgainst: v.number(),
    benchPoints: v.number(),
    winProbabilityHistory: v.array(v.number()),
  }).index("byUserWeek", ["userId", "season", "week"]),

  projectionAccuracy: defineTable({
    season: v.number(),
    week: v.number(),
    playerId: v.id("players"),
    platformBaseline: v.union(v.literal("ESPN"), v.literal("YAHOO")),
    gtoProjection: v.number(),
    baselineProjection: v.number(),
    actual: v.number(),
    absError: v.number(),
    maeByPosition: v.any(),
  }).index("byPlayerWeek", ["playerId", "season", "week"]),

  providerCache: defineTable({
    key: v.string(),
    value: v.string(),
    provider: v.string(),
    ttlSeconds: v.number(),
    storedAt: v.number(),
  }).index("byKey", ["key"]),
});
