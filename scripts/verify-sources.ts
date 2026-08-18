/**
 * Reproduces every measured figure in `docs/data-sources.md`.
 *
 * That document is authoritative about what upstream actually contains, and its most
 * load-bearing entries are *negative* results — a release that answers 200 with a valid
 * header and no rows, seasons that carry every column and no data. Those are exactly the
 * findings a reader cannot check by eye and exactly the ones that decide which seasons the
 * backtest is allowed to use.
 *
 * They were measured by hand once. This script is what makes them reproducible, which is
 * the same rule the model figures already follow: a number the code cannot produce may not
 * be published.
 *
 * Run with `pnpm verify-sources`. Downloads are cached under `.cache/nflverse` alongside the
 * backtest's, so a second run is fast and offline.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { num, parseCsv, str } from "@/lib/nfl/csv";
import { MODELED_POSITIONS } from "@/lib/nfl/draft/config";
import { joinMarketAwareness } from "@/lib/nfl/draft/market-awareness";
import { parseBoardFixture } from "@/lib/nfl/draft/mock";
import { adpUrl, parseAdp } from "@/lib/sources/adp";
import { parsePlayersDump, playersUrl as sleeperPlayersUrl } from "@/lib/sources/sleeper";
import { quantile } from "@/lib/core/stats";
import { toRegularSeasonInjuries } from "@/lib/nfl/injuries";
import { bridgeSnaps, toRegularSeasonSnaps } from "@/lib/nfl/snaps";
import { easternWallClockToUtcIso } from "@/lib/sources/nflverse";
import { normalizeTeam } from "@/lib/nfl/teams";
import { pfrBridge, toPlayerProfiles } from "@/lib/nfl/players";

const RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";
const CACHE_DIR = join(process.cwd(), ".cache", "nflverse");
const SLEEPER_CACHE_DIR = join(process.cwd(), ".cache", "sleeper");
const ADP_CACHE_DIR = join(process.cwd(), ".cache", "adp");

/** The league the awareness coverage is measured against — the frozen audit board's. */
const AWARENESS_SEASON = 2026;
const AWARENESS_SCORING = "half_ppr";
const AWARENESS_TEAMS = 10;
const AWARENESS_FIXTURE = join(
  process.cwd(),
  "tests/fixtures/draft_board_2026_half_ppr_10team.json",
);

/** Seasons the coverage table reports on, chosen to bracket the dead zone it documents. */
const COVERAGE_SEASONS = [1999, 2004, 2006, 2008, 2009, 2012, 2016, 2021, 2024, 2025];

/** Seasons the snap-count row counts report on, bracketing the empty 2012 release. */
const SNAP_SEASONS = [2012, 2013, 2014, 2015, 2016, 2017];

/** Seasons the identifier-bridge join rate reports on. */
const BRIDGE_SEASONS = [2013, 2016, 2020, 2024];

/** Positions the coverage and bridge figures are measured over. */
const SKILL = ["WR", "TE", "RB"];
const BRIDGE_POSITIONS = ["QB", "RB", "WR", "TE", "FB"];

async function cached(url: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, url.split("/").pop() ?? "download.csv");
  if (existsSync(file)) return readFileSync(file, "utf8");
  process.stdout.write(`  downloading ${url.split("/").pop()}...\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const text = await response.text();
  writeFileSync(file, text);
  return text;
}

/** `cached`, with the directory chosen by the caller — the same on-disk contract. */
async function cachedIn(dir: string, name: string, url: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  if (existsSync(file)) return readFileSync(file, "utf8");
  process.stdout.write(`  downloading ${name}...\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const text = await response.text();
  writeFileSync(file, text);
  return text;
}

/**
 * The Sleeper players dump's coverage, and how much of the frozen board it answers for.
 *
 * Every figure in the document's "Players dump — Sleeper" section, measured through the
 * shipped parser and join rather than a side-channel script — which is the difference
 * between a number the code produces and a number somebody once saw.
 *
 * **These figures drift daily and are expected to.** `search_rank` is a live
 * search-relevance ordering, so a re-run days later legitimately reports different
 * counts; the document stamps the date it was measured on, and this check is how a
 * reader re-measures rather than trusts. What must not drift is the shape: a collapse in
 * the join rate or a surge in ambiguities is a broken matcher, not a busy offseason.
 */
