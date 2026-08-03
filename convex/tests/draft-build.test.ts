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

/**
 * The player set.
 *
 * Twelve at each modelled position, because `fitAdpCurves` needs `MIN_CURVE_SAMPLES` (8)
 * before it will fit a curve for one — below that everything collapses to the pooled fit
 * and a change to one position's samples cannot be observed. An earlier version of this
 * file used three players total and could not see the difference it was written to test.
 */
const POSITIONS = ["WR", "RB", "TE", "QB"] as const;

/**
 * Twelve at most positions, seven at running back.
 *
 * Seven is one short of `MIN_CURVE_SAMPLES`, so the running-back curve exists only if the
 * same-named running back below is also sampled. That turns "one sample was silently
 * dropped" — normally a small wobble in a fitted slope — into the position losing its
 * curve entirely and falling back to the pooled one, which is a difference no rounding can
 * hide.
 */
const PER_POSITION: Record<string, number> = { WR: 12, RB: 7, TE: 12, QB: 12 };

interface Fixture {
  id: string;
  name: string;
  position: string;
  /** Receptions per game, which drives season points through the real scorer. */
  volume: number;
  adp: number;
}

const PLAYERS: Fixture[] = POSITIONS.flatMap((position, p) =>
  Array.from({ length: PER_POSITION[position] }, (_, i) => ({
    id: `00-01${String(p)}${String(i).padStart(2, "0")}`,
    name: `${position} Player${i}`,
    position,
    // Production falls as ADP rises, which is the relationship the curve fits.
    volume: 9 - i * 0.6,
    adp: 4 + p * 3 + i * 9,
  })),
);

/**
 * The outlier the duplicate test leans on.
 *
 * Early ADP and almost no production, so he sits far off the trend for his position and
 * carries real leverage in a least-squares fit. Counted twice, he visibly drags the WR
 * curve; counted once, he does not.
 */
const OUTLIER: Fixture = {
  id: "00-019999",
  name: "A.J. Brown",
  position: "WR",
  volume: 0.4,
  adp: 2,
};

/**
 * Two different players who share a name.
 *
 * Real and common enough that `buildMarketIndex` exists to handle it: `normalizeName`
 * collapses them onto one string, and only the position tells them apart. The curve-fit
 * dedupe has to key on name *and* position for the same reason — keyed on the raw name
 * alone it treats the second as a repeat of the first and drops a real sample.
 *
 * The running back is listed second, so he is the one a name-only key discards.
 */
const SAME_NAME: Fixture[] = [
  { id: "00-018001", name: "Chris Jones", position: "WR", volume: 5.2, adp: 47 },
  { id: "00-018002", name: "Chris Jones", position: "RB", volume: 5.8, adp: 52 },
];

const ALL: Fixture[] = [...PLAYERS, OUTLIER, ...SAME_NAME];

