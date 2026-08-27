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
import { OUTCOME_QUANTILES } from "@/lib/nfl/model/config";
import {
  type EntitySeason,
  type OutcomeBandFit,
  fitOutcomeBand,
  priorSeasonRatios,
} from "@/lib/nfl/model/outcome-band";
import { toDefenseStatLine, toKickerStatLine, toTeamWeek } from "@/lib/nfl/stats/parse";
import { scoreDefense, scoreKicker } from "@/lib/nfl/scoring/score";
import { PPR } from "@/lib/nfl/scoring/presets";
import { parseContests, teamWeeklyStatsUrl } from "@/lib/sources/nflverse";
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

/**
 * Fetched every run, never served from disk — the opposite contract to `cached`.
 *
 * The nflverse releases above are published artifacts: last season's file is the same
 * file today, so caching them makes a re-run fast and offline without making it stale.
 * A search-relevance ordering is not that. Serving yesterday's copy would report
 * yesterday's coverage under today's date, which is precisely the failure this script
 * exists to prevent — and it would do it silently, since the figures look no different.
 *
 * The copy on disk is written for inspection after the fact and is never read back. A
 * failed fetch therefore fails the check rather than falling back: this section measures
 * a live feed and cannot be reproduced offline, which is a limitation worth stating
 * loudly rather than papering over with a stale number.
 */