async function verifySleeperAwareness(): Promise<void> {
  process.stdout.write(
    `\n${"=".repeat(78)}\nSleeper players dump: market-awareness coverage\n${"=".repeat(78)}\n`,
  );
  const raw = await cachedIn(SLEEPER_CACHE_DIR, "players_nfl.json", sleeperPlayersUrl());
  const payload: unknown = JSON.parse(raw);
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("the Sleeper players dump is not the object the parser expects");
  }
  const entries = Object.keys(payload as Record<string, unknown>).length;
  const rows = parsePlayersDump(payload as Record<string, unknown>);
  const skill = rows.filter((row) =>
    (MODELED_POSITIONS as readonly string[]).includes(row.position),
  );
  const ranked = skill.filter((row) => row.searchRank !== null && row.team !== null);
  const withDepth = ranked.filter((row) => row.depthChartOrder !== null);
  process.stdout.write(
    `  payload ${raw.length.toLocaleString()} bytes, ${entries.toLocaleString()} entries\n` +
      `  parsed ${rows.length.toLocaleString()} rows ` +
      `(${entries - rows.length} skipped for no usable name or position)\n` +
      `  skill rows (QB/RB/WR/TE by fantasy position): ${skill.length}\n` +
      `  ...with a meaningful search rank AND a team: ${ranked.length}\n` +
      `  ...of those, carrying a depth-chart order: ${withDepth.length}\n` +
      `  refused the unranked sentinel: ${skill.length - skill.filter((r) => r.searchRank !== null).length} ` +
      `skill rows carry no usable rank\n`,
  );

  // The price feed, for the comparison the document draws: this is the coverage the
  // board actually has today, not a historical figure.
  const adpRaw = await cachedIn(
    ADP_CACHE_DIR,
    `${AWARENESS_SCORING}_${AWARENESS_TEAMS}_${AWARENESS_SEASON}.json`,
    adpUrl(AWARENESS_SCORING, AWARENESS_TEAMS, AWARENESS_SEASON),
  );
  // `parseAdp` answers null for the error payload the feed serves with HTTP 200 — the
  // hazard `lib/sources/adp.ts` documents. Refused rather than reported as zero coverage,
  // which would read as a finding about the market rather than a failed download.
  const adp = parseAdp(JSON.parse(adpRaw));
  if (adp === null) {
    throw new Error(
      `the price feed served no ${AWARENESS_SEASON} ${AWARENESS_SCORING} board for ` +
        `${AWARENESS_TEAMS} teams, so the coverage comparison has no denominator`,
    );
  }
  const adpSkill = adp.filter((entry) =>
    (MODELED_POSITIONS as readonly string[]).includes(entry.position.toUpperCase()),
  );
  process.stdout.write(
    `  price feed the same day: ${adp.length} rows, ${adpSkill.length} of them skill\n`,
  );

  // The join, against the frozen audit board — the one place the gate's coverage claim
  // can be checked against a board that does not move.
  const fixture = parseBoardFixture(JSON.parse(readFileSync(AWARENESS_FIXTURE, "utf8")));
  const board = fixture.rows.filter((row) =>
    (MODELED_POSITIONS as readonly string[]).includes(row.position),
  );
  const unpriced = board.filter((row) => row.adp === null);
  const { byPlayerId, ambiguities, unmatched } = joinMarketAwareness(board, skill);
  const ranks = [...byPlayerId.values()].filter((a) => a.searchRank !== null).length;
  const renamed = [...byPlayerId.entries()].filter(([id, awareness]) => {
    const row = board.find((entry) => entry.playerId === id);
    return row !== undefined && row.name !== awareness.sourceName;
  }).length;
  process.stdout.write(
    `  frozen board: ${board.length} skill rows, ${unpriced.length} of them unpriced\n` +
      `  joined: ${byPlayerId.size} (${ranks} with a meaningful rank, ` +
      `${renamed} spelled differently by the two sources)\n` +
      `  refused as ambiguous: ${ambiguities.length}` +
      (ambiguities.length > 0 ? ` (${ambiguities.join(", ")})` : "") +
      `\n  unmatched: ${unmatched.length}` +
      (unmatched.length > 0 ? ` (${unmatched.join(", ")})` : "") +
      `\n`,
  );
  // A structural floor rather than a pinned count, because the counts are supposed to
  // move: the matcher answering for under half the unpriced board, or guessing its way
  // past every ambiguity, is a defect whatever the day's ranks say.
  if (byPlayerId.size < unpriced.length / 2) {
    throw new Error(
      `the awareness join answers for only ${byPlayerId.size} of ${unpriced.length} ` +
        `unpriced rows — the matcher has broken, not the market`,
    );
  }
}