/** Season roster: the players the board can contain at all. */
function rosterCsv(): string {
  const header = ["season", "team", "position", "status", "full_name", "gsis_id"];
  const rows = ALL.map((f) => [String(SEASON), TEAM, f.position, "ACT", f.name, f.id]);
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
  const rows: string[][] = [];
  for (const f of ALL) {
    for (let week = 1; week <= 16; week += 1) {
      const rec = Math.max(0, f.volume).toFixed(0);
      const yards = Math.max(0, f.volume * 12).toFixed(0);
      rows.push([
        f.id, f.name, f.name, f.position, String(season), String(week), "REG",
        TEAM, OPPONENT,
        rec, String(Number(rec) + 2), yards, "0",
        f.position === "RB" ? "8" : "0", f.position === "RB" ? "40" : "0", "0",
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

/** One market row per rostered player — the healthy feed. */
const ONE_ROW_EACH = ALL.map((f) => market(f.name, f.position, f.adp));

describe("runBuildDraftBoard", () => {
  it("builds a board with a price for every rostered player", async () => {
    const { result, rows } = await build(ONE_ROW_EACH);
    expect(result.players).toBe(ALL.length);
    expect(rows.map((r) => r.playerId).sort()).toEqual(ALL.map((f) => f.id).sort());
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

  it("does not let a duplicated market row bend the curve that prices everyone else", async () => {
    // Two feed rows for one player: "A.J. Brown" and "AJ Brown" normalise to one key.
    //
    // Two separate things go wrong without protection, and only one of them is about him.
    // `buildMarketIndex` cannot tell one player published twice from two players sharing a
    // name, so it refuses the key and he loses his market price — the documented
    // conservative choice, and a cost worth stating. The one that reaches *everybody* is
    // the curve: he is an outlier, early ADP against almost no production, so counting his
    // (adp, points) pair twice in the least-squares fit drags the whole WR curve and
    // reprices every receiver on the board.
    //
    // He is deliberately an outlier for that reason. On the trend line a duplicate barely
    // moves the fit and this test would pass with the dedupe deleted.
    const single = await build(ONE_ROW_EACH);
    const duplicated = await build([
      ...ONE_ROW_EACH,
      market("AJ Brown", OUTLIER.position, OUTLIER.adp),
    ]);

    expect(duplicated.result.players).toBe(single.result.players);

    const rowFor = (rows: BoardRow[], id: string) => rows.find((r) => r.playerId === id)!;

    // He himself: his price survives or he has none. Never a third value.
    const before = rowFor(single.rows, OUTLIER.id);
    const after = rowFor(duplicated.rows, OUTLIER.id);
    expect(
      after.marketPoints === null || after.marketPoints === before.marketPoints,
    ).toBe(true);

    // Everyone else: identical, price and blend alike. This is the assertion the dedupe
    // exists for — the duplicate must not reach the fit that prices the rest of the board.
    for (const other of PLAYERS) {
      expect(rowFor(duplicated.rows, other.id).marketPoints).toBeCloseTo(
        rowFor(single.rows, other.id).marketPoints ?? Number.NaN,
        6,
      );
      expect(rowFor(duplicated.rows, other.id).blendedPoints).toBeCloseTo(
        rowFor(single.rows, other.id).blendedPoints,
        6,
      );
    }
  });

  it("keeps both of two different players who share a name in the curve samples", async () => {
    // `Chris Jones` is a wide receiver and a running back, and `normalizeName` gives them
    // one key. The dedupe that stops a repeated feed row being counted twice must not also
    // discard the second of two genuinely different players — keyed on the raw name it
    // does exactly that, because both roster entries carry the same `name` string.
    //
    // Running back has seven other players, one short of `MIN_CURVE_SAMPLES`. So whether
    // this back reaches the samples decides whether the position gets a curve at all or
    // falls back to the pooled fit. Comparing a board built with him against one built
    // without isolates that: they must differ. Under a name-only key he is discarded in
    // the first build too, and the two boards come out identical.
    const withBoth = await build(ONE_ROW_EACH);
    const withoutBack = await build(
      ONE_ROW_EACH.filter((r) => r.name !== SAME_NAME[1].name || r.position !== "RB"),
    );

    const backPrices = (rows: BoardRow[]) =>
      PLAYERS.filter((f) => f.position === "RB")
        .map((f) => rows.find((r) => r.playerId === f.id)?.marketPoints)
        .filter((v): v is number => typeof v === "number");

    const a = backPrices(withBoth.rows);
    const b = backPrices(withoutBack.rows);
    expect(a).toHaveLength(b.length);
    expect(a.length).toBeGreaterThan(0);

    // Eight samples give the position its own curve; seven do not. The prices must move.
    const moved = a.some((price, i) => Math.abs(price - b[i]) > 1e-6);
    expect(moved).toBe(true);

    // And both same-named players are on the board with a price of their own.
    for (const player of SAME_NAME) {
      const row = withBoth.rows.find((r) => r.playerId === player.id);
      expect(row).toBeDefined();
      expect(row!.marketPoints).not.toBeNull();
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