async function fetchedFresh(dir: string, name: string, url: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  process.stdout.write(`  fetching ${name} (live — never cached)...\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const text = await response.text();
  writeFileSync(join(dir, name), text);
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
  const raw = await fetchedFresh(SLEEPER_CACHE_DIR, "players_nfl.json", sleeperPlayersUrl());
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
    // `Buffer.byteLength`, not `raw.length`: the latter counts UTF-16 code units, and
    // the dump carries accented names — so a string length labelled "bytes" understates
    // the payload by however many non-ASCII characters it happens to hold.
    `  payload ${Buffer.byteLength(raw, "utf8").toLocaleString()} bytes, ` +
      `${entries.toLocaleString()} entries\n` +
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
  const adpRaw = await fetchedFresh(
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

/**
 * Seasons the K and D/ST outcome bands are fitted on.
 *
 * 2013 through 2024, and the choice is forced twice over. The floor is the earliest season
 * with a usable prior: 2012 supplies the denominators and is not itself scored. The ceiling
 * is the holdout rule in `CLAUDE.md` — 2025 is evaluated once, by
 * `pnpm backtest -- --holdout`, at a decision point written down in advance, and a band
 * fitted here is not that decision. Nothing in this section reads a 2025 row.
 */
const BAND_SEASONS: readonly number[] = Array.from({ length: 13 }, (_, i) => 2012 + i);

/** The first of those seasons supplies denominators only. */
const BAND_FIRST_SCORED = BAND_SEASONS[0] + 1;

/**
 * Prior-season games a kicker or defense needs before his mean is used as a denominator.
 *
 * Half a season. Below that the denominator is noise and the ratio describes it rather than
 * the outcome; the figures printed at 4 and 12 games are how a reader checks that the band
 * does not hinge on the number.
 */
const BAND_MIN_PRIOR_GAMES = 8;

/**
 * The two bands in `OUTCOME_QUANTILES` that the backtest cannot produce.
 *
 * `pnpm backtest` fits a band from the model's own predictions, and the model projects
 * neither of these positions. Measured here instead, from historical weekly scoring against
 * the estimate a drafter actually holds — the entity's own prior-season points per game.
 * `lib/nfl/model/outcome-band.ts` carries the argument for the construction and for why a
 * defense cannot be fitted the same way a kicker is.
 *
 * This also verifies the two upstream releases the D/ST half needs, which is why it lives
 * in this script rather than beside the backtest: a team defense is not a player and has no
 * row in `stats_player_week` at all, so a D/ST week is `stats_team_week` for the counting
 * statistics plus the schedule for the points its own team conceded.
 */
async function verifyOutcomeBands(): Promise<void> {
  process.stdout.write(
    `\n${"=".repeat(78)}\nK and D/ST outcome bands: measured, not assumed\n${"=".repeat(78)}\n`,
  );

  const kickerSeasons: EntitySeason[] = [];
  const defenseSeasons: EntitySeason[] = [];

  // Points allowed is the *other* team's final score, so it comes from the schedule
  // through the shipped parser rather than from a column of the statistics release, which
  // has none. `parseContests` keeps regular-season rows only, which is the same filter
  // both statistics loops apply below.
  const contests = parseContests(parseCsv(await cached(schedulesUrl())));
  const conceded = new Map<string, number>();
  for (const contest of contests) {
    if (contest.result === null) continue;
    const week = contest.period.index;
    conceded.set(
      `${contest.homeTeam}|${contest.period.season}|${week}`,
      contest.result.awayScore,
    );
    conceded.set(
      `${contest.awayTeam}|${contest.period.season}|${week}`,
      contest.result.homeScore,
    );
  }

  let unresolvedPointsAllowed = 0;
  let teamGames = 0;
  // Every field `toDefenseStatLine` reads and `scoreDefense` then scores. Cross-checking a
  // subset and publishing a count for the whole set is the defect this script exists to
  // prevent, so the two lists are the same list.
  const crossCheck = {
    compared: 0,
    sacks: 0,
    interceptions: 0,
    tds: 0,
    safeties: 0,
    recoveries: 0,
    returnTds: 0,
  };

  for (const season of BAND_SEASONS) {
    const kickerWeeks = new Map<string, number[]>();
    const playerRows = parseCsv(await cached(statsUrl(season)));
    // Defensive counts aggregated from the player release, purely to cross-check the team
    // release against an independent upstream file. Nothing downstream reads them.
    const playerAggregate = new Map<string, Record<string, number>>();
    for (const row of playerRows) {
      if (str(row, "season_type") !== "REG") continue;
      const team = normalizeTeam(str(row, "team"));
      if (team !== null) {
        const key = `${team}|${num(row, "week")}`;
        const bucket = playerAggregate.get(key) ?? {
          sacks: 0,
          interceptions: 0,
          tds: 0,
          safeties: 0,
          recoveries: 0,
          returnTds: 0,
        };
        bucket.sacks += num(row, "def_sacks");
        bucket.interceptions += num(row, "def_interceptions");
        bucket.tds += num(row, "def_tds");
        bucket.safeties += num(row, "def_safeties");
        bucket.recoveries += num(row, "fumble_recovery_opp");
        bucket.returnTds += num(row, "special_teams_tds");
        playerAggregate.set(key, bucket);
      }
      if (str(row, "position").toUpperCase() !== "K") continue;
      const id = str(row, "player_id");
      if (id === "") continue;
      const bucket = kickerWeeks.get(id) ?? [];
      bucket.push(scoreKicker(toKickerStatLine(row), PPR).total);
      kickerWeeks.set(id, bucket);
    }
    for (const [id, weeklyPoints] of kickerWeeks) {
      kickerSeasons.push({ id, season, weeklyPoints });
    }

    const defenseWeeks = new Map<string, number[]>();
    for (const row of parseCsv(await cached(teamWeeklyStatsUrl(season)))) {
      if (str(row, "season_type") !== "REG") continue;
      const identity = toTeamWeek(row);
      if (identity === null) continue;
      teamGames += 1;
      const pointsAllowed = conceded.get(
        `${identity.team}|${identity.period.season}|${identity.period.index}`,
      );
      if (pointsAllowed === undefined) {
        // Counted and reported rather than skipped silently: a team-week with no kickoff
        // behind it means the schedule join has broken, and a band quietly fitted on the
        // survivors would look no different.
        unresolvedPointsAllowed += 1;
        continue;
      }
      const aggregate = playerAggregate.get(`${identity.team}|${identity.period.index}`);
      if (aggregate !== undefined) {
        crossCheck.compared += 1;
        if (Math.abs(aggregate.sacks - num(row, "def_sacks")) > 1e-9) crossCheck.sacks += 1;
        if (Math.abs(aggregate.interceptions - num(row, "def_interceptions")) > 1e-9)
          crossCheck.interceptions += 1;
        if (Math.abs(aggregate.tds - num(row, "def_tds")) > 1e-9) crossCheck.tds += 1;
        if (Math.abs(aggregate.safeties - num(row, "def_safeties")) > 1e-9)
          crossCheck.safeties += 1;
        if (Math.abs(aggregate.recoveries - num(row, "fumble_recovery_opp")) > 1e-9)
          crossCheck.recoveries += 1;
        if (Math.abs(aggregate.returnTds - num(row, "special_teams_tds")) > 1e-9)
          crossCheck.returnTds += 1;
      }
      const bucket = defenseWeeks.get(identity.team) ?? [];
      bucket.push(scoreDefense(toDefenseStatLine(row, pointsAllowed), PPR).total);
      defenseWeeks.set(identity.team, bucket);
    }
    for (const [id, weeklyPoints] of defenseWeeks) {
      defenseSeasons.push({ id, season, weeklyPoints });
    }
  }

  process.stdout.write(
    `  seasons ${BAND_FIRST_SCORED}-${BAND_SEASONS[BAND_SEASONS.length - 1]} scored, ` +
      `${BAND_SEASONS[0]} supplying denominators only; 2025 not read\n` +
      `  kicker seasons ${kickerSeasons.length}, defense seasons ${defenseSeasons.length}, ` +
      `team-games ${teamGames}\n` +
      `  points allowed unresolved from the schedule: ${unresolvedPointsAllowed}\n` +
      `  team release vs aggregating the player release over ${crossCheck.compared} team-games:\n` +
      `    sacks ${crossCheck.sacks}, interceptions ${crossCheck.interceptions}, ` +
      `defensive touchdowns ${crossCheck.tds}, return touchdowns ${crossCheck.returnTds}, ` +
      `fumble recoveries ${crossCheck.recoveries}, ` +
      `safeties ${crossCheck.safeties} disagree\n`,
  );
  if (unresolvedPointsAllowed > 0) {
    throw new Error(
      `${unresolvedPointsAllowed} team-weeks had no kickoff to take points allowed from, ` +
        `so the defense band would be fitted on whichever weeks happened to join`,
    );
  }

  /**
   * The cross-check, asserted rather than merely printed.
   *
   * Split, because the two releases do not agree equally on everything and pretending
   * otherwise would give a check that either fails on every run or never fails at all.
   *
   * Four of the six agree **exactly** across every team-game measured, so any disagreement
   * at all is an upstream contract change and is refused. Sacks and safeties do not, and
   * the difference is attribution rather than fact — a safety credited to the team but to
   * no individual, or the reverse. Those two are bounded instead, at roughly five times what
   * they measure today, because what matters is that they stay a rounding error: refitting
   * the whole D/ST band on player-aggregated safeties moves its dispersion from 0.9050 to
   * 0.9045, which `docs/data-sources.md` records. A structural bound rather than a pinned
   * count, for the same reason the Sleeper join's is one — the counts are allowed to move,
   * the shape is not.
   */
  // A floor on the comparison itself, before anything is concluded from it. Every check
  // below counts *disagreements*, so an empty comparison satisfies all of them — a key
  // that stopped matching would read exactly like two releases in perfect accord.
  if (crossCheck.compared < teamGames * 0.9) {
    throw new Error(
      `only ${crossCheck.compared} of ${teamGames} team-games found a player-release ` +
        `aggregate to compare against, so every agreement below would be an agreement ` +
        `about nothing — the team-and-week key has stopped matching across the releases`,
    );
  }
  const exact: [string, number][] = [
    ["interceptions", crossCheck.interceptions],
    ["defensive touchdowns", crossCheck.tds],
    ["return touchdowns", crossCheck.returnTds],
    ["fumble recoveries", crossCheck.recoveries],
  ];
  const broken = exact.filter(([, count]) => count > 0);
  if (broken.length > 0) {
    throw new Error(
      `the two releases disagree on ${broken.map(([f, c]) => `${f} (${c})`).join(", ")} ` +
        `across ${crossCheck.compared} team-games, and these fields have always agreed ` +
        `exactly — one of the two has changed what it counts, so the D/ST band is being ` +
        `fitted on a different quantity than the one measured`,
    );
  }
  const ATTRIBUTION_BOUND = 0.1;
  for (const [field, count] of [
    ["sacks", crossCheck.sacks],
    ["safeties", crossCheck.safeties],
  ] as [string, number][]) {
    if (count > crossCheck.compared * ATTRIBUTION_BOUND) {
      throw new Error(
        `the two releases disagree on ${field} in ${count} of ${crossCheck.compared} ` +
          `team-games, past the ${ATTRIBUTION_BOUND * 100}% this tolerates as attribution ` +
          `noise — at that rate it is no longer a rounding error on the D/ST band`,
      );
    }
  }

  const report = (label: string, fit: OutcomeBandFit) => {
    process.stdout.write(
      `  ${label.padEnd(22)} n=${String(fit.sampleSize).padStart(5)}  ` +
        `p10=${fit.empiricalP10.toFixed(3)}  p50=${fit.empiricalP50.toFixed(3)}  ` +
        `p90=${fit.empiricalP90.toFixed(3)}  <=0 ${(fit.nonPositiveShare * 100).toFixed(1)}%  ` +
        `E[max2]/mean=${fit.expectedMaxRatio.toFixed(3)}  ` +
        `sigma(10/90)=${fit.sigmaFromRange === null ? " undefined" : fit.sigmaFromRange.toFixed(3)}  ` +
        `sigma(E[max])=${fit.sigmaFromExpectedMax.toFixed(3)}  ` +
        `band ${fit.band.p10}/${fit.band.p90} by ${fit.rule}\n`,
    );
  };

  for (const [position, seasons] of [
    ["K", kickerSeasons],
    ["DST", defenseSeasons],
  ] as const) {
    process.stdout.write(`\n  ${position}\n`);
    for (const minPriorGames of [4, BAND_MIN_PRIOR_GAMES, 12]) {
      report(
        `prior games >= ${minPriorGames}`,
        fitOutcomeBand(priorSeasonRatios(seasons, minPriorGames)),
      );
    }
    // Leave-one-season-out, so a band that rests on one unusual year is visible as one.
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (const dropped of BAND_SEASONS.slice(1)) {
      const fit = fitOutcomeBand(
        priorSeasonRatios(
          seasons.filter((entry) => entry.season !== dropped),
          BAND_MIN_PRIOR_GAMES,
        ),
      );
      lowest = Math.min(lowest, fit.sigmaFromExpectedMax);
      highest = Math.max(highest, fit.sigmaFromExpectedMax);
    }
    const shipped = OUTCOME_QUANTILES[position];
    const fit = fitOutcomeBand(priorSeasonRatios(seasons, BAND_MIN_PRIOR_GAMES));
    process.stdout.write(
      `  leave-one-season-out sigma(E[max]) in [${lowest.toFixed(3)}, ${highest.toFixed(3)}]\n` +
        `  checked in as ${shipped.p10}/${shipped.p90} (${shipped.provenance})\n`,
    );
    // The same rule the backtest's quantiles follow, enforced rather than eyeballed: a
    // constant in `config.ts` marked measured must be the number this program prints.
    if (shipped.p10 !== fit.band.p10 || shipped.p90 !== fit.band.p90) {
      throw new Error(
        `OUTCOME_QUANTILES.${position} is ${shipped.p10}/${shipped.p90} but this ` +
          `measurement says ${fit.band.p10}/${fit.band.p90}. Upstream has restated a ` +
          `season, or the constant was edited by hand; either way one of the two is a ` +
          `number the code cannot produce.`,
      );
    }
    if (shipped.provenance !== "measured") {
      throw new Error(`OUTCOME_QUANTILES.${position} is measured but marked ${shipped.provenance}`);
    }
  }
}
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
  await verifyOutcomeBands();

  process.stdout.write(
    "\nEvery figure above appears in docs/data-sources.md. If one has moved, update that\n" +
      "document in the same commit — upstream retires and repopulates releases.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-sources failed: ${String(error)}\n`);
  process.exitCode = 1;
});