const statsUrl = (season: number) =>
  `${RELEASE_BASE}/stats_player/stats_player_week_${season}.csv`;
const snapsUrl = (season: number) =>
  `${RELEASE_BASE}/snap_counts/snap_counts_${season}.csv`;
const playersUrl = () => `${RELEASE_BASE}/players/players.csv`;
const injuriesUrl = (season: number) =>
  `${RELEASE_BASE}/injuries/injuries_${season}.csv`;
const schedulesUrl = () => `${RELEASE_BASE}/schedules/games.csv`;

/** Seasons the injury leakage check runs on. Only 2024 carries `date_modified`. */
const INJURY_SEASONS = [2024, 2025];

/**
 * Kickoff for every regular-season game, as a UTC instant, keyed by `week:team`.
 *
 * `gameday` and `gametime` are US Eastern wall clock with no offset, and the season spans
 * the daylight-saving changeover — September is UTC−4, January UTC−5. Appending a `Z` would
 * shift every kickoff by four or five hours, which is more than enough to move a report from
 * "before the game" to "after it" and invert the entire finding below.
 */
function kickoffsByTeamWeek(rows: readonly Record<string, string>[], season: number) {
  const kickoffs = new Map<string, number>();
  for (const row of rows) {
    if (num(row, "season") !== season || str(row, "game_type") !== "REG") continue;
    const iso = easternWallClockToUtcIso(str(row, "gameday"), str(row, "gametime"));
    if (iso === null) continue;
    const at = Date.parse(iso);
    // Normalized on this side too. The injury side goes through `normalizeTeam`, so
    // leaving these raw is dormant only while every code is already canonical. Extend
    // INJURY_SEASONS backwards and OAK, SD and STL normalize on one side and not the
    // other, dropping every one of those teams' rows into `unmatched` while the percentage
    // quietly continues over the survivors.
    for (const raw of [str(row, "home_team"), str(row, "away_team")]) {
      const team = normalizeTeam(raw);
      if (team === null) continue;
      kickoffs.set(`${str(row, "week")}:${team}`, at);
    }
  }
  return kickoffs;
}

/** Share of rows carrying a value that is neither blank nor zero. */
function populated(rows: readonly Record<string, string>[], column: string): number {
  if (rows.length === 0) return Number.NaN;
  const filled = rows.filter(
    (row) => String(row[column] ?? "").trim() !== "" && num(row, column) !== 0,
  ).length;
  return filled / rows.length;
}

