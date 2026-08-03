import { getFunctionName } from "convex/server";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { runBuildDraftBoard } from "../ingest";
import { AdpProvider } from "../../lib/sources/adp";
import {
  NflverseProvider,
  schedulesUrl,
  seasonRosterUrl,
  weeklyStatsUrl,
} from "../../lib/sources/nflverse";

/**
 * Building a draft board.
 *
 * `runBuildDraftBoard` had no test of any kind, which is how three separate rounds of the
 * same defect reached it: the roster join, the curve fit, and the sample dedupe were each
 * fixed on the backtest side first and on this side only after review noticed the lag. The
 * backtest is not a substitute — it is a different script over cached files, and nothing
 * connected the two.
 *
 * The case pinned here is the one that survived longest: two market rows resolving to one
 * roster player. The ADP feed publishes "A.J. Brown" and "AJ Brown" as separate entries;
 * `normalizeName` collapses both onto the same player, and counting him twice weights his
 * (adp, actual points) pair twice in the least-squares fit that prices *every* player at
 * his position.
 */

const SEASON = 2026;
const TEAM = "PHI";
const OPPONENT = "DAL";

/** Enough of a schedule that the season resolves and byes can be computed. */
function gamesCsv(): string {
  const header = [
    "game_id", "season", "game_type", "week", "gameday", "gametime",
    "away_team", "away_score", "home_team", "home_score",
    "spread_line", "total_line",
  ];
  const rows: string[][] = [];
  for (const season of [SEASON - 2, SEASON - 1]) {
    for (let week = 1; week <= 17; week += 1) {
      rows.push([
        `${season}_${week}_${OPPONENT}_${TEAM}`, String(season), "REG", String(week),
        `${season}-09-10`, "13:00", OPPONENT, "20", TEAM, "24", "-3.0", "45.0",
      ]);
    }
  }
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

/** Season roster: the players the board can contain at all. */
function rosterCsv(): string {
  const header = [
    "season", "team", "position", "status", "full_name", "gsis_id",
  ];
  const rows = [
    [String(SEASON), TEAM, "WR", "ACT", "A.J. Brown", "00-0100001"],
    [String(SEASON), TEAM, "WR", "ACT", "Devonta Smith", "00-0100002"],
    [String(SEASON), TEAM, "RB", "ACT", "Saquon Barkley", "00-0100003"],
  ];
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

/** Prior-season production, so every player has history and a model value. */
function statsCsv(season: number): string {
  const header = [
    "player_id", "player_name", "player_display_name", "position", "season", "week",
    "season_type", "team", "opponent_team",
    "receptions", "targets", "receiving_yards", "receiving_tds",
    "carries", "rushing_yards", "rushing_tds",
  ];
  const players: Array<[string, string, string]> = [
    ["00-0100001", "A.J. Brown", "WR"],
    ["00-0100002", "Devonta Smith", "WR"],
    ["00-0100003", "Saquon Barkley", "RB"],
  ];
  const rows: string[][] = [];
  for (const [id, name, position] of players) {
    for (let week = 1; week <= 16; week += 1) {
      rows.push([
        id, name, name, position, String(season), String(week), "REG", TEAM, OPPONENT,
        "6", "9", "85", "1", "1", "5", "0",
      ]);
    }
  }
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function nflverse(): NflverseProvider {
  const games = gamesCsv();
  const roster = rosterCsv();
  return new NflverseProvider(async (url) => {
    if (url === schedulesUrl()) return games;
    if (url === seasonRosterUrl(SEASON)) return roster;
    for (const season of [SEASON - 1, SEASON - 2]) {
      if (url === weeklyStatsUrl(season)) return statsCsv(season);
    }
    throw new Error(`${url} responded 404`);
  });
}

/** An ADP feed whose rows are supplied by the caller, so duplicates can be injected. */
function adp(rows: Array<Record<string, unknown>>): AdpProvider {
  return new AdpProvider(async () => JSON.stringify({ status: "Success", players: rows }));
}

const market = (name: string, position: string, adpValue: number) => ({
  name,
  position,
  team: TEAM,
  adp: adpValue,
  stdev: 4,
  bye: 9,
  times_drafted: 100,
});

interface Recorded {
  fn: string;
  args: Record<string, unknown>;
}

/** Records mutations instead of performing them, like the projection tests do. */
function recordingCtx() {
  const calls: Recorded[] = [];
  const ctx = {
    runMutation: async (
      ref: FunctionReference<"mutation", "internal">,
      args: Record<string, unknown>,
    ) => {
      calls.push({ fn: getFunctionName(ref), args });
      // `pruneBoard` is drained in a loop until it reports no more.
      return getFunctionName(ref) === "draft:pruneBoard"
        ? { deleted: 0, more: false }
        : "job_1";
    },
  } as unknown as Parameters<typeof runBuildDraftBoard>[0];
  return { ctx, calls };
}

interface BoardRow {
  playerId: string;
  name: string;
  blendedPoints: number;
  marketPoints: number | null;
  quantileProvenance: string;
}

const boardRows = (calls: Recorded[]): BoardRow[] =>
  calls
    .filter((c) => c.fn === "draft:upsertBoardBatch")
    .flatMap((c) => c.args.rows as BoardRow[]);

async function build(adpRows: Array<Record<string, unknown>>) {
  const { ctx, calls } = recordingCtx();
  const result = await runBuildDraftBoard(
    ctx,
    { season: SEASON, scoringId: "ppr", teams: 12 },
    nflverse(),
    adp(adpRows),
  );
  return { result, calls, rows: boardRows(calls) };
}

const ONE_ROW_EACH = [
  market("A.J. Brown", "WR", 12),
  market("Devonta Smith", "WR", 30),
  market("Saquon Barkley", "RB", 5),
];

describe("runBuildDraftBoard", () => {
  it("builds a board with a price for every rostered player", async () => {
    const { result, rows } = await build(ONE_ROW_EACH);
    expect(result.players).toBe(3);
    expect(rows.map((r) => r.playerId).sort()).toEqual([
      "00-0100001",
      "00-0100002",
      "00-0100003",
    ]);
    for (const row of rows) expect(row.marketPoints).not.toBeNull();
  });

  it("publishes the run only after every batch, then prunes", async () => {
    // The ordering the partial-board fix is about: a reader must never see a half-written
    // board, so publish comes after the last write and prune after publish.
    const { calls } = await build(ONE_ROW_EACH);
    const order = calls
      .map((c) => c.fn)
      .filter((f) =>
        ["draft:upsertBoardBatch", "draft:publishBoard", "draft:pruneBoard"].includes(f),
      );
    expect(order.at(-2)).toBe("draft:publishBoard");
    expect(order.at(-1)).toBe("draft:pruneBoard");
    expect(order.indexOf("draft:publishBoard")).toBeGreaterThan(
      order.lastIndexOf("draft:upsertBoardBatch"),
    );
  });

  it("never gives a duplicated market row a wrong price, and leaves the rest alone", async () => {
    // "A.J. Brown" and "AJ Brown" normalise to one key, and `buildMarketIndex` cannot tell
    // one player published twice from two players who share a name. It refuses the key
    // rather than guessing, which is the documented choice — so the duplicated player
    // loses his market price and falls back to the model alone.
    //
    // That is a real cost and it is the conservative one: a missing price is visible on the
    // board, a wrong price is not. What must hold is that he never receives a *different*
    // market price, and that nobody else is touched — the fit that prices every other
    // receiver must not move because one feed row was published twice.
    const single = await build(ONE_ROW_EACH);
    const duplicated = await build([
      market("A.J. Brown", "WR", 12),
      market("AJ Brown", "WR", 12),
      market("Devonta Smith", "WR", 30),
      market("Saquon Barkley", "RB", 5),
    ]);

    expect(duplicated.result.players).toBe(single.result.players);

    const rowFor = (rows: BoardRow[], id: string) => rows.find((r) => r.playerId === id)!;
    const duplicatedPlayer = "00-0100001";

    // Either his price survives unchanged, or he has none. Never a third value.
    const before = rowFor(single.rows, duplicatedPlayer);
    const after = rowFor(duplicated.rows, duplicatedPlayer);
    expect(
      after.marketPoints === null || after.marketPoints === before.marketPoints,
    ).toBe(true);

    // And everyone else is identical, price and blend alike.
    for (const id of ["00-0100002", "00-0100003"]) {
      expect(rowFor(duplicated.rows, id).marketPoints).toBe(
        rowFor(single.rows, id).marketPoints,
      );
      expect(rowFor(duplicated.rows, id).blendedPoints).toBeCloseTo(
        rowFor(single.rows, id).blendedPoints,
        6,
      );
    }
  });

  it("records where each player's weekly spread came from", async () => {
    // Every row must say whether its band was measured or assumed, so nothing can present
    // an assumed range as evidence later.
    const { rows } = await build(ONE_ROW_EACH);
    for (const row of rows) {
      expect(["measured", "placeholder"]).toContain(row.quantileProvenance);
    }
  });

  it("throws rather than returning normally when it cannot build a board", async () => {
    // The cron counts a normal return as a rebuild, so every unbuildable state has to
    // throw. With no market row matching any rostered player the curve fit fails first —
    // which is the earlier of the two guards, and equally must not return quietly.
    await expect(build([market("Nobody At All", "WR", 12)])).rejects.toThrow(
      /Could not fit a market curve/,
    );
  });
});
