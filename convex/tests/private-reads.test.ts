import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import { READ_LIMITS } from "../lib/readBounds";
import schema from "../schema";

const modules = import.meta.glob(["../**/*.ts", "../**/*.js", "!../**/*.d.ts", "!../**/*.test.ts", "!../tests/**"]);
const week = { season: 2026, week: 1, scoringId: "ppr" };
const board = { season: 2026, scoringId: "ppr", teams: 12 };

async function account() {
  const t = convexTest(schema, modules).withIdentity({ subject: "private-reader" });
  await t.mutation(api.users.ensure, {});
  return t;
}

function projection(playerId: string, mean = 12) {
  return { ...week, playerId, position: "WR", team: "KC", opponent: "SF", mean, floor: 0, ceiling: 20, contributions: [], modelVersion: "test" };
}

describe("private bounded data reads", () => {
  it("rejects all eleven public data queries without an account, including empty data", async () => {
    const t = convexTest(schema, modules);
    const requests = [
      () => t.query(api.projections.forWeek, week),
      () => t.query(api.projections.forPlayer, { ...week, playerId: "a" }),
      () => t.query(api.projections.forPlayers, { ...week, playerIds: [] }),
      () => t.query(api.projections.playersByIds, { externalIds: [] }),
      () => t.query(api.projections.playersByPosition, { position: "WR" }),
      () => t.query(api.draft.board, board),
      () => t.query(api.draft.boardFreshness, board),
      () => t.query(api.draft.catalogFreshness, { season: 2026 }),
      () => t.query(api.contests.forWeek, { season: 2026, week: 1 }),
      () => t.query(api.contests.forSeason, { season: 2026 }),
      () => t.query(api.season.current, {}),
    ];
    for (const request of requests) await expect(request()).rejects.toThrow("signed in");
    await expect(t.withIdentity({ subject: "unprovisioned" }).query(api.draft.board, board)).rejects.toThrow("signed in");
    // Authentication precedes argument-level work, not just the database read.
    await expect(t.query(api.projections.forWeek, { ...week, limit: -1 })).rejects.toThrow("signed in");
  });

  it("preserves free-account reads, deduplicates IDs and returns complete pools larger than 300", async () => {
    const t = await account();
    await t.mutation(internal.projections.upsertBatch, {
      computedAt: 1, rows: Array.from({ length: 468 }, (_, i) => projection(`p${i}`, i)),
    });
    await t.mutation(internal.projections.upsertPlayers, { players: [{ externalId: "p0", name: "Player", position: "WR", team: "KC" }] });
    expect(await t.query(api.projections.forWeek, week)).toHaveLength(468);
    expect((await t.query(api.projections.forWeek, { ...week, limit: 1 }))[0].playerId).toBe("p467");
    expect(await t.query(api.projections.forPlayers, { ...week, playerIds: ["p0", "p0", "absent"] })).toHaveLength(1);
    expect(await t.query(api.projections.playersByIds, { externalIds: ["p0", "p0", "absent"] })).toHaveLength(1);
    expect(await t.query(api.projections.playersByIds, { externalIds: Array.from({ length: 468 }, (_, i) => `p${i}`) })).toHaveLength(1);
  });

  it("rejects oversized raw arrays before deduplication and bounds primitive arguments", async () => {
    const t = await account();
    const oversized = Array.from({ length: READ_LIMITS.playerIds + 1 }, () => "same");
    await expect(t.query(api.projections.forPlayers, { ...week, playerIds: oversized })).rejects.toThrow("At most");
    await expect(t.query(api.projections.playersByIds, { externalIds: oversized })).rejects.toThrow("At most");
    await expect(t.query(api.projections.playersByIds, { externalIds: ["x".repeat(129)] })).rejects.toThrow("Player ID");
    for (const limit of [-1, 0, 1.5, Infinity, READ_LIMITS.positionPlayers + 1]) {
      await expect(t.query(api.projections.playersByPosition, { position: "WR", limit })).rejects.toThrow();
    }
    await expect(t.query(api.projections.forWeek, { ...week, scoringId: "x".repeat(8193) })).rejects.toThrow("Scoring ID");
    await expect(t.query(api.projections.forWeek, { ...week, position: "unknown" })).rejects.toThrow("Position");
    await expect(t.query(api.contests.forWeek, { season: 2026, week: 19 })).rejects.toThrow("Week");
    await expect(t.query(api.contests.forSeason, { season: 2026.5 })).rejects.toThrow("Season");
    await expect(t.query(api.draft.boardFreshness, { ...board, teams: 1 })).rejects.toThrow("Team count");
    expect(await t.query(api.draft.board, { ...board, teams: 2 })).toEqual([]);
    expect(await t.query(api.draft.board, { ...board, teams: 32 })).toEqual([]);
  });

  it("refuses an oversized whole projection pool even when a caller asks for one top player", async () => {
    const t = await account();
    await t.mutation(internal.projections.upsertBatch, {
      computedAt: 1, rows: Array.from({ length: READ_LIMITS.projections + 1 }, (_, i) => projection(`p${i}`)),
    });
    await expect(t.query(api.projections.forWeek, { ...week, limit: 1 })).rejects.toThrow("No partial result");
  });

  it("preserves the identity-free internal season resolver for scheduled ingestion", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(internal.season.currentInternal, {})).toBeNull();
    const signed = await account();
    expect(await signed.query(api.season.current, {})).toEqual(await signed.query(internal.season.currentInternal, {}));
  });

  it("refuses oversized schedule ranges and metadata, including internal season resolution", async () => {
    const t = await account();
    const thisYear = new Date().getUTCFullYear();
    await t.run(async ctx => {
      for (let i = 0; i <= READ_LIMITS.seasonContests; i++) await ctx.db.insert("contests", {
        sport: "nfl", externalId: `game-${i}`, season: thisYear, week: 1,
        homeTeam: "KC", awayTeam: "SF", startsAt: null, spread: null, total: null,
        homeScore: null, awayScore: null, updatedAt: 0,
      });
      for (let i = 0; i <= READ_LIMITS.publishedRuns; i++) await ctx.db.insert("draftBoardRuns", {
        sport: "nfl", ...board, publishedAt: i,
      });
    });
    await expect(t.query(api.contests.forWeek, { season: thisYear, week: 1 })).rejects.toThrow("No partial result");
    await expect(t.query(api.contests.forSeason, { season: thisYear })).rejects.toThrow("No partial result");
    await expect(t.query(internal.season.currentInternal, {})).rejects.toThrow("No partial result");
    await expect(t.query(api.draft.board, board)).rejects.toThrow("No partial result");
  });

  it("refuses an oversized draft catalog instead of losing unpriced late-round identities", async () => {
    const t = await account();
    await t.run(async ctx => {
      await ctx.db.insert("draftBoardRuns", { sport: "nfl", ...board, publishedAt: 1 });
      await ctx.db.insert("draftPlayerCatalogRuns", {
        sport: "nfl", season: 2026, publishedAt: 1, checkedAt: 1,
        fingerprint: "test", playerCount: READ_LIMITS.catalogRows + 1, activeCount: READ_LIMITS.catalogRows + 1, unknownStatuses: [],
      });
      for (let i = 0; i <= READ_LIMITS.catalogRows; i++) await ctx.db.insert("draftPlayerCatalog", {
        sport: "nfl", season: 2026, playerId: `p${i}`, name: `Player ${i}`, position: "WR", team: "KC",
        byeWeek: null, rosterStatus: "active", rosterStatusCode: "ACT", computedAt: 1,
      });
    });
    await expect(t.query(api.draft.board, board)).rejects.toThrow("Draft identity pool exceeds");
  });
});
