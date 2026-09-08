import { getFunctionName } from "convex/server";
import { describe, expect, it } from "vitest";

import { runBuildSleeperCustomDraftBoard } from "../ingest";
import { type SleeperHistoricalWeek, SleeperStatsProvider } from "../../lib/sources/sleeper-stats";
import { AdpProvider, type AdpEntry } from "../../lib/sources/adp";
import { NflverseProvider } from "../../lib/sources/nflverse";

const SEASON = 2026;
const scoringId = 'sleeper-v1:{"fgm_20_29":3,"pass_yd":0.04,"rec":1,"rec_yd":0.1,"rush_yd":0.1,"sack":1}';
const teams = Array.from({ length: 32 }, (_, index) => `T${String(index).padStart(2, "0")}`);
const positions = ["QB", "RB", "WR", "TE", "K"] as const;

function stats(position: string, multiplier: number) {
  if (position === "QB") return { gp: 1, pass_yd: 100 * multiplier };
  if (position === "RB") return { gp: 1, rush_yd: 40 * multiplier };
  if (position === "WR" || position === "TE") return { gp: 1, rec: multiplier, rec_yd: 30 * multiplier };
  if (position === "K") return { gp: 1, fgm: multiplier, fgm_20_29: multiplier, fgm_0_19: 0, fgm_30_39: 0, fgm_40_49: 0, fgm_50_59: 0, fgm_60p: 0 };
  return { gp: 1, sack: multiplier };
}

const roster = [
  ...positions.flatMap((position) =>
    Array.from({ length: 8 }, (_, index) => ({
      playerId: `${position}-${index}`,
      sleeperId: `${position}-${index}`,
      name: `${position} Player ${index}`,
      position,
      team: teams[index],
    })),
  ),
  // Current and recordable, but absent from market ADP. The custom path must preserve the
  // absence as `null`, not turn it into the legacy blend's numeric zero.
  { playerId: "QB-unpriced", sleeperId: "QB-unpriced", name: "QB Unpriced", position: "QB", team: teams[9] },
];

const history: SleeperHistoricalWeek[] = [
  ...positions.flatMap((position, positionIndex) =>
    Array.from({ length: 8 }, (_, index) => [1, 2].map((week) => ({
      playerId: `${position}-${index}`,
      name: `${position} Player ${index}`,
      position,
      team: teams[index],
      season: SEASON - 1,
      week,
      stats: stats(position, index + week + positionIndex),
    }))).flat(),
  ),
  ...teams.flatMap((team, index) => [1, 2].map((week) => ({
    playerId: team,
    name: `${team} D/ST`,
    position: "DEF",
    team,
    season: SEASON - 1,
    week,
    stats: stats("DST", index + week),
  }))),
];

const adp: AdpEntry[] = [
  ...roster.filter((player) => player.playerId !== "QB-unpriced").map((player, index) => ({
    name: player.name, position: player.position, team: player.team,
    adp: index + 1, stdev: 4, timesDrafted: 20, bye: 9,
  })),
  ...teams.map((team, index) => ({
    name: `${team} D/ST`, position: "DEF", team,
    adp: 100 + index, stdev: 8, timesDrafted: 20, bye: 9,
  })),
];

function contests() {
  return Array.from({ length: 18 }, (_, weekIndex) => {
    const week = weekIndex + 1;
    const sitting = week <= 16 ? new Set([teams[(week - 1) * 2], teams[(week - 1) * 2 + 1]]) : new Set<string>();
    const playing = teams.filter((team) => !sitting.has(team));
    return Array.from({ length: playing.length / 2 }, (_, index) => ({
      id: `${week}-${index}`,
      period: { season: SEASON, index: week },
      homeTeam: playing[index * 2],
      awayTeam: playing[index * 2 + 1],
      startsAt: null,
      result: null,
    }));
  }).flat();
}

describe("custom Sleeper board build", () => {
  it("writes canonical all-32 D/ST rows and custom history provenance without preset values", async () => {
    const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = {
      runMutation: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        writes.push({ name, args });
        if (name.endsWith("jobs:start")) return "job";
        if (name.endsWith("draft:pruneBoard")) return { more: false };
        return { written: 0 };
      },
    };
    const rosterProvider = {
      seasonRoster: async () => ({ ok: true as const, data: roster }),
      allContests: async () => ({ ok: true as const, data: contests() }),
    } as unknown as NflverseProvider;
    const statsProvider = {
      seasonWeeks: async (year: number) => ({ ok: true as const, data: year === SEASON - 1 ? history : [] }),
    } as unknown as SleeperStatsProvider;
    const adpProvider = {
      forSeason: async () => ({ ok: true as const, data: adp }),
    } as unknown as AdpProvider;

    const result = await runBuildSleeperCustomDraftBoard(
      ctx as never,
      { season: SEASON, scoringId, teams: 12 },
      rosterProvider,
      adpProvider,
      statsProvider,
    );
    expect(result).toMatchObject({ players: 73, unpriced: 1, historySeasons: [2024, 2025] });
    const rows = writes.filter((write) => write.name.endsWith("draft:upsertBoardBatch"))
      .flatMap((write) => write.args.rows as Array<Record<string, unknown>>);
    const defenses = rows.filter((row) => row.position === "DST");
    expect(defenses).toHaveLength(32);
    expect(defenses.every((row) => /^dst-T\d\d$/.test(String(row.playerId)))).toBe(true);
    expect(defenses.every((row) => row.historicalScoringSource === "sleeper-custom-stats")).toBe(true);
    expect(defenses.every((row) => typeof row.weeklyStdDev === "number" && row.weeklyStdDev > 0)).toBe(true);
    expect(defenses.every((row) => row.availability === 1)).toBe(true);
    const customSkills = rows.filter((row) => ["QB", "RB", "WR", "TE"].includes(String(row.position)));
    expect(customSkills).not.toHaveLength(0);
    expect(customSkills.every((row) => {
      const ratios = row.weeklyOutcomeRatios;
      return Array.isArray(ratios) &&
        ratios.length === 100 &&
        ratios.every((value) => typeof value === "number" && Number.isFinite(value)) &&
        Math.abs(ratios.reduce((sum, value) => sum + Number(value), 0) / ratios.length - 1) < 1e-9;
    })).toBe(true);
    expect(defenses.every((row) => row.weeklyOutcomeRatios === undefined)).toBe(true);
    expect(rows.every((row) => row.modelPoints === null)).toBe(true);
    expect(rows.find((row) => row.playerId === "QB-unpriced")).toMatchObject({
      marketPoints: null,
      blendedPoints: null,
    });
    expect(writes.find((write) => write.name.endsWith("draft:publishBoard"))?.args).toMatchObject({
      historicalScoringSource: "sleeper-custom-stats",
      historicalSeasons: [2024, 2025],
    });
  });
});
