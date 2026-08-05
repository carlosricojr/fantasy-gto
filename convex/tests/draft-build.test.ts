import { getFunctionName } from "convex/server";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { runBuildDraftBoard } from "../ingest";
import { AdpProvider } from "../../lib/sources/adp";
import { MODEL_BLEND_WEIGHT } from "../../lib/nfl/draft/config";
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

/**
 * A schedule, served only because the provider can be asked for one.
 *
 * `runBuildDraftBoard` never requests it — the season is a parameter and bye weeks come
 * from the market feed, not the schedule. The previous comment here claimed both, which
 * would have told a maintainer that bye handling was covered when nothing touches it.
 */
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
 * The player set. Counts are in `PER_POSITION` below.
 *
 * Every modeled position except running back carries far more than `MIN_CURVE_SAMPLES`
 * (8), because `fitAdpCurves` needs that many before it will fit a curve for one — below
 * that everything collapses to the pooled fit and a change to one position's samples
 * cannot be observed. An earlier version of this file used three players total and could
 * not see the difference it was written to test.
 */
const POSITIONS = ["WR", "RB", "TE", "QB"] as const;

/**
 * Well clear of `MIN_CURVE_SAMPLES` everywhere except running back, which sits at seven.
 *
 * Seven is one short of `MIN_CURVE_SAMPLES` (8), so the running-back curve exists only if
 * the same-named running back below is also sampled. That turns "one sample was silently
 * dropped" — normally a small wobble in a fitted slope — into the position losing its
 * curve entirely and falling back to the pooled one, which is a difference no rounding can
 * hide.
 */
const PER_POSITION: Record<string, number> = { WR: 45, RB: 7, TE: 40, QB: 25 };

/**
 * Kickers, who exist to exercise the two branches with the most scar tissue.
 *
 * `scoreOffense` scores a kicking line as zero, so `modeled` — not the row count — is what
 * decides they have no model value, and `OUTCOME_QUANTILES` marks their band `placeholder`.
 * Without one on the board the provenance assertion can only ever see `measured` and the
 * `modeled` guard is never taken.
 */
const KICKERS = 3;

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

const KICKER_PLAYERS: Fixture[] = Array.from({ length: KICKERS }, (_, i) => ({
  id: `00-017${String(i).padStart(3, "0")}`,
  name: `K Player${i}`,
  position: "K",
  volume: 0,
  adp: 150 + i * 5,
}));

const ALL: Fixture[] = [...PLAYERS, OUTLIER, ...SAME_NAME, ...KICKER_PLAYERS];

/** Defenses never appear on a roster file; they are synthesized from the market board. */
const DEFENSES = [
  { name: "Philadelphia Eagles", adp: 130 },
  { name: "Dallas Cowboys", adp: 140 },
];

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

/**
 * An ADP feed that answers per season.
 *
 * Season-aware rather than one payload for every request, because the curve must be fitted
 * on a season that has already been played — never on the one being drafted. A fake that
 * ignores the URL cannot tell those apart, and the leakage invariant is then untestable.
 */
function adp(
  rows: Array<Record<string, unknown>>,
  perSeason: Record<number, Array<Record<string, unknown>>> = {},
): AdpProvider {
  return new AdpProvider(async (url) => {
    const season = Number(/year=(\d+)/.exec(url)?.[1] ?? 0);
    const players = perSeason[season] ?? rows;
    return JSON.stringify({ status: "Success", players });
  });
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
  let pruneCalls = 0;
  const ctx = {
    runMutation: async (
      ref: FunctionReference<"mutation", "internal">,
      args: Record<string, unknown>,
    ) => {
      calls.push({ fn: getFunctionName(ref), args });
      // `pruneBoard` reports more work the first time, so the drain loop is exercised
      // rather than assumed. A stub that always says "no more" never runs the loop at all.
      if (getFunctionName(ref) === "draft:pruneBoard") {
        pruneCalls += 1;
        return { deleted: 1, more: pruneCalls < 2 };
      }
      return "job_1";
    },
  } as unknown as Parameters<typeof runBuildDraftBoard>[0];
  return { ctx, calls };
}