async function main(): Promise<void> {
  process.stdout.write("Verifying docs/data-sources.md\n");

  // 1.2a — the header does not drift, the population does.
  process.stdout.write(`\n${"=".repeat(78)}\nstats_player_week: header stability\n${"=".repeat(78)}\n`);
  const headers = new Map<number, string>();
  for (const season of COVERAGE_SEASONS) {
    headers.set(season, (await cached(statsUrl(season))).split("\n")[0].trim());
  }
  const distinct = new Set(headers.values());
  const columnCount = [...headers.values()][0].split(",").length;
  process.stdout.write(
    `  ${COVERAGE_SEASONS.length} seasons sampled from ${COVERAGE_SEASONS[0]} to ` +
      `${COVERAGE_SEASONS[COVERAGE_SEASONS.length - 1]}\n` +
      `  distinct headers: ${distinct.size}  (columns: ${columnCount})\n` +
      `  ${distinct.size === 1 ? "IDENTICAL — a renamed column is not the historical hazard" : "DRIFT DETECTED — the document is stale"}\n`,
  );

  const usageColumns = [
    "target_share",
    "air_yards_share",
    "wopr",
    "racr",
    "targets",
  ];
  process.stdout.write(
    `\n${"=".repeat(78)}\nstats_player_week: usage coverage on REG skill rows (${SKILL.join("/")})\n${"=".repeat(78)}\n` +
      `  ${"season".padEnd(8)}${"REG rows".padStart(10)}${"skill".padStart(8)}` +
      `${usageColumns.map((c) => c.slice(0, 9).padStart(11)).join("")}\n`,
  );
  for (const season of COVERAGE_SEASONS) {
    const rows = parseCsv(await cached(statsUrl(season)));
    const reg = rows.filter((r) => str(r, "season_type") === "REG");
    const skill = reg.filter((r) => SKILL.includes(str(r, "position")));
    process.stdout.write(
      `  ${String(season).padEnd(8)}${String(reg.length).padStart(10)}` +
        `${String(skill.length).padStart(8)}` +
        // A dash, not `NaN%`. A season with no skill rows at all is a different finding
        // from one whose skill rows carry no usage, and rendering both as a percentage
        // would let the emptier failure hide inside the table as a number.
        `${usageColumns
          .map((c) => {
            const share = populated(skill, c);
            return (Number.isNaN(share) ? "—" : `${(share * 100).toFixed(0)}%`).padStart(11);
          })
          .join("")}\n`,
    );
  }
  process.stdout.write(
    "  A season reading 0% parses cleanly and yields an entirely fictional usage signal.\n",
  );

  // 1.2b — snap counts start in 2013, not 2012.
  process.stdout.write(
    `\n${"=".repeat(78)}\nsnap_counts: where the release is actually populated\n${"=".repeat(78)}\n`,
  );
  for (const season of SNAP_SEASONS) {
    const text = await cached(snapsUrl(season));
    const rows = parseCsv(text);
    process.stdout.write(
      `  snap_counts_${season}: ${String(rows.length).padStart(6)} data rows` +
        `${rows.length === 0 ? "   <- HTTP 200, valid header, no data" : ""}\n`,
    );
  }

  // The identifier bridge.
  process.stdout.write(
    `\n${"=".repeat(78)}\nplayers.csv: the pfr_id <-> gsis_id bridge\n${"=".repeat(78)}\n`,
  );
  const players = parseCsv(await cached(playersUrl()));
  const bridge = new Map<string, string>();
  for (const row of players) {
    const pfr = str(row, "pfr_id");
    const gsis = str(row, "gsis_id");
    if (pfr !== "" && gsis !== "") bridge.set(pfr, gsis);
  }
  process.stdout.write(
    `  ${players.length} rows, ${bridge.size} carrying both identifiers\n\n` +
      `  ${"season".padEnd(8)}${"skill rows".padStart(12)}${"joinable".padStart(11)}` +
      `${"unjoinable players".padStart(20)}${"their mean snap %".padStart(19)}\n`,
  );
  // Measured through the same `bridgeSnaps` the product would use, rather than through a
  // parallel implementation in this script. A join rate computed one way here and another
  // way in `lib/` is a published number that nothing actually exercises.
  const directory = pfrBridge(toPlayerProfiles(parseCsv(await cached(playersUrl()))));
  for (const season of BRIDGE_SEASONS) {
    const allSnaps = toRegularSeasonSnaps(parseCsv(await cached(snapsUrl(season))));
    const skillSnaps = allSnaps.filter((snap) =>
      BRIDGE_POSITIONS.includes(snap.position),
    );
    if (skillSnaps.length === 0) {
      process.stdout.write(`  ${String(season).padEnd(8)}${"EMPTY".padStart(12)}\n`);
      continue;
    }
    const report = bridgeSnaps(skillSnaps, directory);
    const missingRows = report.unmatched;
    const meanSnapPct =
      missingRows.length === 0
        ? 0
        : missingRows.reduce((sum, snap) => sum + snap.offenseShare, 0) / missingRows.length;
    process.stdout.write(
      `  ${String(season).padEnd(8)}${String(skillSnaps.length).padStart(12)}` +
        `${`${((report.matched.length / skillSnaps.length) * 100).toFixed(1)}%`.padStart(11)}` +
        `${String(report.unmatchedPlayers.size).padStart(20)}` +
        `${`${(meanSnapPct * 100).toFixed(1)}%`.padStart(19)}\n`,
    );
  }

  // The directory's own coverage, and its join rate against a real season's statistics.
  // These are two different measurements and conflating them is easy: the share of
  // *directory rows* carrying a `pfr_id` is not the share of *snap rows* that can be
  // joined, because the players missing an identifier largely never appear in the files
  // that need it.
  process.stdout.write(
    `\n${"=".repeat(78)}\nplayers.csv: directory coverage and the join to weekly statistics\n${"=".repeat(78)}\n`,
  );
  const profiles = toPlayerProfiles(parseCsv(await cached(playersUrl())));
  const directorySkill = profiles.filter((p) =>
    BRIDGE_POSITIONS.includes(p.position),
  );
  // Refused rather than rendered. Every population below is a fixed historical sample that
  // is known to be non-empty, so an empty one means the release moved — and a table of
  // `NaN%` beside an exit code of 0 reads as "verified" to anything checking this script.
  if (profiles.length === 0 || directorySkill.length === 0) {
    throw new Error(
      `players.csv yielded ${profiles.length} players and ${directorySkill.length} at ` +
        `skill positions; both were non-empty when this was written, so the release has moved`,
    );
  }
  const share = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}%`;
  process.stdout.write(
    `  ${profiles.length} players with a gsis_id, of which ${directorySkill.length} at skill positions\n` +
      `  birth_date present:  all ${share(profiles.filter((p) => p.birthDate).length, profiles.length)}` +
      `   skill ${share(directorySkill.filter((p) => p.birthDate).length, directorySkill.length)}\n` +
      `  pfr_id present:      all ${share(profiles.filter((p) => p.pfrId).length, profiles.length)}` +
      `   skill ${share(directorySkill.filter((p) => p.pfrId).length, directorySkill.length)}\n`,
  );

  const byPlayerId = new Map(profiles.map((p) => [p.playerId, p]));
  process.stdout.write(
    `\n  ${"season".padEnd(8)}${"REG skill rows".padStart(16)}${"in directory".padStart(14)}` +
      `${"with birth_date".padStart(17)}${"with pfr_id".padStart(13)}\n`,
  );
  for (const season of BRIDGE_SEASONS) {
    const weeks = parseCsv(await cached(statsUrl(season))).filter(
      (r) => str(r, "season_type") === "REG" && BRIDGE_POSITIONS.includes(str(r, "position")),
    );
    if (weeks.length === 0) {
      throw new Error(
        `${season} yielded no regular-season skill player-weeks; it had thousands when ` +
          `this was written, so either the release moved or the filter is wrong`,
      );
    }
    const matched = weeks.filter((r) => byPlayerId.has(str(r, "player_id")));
    const withBirth = matched.filter((r) => byPlayerId.get(str(r, "player_id"))!.birthDate);
    const withPfr = matched.filter((r) => byPlayerId.get(str(r, "player_id"))!.pfrId);
    process.stdout.write(
      `  ${String(season).padEnd(8)}${String(weeks.length).padStart(16)}` +
        `${share(matched.length, weeks.length).padStart(14)}` +
        `${share(withBirth.length, weeks.length).padStart(17)}` +
        `${share(withPfr.length, weeks.length).padStart(13)}\n`,
    );
  }

  // The leakage question. The injury *report* is pre-kickoff by nature, but this release is
  // assembled afterwards, so "the report was published before the game" and "the row we can
  // read was written before the game" are different claims and only the second is checkable.
  process.stdout.write(
    `\n${"=".repeat(78)}\ninjuries: header shape, and whether the rows predate kickoff\n${"=".repeat(78)}\n`,
  );
  const schedule = parseCsv(await cached(schedulesUrl()));
  for (const season of INJURY_SEASONS) {
    const text = await cached(injuriesUrl(season));
    const header = text.split("\n")[0].trim().split(",");
    const parsed = toRegularSeasonInjuries(parseCsv(text));
    const statuses = new Map<string, number>();
    for (const report of parsed.reports) {
      statuses.set(report.gameStatus, (statuses.get(report.gameStatus) ?? 0) + 1);
    }
    process.stdout.write(
      `\n  ${season}: ${parsed.reports.length} regular-season rows\n` +
        `    header carries season_type=${header.includes("season_type")}, ` +
        `game_type=${header.includes("game_type")}, ` +
        `date_modified=${header.includes("date_modified")}\n` +
        `    game status: ${[...statuses].map(([k, v]) => `${k} ${v}`).join(", ")}\n` +
        `    unrecognised: report_status ${[...parsed.unknownGameStatus].map(([k, v]) => `${JSON.stringify(k)}×${v}`).join(" ") || "none"}` +
        `, practice_status ${[...parsed.unknownPracticeStatus].map(([k, v]) => `${JSON.stringify(k)}×${v}`).join(" ") || "none"}\n`,
    );

    const dated = parsed.reports.filter((r) => r.dateModified !== null);
    if (dated.length === 0) {
      process.stdout.write(
        `    no date_modified column: pre-kickoff timing CANNOT be verified for this season\n`,
      );
      continue;
    }
    const kickoffs = kickoffsByTeamWeek(schedule, season);
    let before = 0;
    let after = 0;
    let unmatched = 0;
    const lateness: number[] = [];
    for (const report of dated) {
      const at = kickoffs.get(`${report.week}:${report.team ?? ""}`);
      if (at === undefined) {
        unmatched += 1;
        continue;
      }
      const hoursBefore = (at - Date.parse(report.dateModified!)) / 3_600_000;
      lateness.push(hoursBefore);
      if (hoursBefore >= 0) before += 1;
      else after += 1;
    }
    lateness.sort((a, b) => a - b);
    const matched = before + after;
    // Refused, not rendered. `0/0` prints `NaN%` and then the min/max lookup throws a
    // TypeError, so the operator sees a stack trace instead of the diagnosis. Same shape
    // the two checks above already refuse explicitly.
    if (matched === 0) {
      throw new Error(
        `no ${season} injury row joined to a kickoff; all ${dated.length} were unmatched, ` +
          `so the team/week join has broken`,
      );
    }
    process.stdout.write(
      `    joined to a kickoff: ${matched} of ${dated.length} (${unmatched} unmatched)\n` +
        `    modified BEFORE kickoff: ${before} (${((before / matched) * 100).toFixed(2)}%)\n` +
        `    modified AFTER  kickoff: ${after} (${((after / matched) * 100).toFixed(2)}%)\n` +
        `    hours before kickoff — min ${lateness[0].toFixed(1)}, ` +
        // `quantile` from lib/core/stats, which is tested and linear-interpolated — for an
        // even count that is exactly the average of the two central values. A hand-rolled
        // median beside it would be eight untested lines producing a published number.
        `median ${quantile(lateness, 0.5).toFixed(1)}, ` +
        `max ${lateness[lateness.length - 1].toFixed(1)}\n`,
    );
  }

  await verifySleeperAwareness();

  process.stdout.write(
    "\nEvery figure above appears in docs/data-sources.md. If one has moved, update that\n" +
      "document in the same commit — upstream retires and repopulates releases.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-sources failed: ${String(error)}\n`);
  process.exitCode = 1;
});