interface BoardRow {
  playerId: string;
  name: string;
  position: string;
  modelPoints: number | null;
  blendedPoints: number;
  marketPoints: number | null;
  adp: number | null;
  p10: number;
  p90: number;
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
const ONE_ROW_EACH = [
  ...ALL.map((f) => market(f.name, f.position, f.adp)),
  ...DEFENSES.map((d) => market(d.name, "DEF", d.adp)),
];

describe("runBuildDraftBoard", () => {
  it("counts a defense once when the feed lists it twice", async () => {
    // Defenses bypass `buildMarketIndex` — they are not on a roster file, so there is
    // nothing to join them to — and that is the one join on this path with no
    // collision check. Two rows whose names normalize the same way both become
    // `dst-<same key>`; `upsertBoardBatch` keys on `(board, playerId)`, so the second
    // overwrote the first and the board kept whichever ADP the feed listed last, while
    // the reported `players` figure counted a row the table does not hold.
    //
    // The extra space is not contrived: `normalizeName` collapses whitespace precisely
    // because feeds publish it inconsistently.
    const { result, rows } = await build([
      ...ONE_ROW_EACH,
      market("Philadelphia  Eagles", "DEF", 200),
    ]);
    const eagles = rows.filter((r) => r.playerId === "dst-philadelphiaeagles");
    expect(eagles).toHaveLength(1);
    // First wins, as it does in `buildMarketIndex`, so the duplicate's price is not the
    // one that lands.
    expect(eagles[0].adp).toBe(130);
    // And the count matches the rows, which is the figure the deployment reports.
    expect(result.players).toBe(rows.length);
    expect(result.players).toBe(ALL.length + DEFENSES.length);
  });

  it("builds a board with a price for every rostered player", async () => {
    const { result, rows } = await build(ONE_ROW_EACH);
    // Rostered players plus the defenses, which never appear on a roster file and are
    // synthesized from the market board so a league that starts one can draft one.
    expect(result.players).toBe(ALL.length + DEFENSES.length);
    expect(rows.filter((r) => r.position === "DST")).toHaveLength(DEFENSES.length);
    for (const f of ALL) {
      expect(rows.some((r) => r.playerId === f.id)).toBe(true);
    }
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
    // More than one batch, or the ordering this names cannot be violated: with a single
    // write, publishing "after every batch" and publishing "after the last one" are the
    // same event, and moving the publish inside the loop changes nothing.
    const writes = order.filter((f) => f === "draft:upsertBoardBatch").length;
    expect(writes).toBeGreaterThan(1);

    // Publish strictly after the last write, and prune only after publish.
    expect(order.indexOf("draft:publishBoard")).toBeGreaterThan(
      order.lastIndexOf("draft:upsertBoardBatch"),
    );
    expect(order.indexOf("draft:pruneBoard")).toBeGreaterThan(
      order.indexOf("draft:publishBoard"),
    );
    // And the prune drains rather than running once.
    expect(order.filter((f) => f === "draft:pruneBoard").length).toBeGreaterThan(1);
  });

  it("does not let a duplicated market row bend the curve that prices everyone else", async () => {
    // Two feed rows for one player: "A.J. Brown" and "AJ Brown" normalize to one key.
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

    // And each same-named player carries his *own* market row, not the other's. Asserting
    // only that the price is non-null lets a last-write-wins index through: the receiver
    // silently inherits the back's adp, spread and bye, and both rows still look priced.
    for (const player of SAME_NAME) {
      const row = withBoth.rows.find((r) => r.playerId === player.id);
      expect(row).toBeDefined();
      expect(row!.marketPoints).not.toBeNull();
      expect(row!.adp).toBe(player.adp);
    }
  });

  it("labels an assumed weekly band as assumed, and a measured one as measured", async () => {
    // `expect(["measured","placeholder"]).toContain(x)` restates the union the validator
    // already enforces — it passes for every row and would keep passing if a kicker's
    // assumed band were labeled measured, which is the defect worth catching. The fixture
    // carries kickers and defenses precisely so both labels actually occur.
    const { rows } = await build(ONE_ROW_EACH);

    const skill = rows.filter((r) => ["WR", "RB", "TE", "QB"].includes(r.position));
    const assumed = rows.filter((r) => ["K", "DST"].includes(r.position));
    expect(skill.length).toBeGreaterThan(0);
    expect(assumed.length).toBeGreaterThan(0);

    for (const row of skill) expect(row.quantileProvenance).toBe("measured");
    for (const row of assumed) expect(row.quantileProvenance).toBe("placeholder");
  });

  it("prices a kicker off the market alone, because the model cannot score one", async () => {
    // `scoreOffense` scores a kicking line as zero, so a kicker with plenty of history
    // still has no model opinion. The guard has to key on the position, not the row count —
    // that distinction is why every veteran kicker was once marked down to 80% of his price.
    const { rows } = await build(ONE_ROW_EACH);
    const kickers = rows.filter((r) => r.position === "K");
    expect(kickers.length).toBe(KICKERS);
    for (const kicker of kickers) {
      expect(kicker.modelPoints).toBeNull();
      expect(kicker.marketPoints).not.toBeNull();
      expect(kicker.blendedPoints).toBeCloseTo(kicker.marketPoints!, 6);
    }
  });

  it("blends the two estimates at the published weight", async () => {
    // The blend is what this function exists to produce, and comparing two runs of the same
    // code cannot constrain it — both sides move together. Asserted against the formula.
    // Without this, dropping the model half entirely leaves every test green.
    const { rows } = await build(ONE_ROW_EACH);
    const blended = rows.filter(
      (r) => r.modelPoints !== null && r.marketPoints !== null,
    );
    expect(blended.length).toBeGreaterThan(20);
    for (const row of blended) {
      expect(row.blendedPoints).toBeCloseTo(
        MODEL_BLEND_WEIGHT * row.modelPoints! + (1 - MODEL_BLEND_WEIGHT) * row.marketPoints!,
        2,
      );
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
