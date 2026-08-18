import type { Contest, MarketLine, Period, SportId } from "../core/domain";
import {
  type MarketProvider,
  type ProviderResult,
  type StatsProvider,
  failed,
  ok,
} from "../core/providers";
import { type CsvRow, num, numOrNull, parseCsv, str } from "../nfl/csv";
import { normalizeTeam } from "../nfl/teams";

import { type InjuryParseReport, toRegularSeasonInjuries } from "../nfl/injuries";
import { type PlayerProfile, toPlayerProfiles } from "../nfl/players";
import { type SnapCount, toRegularSeasonSnaps } from "../nfl/snaps";
import { type WeeklyRosterReport, toWeeklyRoster } from "../nfl/weekly-roster";
import { type PlayerWeek, toRegularSeasonPlayerWeeks } from "../nfl/stats/parse";

/**
 * nflverse adapter.
 *
 * Implements both the statistics and market seams, because upstream publishes weekly
 * production and betting lines as two files from the same project. A future betting
 * feature would either keep using this or swap in a live odds provider behind the same
 * `MarketProvider` interface.
 *
 * Endpoints are recorded and justified in `docs/data-sources.md`. The asset naming here
 * is the *current* release; the retired `player_stats` release stops at 2024 and reading
 * from it fails silently by yielding zeros for renamed columns.
 */

const RELEASE_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

export function weeklyStatsUrl(season: number): string {
  return `${RELEASE_BASE}/stats_player/stats_player_week_${season}.csv`;
}

export function schedulesUrl(): string {
  return `${RELEASE_BASE}/schedules/games.csv`;
}

/**
 * Season roster release.
 *
 * The one source that says which team a player is on *before* a game has been played.
 * Weekly statistics cannot: a player's team is derived from an appearance, so in the
 * preseason there is nothing to derive it from. This is the release the README's week-1
 * known gap names, and it is what makes a preseason draft board possible at all.
 */
export function seasonRosterUrl(season: number): string {
  return `${RELEASE_BASE}/rosters/roster_${season}.csv`;
}

/**
 * The player directory.
 *
 * One file, every player, no season parameter. Carries the birth date the model needs for
 * any notion of age, and — the reason it is load-bearing rather than convenient — both
 * `gsis_id` and `pfr_id`, which is the only bridge between weekly statistics and snap
 * counts. See `lib/nfl/players.ts`.
 */
export function playersUrl(): string {
  return `${RELEASE_BASE}/players/players.csv`;
}

/**
 * Weekly injury reports.
 *
 * The header shape differs across seasons — 2024 has `date_modified` and no `season_type`,
 * 2025 the reverse — and `lib/nfl/injuries.ts` parses on `game_type`, which both carry.
 */
export function injuriesUrl(season: number): string {
  return `${RELEASE_BASE}/injuries/injuries_${season}.csv`;
}

/**
 * Weekly snap counts.
 *
 * Keyed by `pfr_player_id`, so it needs the player directory to meet a projection. First
 * populated in **2013** — the 2012 asset answers 200 with a valid header and no rows.
 */
export function snapCountsUrl(season: number): string {
  return `${RELEASE_BASE}/snap_counts/snap_counts_${season}.csv`;
}

/**
 * Weekly rosters.
 *
 * The only source that resolves a player's team **before a game has been played**, which is
 * what makes a week-1 board possible at all. Keyed on `gsis_id` + `week`, so it joins
 * directly. Available from 2002.
 */
export function weeklyRosterUrl(season: number): string {
  return `${RELEASE_BASE}/weekly_rosters/roster_weekly_${season}.csv`;
}

/** Fetches a URL as text. Injectable so tests never touch the network. */
export type TextFetcher = (url: string) => Promise<string>;

/**
 * How long to wait for upstream before giving up.
 *
 * Generous, because these are multi-megabyte files, but bounded. Without a deadline a
 * stalled connection hangs until the surrounding Convex action is killed, burning the whole
 * time budget and reporting a timeout rather than a diagnosable failure.
 */
export const FETCH_TIMEOUT_MS = 60_000;

export const httpTextFetcher: TextFetcher = async (url) => {
  // AbortController rather than AbortSignal.timeout: it is supported everywhere this runs,
  // and the timer is cleared explicitly so a fast response does not hold the event loop.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${url} responded ${response.status}`);
    }
    return await response.text();
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new Error(`${url} timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Converts an nflverse kickoff to a UTC instant.
 *
 * Upstream records `gameday` and `gametime` as US Eastern wall-clock, with no offset.
 * Appending `Z` and calling it UTC — which is what this used to do — shifts every kickoff
 * by four or five hours, enough to move a Sunday night game onto Monday and to misjudge
 * whether a season has started.
 *
 * The offset cannot be hardcoded: the NFL season spans the DST changeover, so September is
 * UTC-4 and January is UTC-5. This resolves the real offset by formatting a provisional
 * instant in `America/New_York` and correcting by the difference, which handles both.
 *
 * Returns `null` for an unparseable input rather than a wrong instant.
 */
export function easternWallClockToUtcIso(day: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const clock = /^\d{2}:\d{2}$/.test(time) ? time : "00:00";

  // Provisional instant, read as if the wall clock were UTC.
  const provisional = Date.parse(`${day}T${clock}:00Z`);
  if (Number.isNaN(provisional)) return null;

  // What that instant actually reads as in New York.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(provisional));

  const field = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asNewYork = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour") % 24,
    field("minute"),
    field("second"),
  );

  // The gap between the two is the zone's offset at that moment.
  return new Date(provisional + (provisional - asNewYork)).toISOString();
}

/** Parses the schedules file into contests. */
export function parseContests(rows: readonly CsvRow[]): Contest[] {
  const contests: Contest[] = [];
  for (const row of rows) {
    if (str(row, "game_type") !== "REG") continue;
    const home = normalizeTeam(str(row, "home_team"));
    const away = normalizeTeam(str(row, "away_team"));
    if (!home || !away) continue;

    const homeScore = numOrNull(row, "home_score");
    const awayScore = numOrNull(row, "away_score");
    const day = str(row, "gameday");
    const time = str(row, "gametime");

    contests.push({
      id: str(row, "game_id"),
      period: { season: num(row, "season"), index: num(row, "week") },
      homeTeam: home,
      awayTeam: away,
      startsAt: day === "" ? null : easternWallClockToUtcIso(day, time),
      result:
        homeScore === null || awayScore === null
          ? null
          : { homeScore, awayScore },
    });
  }
  return contests;
}

/**
 * Parses market lines from the schedules file.
 *
 * A row with no posted total yields no entry at all rather than an entry of zero, so
 * callers can distinguish "no line" from "line of zero". Conflating those would drag
 * projections toward zero for any game without a market.
 */
export function parseMarketLines(rows: readonly CsvRow[]): MarketLine[] {
  const lines: MarketLine[] = [];
  for (const row of rows) {
    if (str(row, "game_type") !== "REG") continue;
    const total = numOrNull(row, "total_line");
    const spread = numOrNull(row, "spread_line");
    if (total === null && spread === null) continue;
    lines.push({
      contestId: str(row, "game_id"),
      spread,
      total,
      homeMoneyline: numOrNull(row, "home_moneyline"),
      awayMoneyline: numOrNull(row, "away_moneyline"),
    });
  }
  return lines;
}

/** Weather and venue context for a contest, used by future environment adjustments. */
export interface VenueContext {
  contestId: string;
  roof: string;
  temperatureF: number | null;
  windMph: number | null;
}

export function parseVenues(rows: readonly CsvRow[]): VenueContext[] {
  return rows
    .filter((row) => str(row, "game_type") === "REG")
    .map((row) => ({
      contestId: str(row, "game_id"),
      roof: str(row, "roof"),
      temperatureF: numOrNull(row, "temp"),
      windMph: numOrNull(row, "wind"),
    }));
}

/** A player on a team's roster for a season. */
export interface RosterEntry {
  /** `gsis_id` upstream, which is the same identifier `stats_player_week` calls `player_id`. */
  playerId: string;
  name: string;
  position: string;
  team: string | null;
}

/** Pure parse of the season roster release. */
export function parseSeasonRoster(rows: readonly CsvRow[]): RosterEntry[] {
  const entries: RosterEntry[] = [];
  // A player traded mid-season can appear active on two teams in the same release. The
  // board is keyed by `(board, playerId)`, so both rows are written and the later one wins
  // — meaning the team shown is whichever the file happened to list last, silently. Kept
  // once, at the first active row, so the choice is at least deterministic and the
  // duplicate cannot masquerade as two draftable players.
  const seen = new Set<string>();
  for (const row of rows) {
    // Only active players. `RET`, `CUT`, and the rest are on the file too.
    if (str(row, "status").toUpperCase() !== "ACT") continue;

    // `gsis_id` is the join key to weekly statistics. Without it a roster row cannot be
    // connected to any production history, so it would price a player from nothing.
    const playerId = str(row, "gsis_id");
    if (playerId === "" || seen.has(playerId)) continue;

    const name = str(row, "full_name") || str(row, "player_name");
    if (name === "") continue;

    let position = str(row, "position").toUpperCase();
    if (position === "FB") position = "RB";

    seen.add(playerId);
    entries.push({
      playerId,
      name,
      position,
      team: normalizeTeam(str(row, "team")),
    });
  }
  return entries;
}

export class NflverseProvider implements StatsProvider<PlayerWeek>, MarketProvider {
  readonly sport: SportId = "nfl";
  readonly id = "nflverse";

  private readonly fetchText: TextFetcher;
  private schedulesCache: CsvRow[] | null = null;
  private contestsCache: Contest[] | null = null;
  private contestsInFlight: Promise<ProviderResult<Contest[]>> | null = null;

  constructor(fetchText: TextFetcher = httpTextFetcher) {
    this.fetchText = fetchText;
  }

  /** Weeks with completed statistics, derived from what upstream actually published. */
  async availablePeriods(season: number): Promise<ProviderResult<Period[]>> {
    const weeks = await this.playerWeeks(season);
    if (!weeks.ok) return failed(weeks.reason, weeks.cause);
    const indexes = [...new Set(weeks.data.map((w) => w.period.index))].sort((a, b) => a - b);
    return ok(indexes.map((index) => ({ season, index })));
  }

  async productionForPeriod(
    period: Period,
  ): Promise<ProviderResult<Array<{ competitor: PlayerWeek["competitor"]; stats: PlayerWeek }>>> {
    const weeks = await this.playerWeeks(period.season);
    if (!weeks.ok) return failed(weeks.reason, weeks.cause);
    return ok(
      weeks.data
        .filter((w) => w.period.index === period.index)
        .map((w) => ({ competitor: w.competitor, stats: w })),
    );
  }

  /** All regular-season player-weeks for a season. */
  private readonly weeksCache = new Map<number, ProviderResult<PlayerWeek[]>>();
  private readonly weeksInFlight = new Map<number, Promise<ProviderResult<PlayerWeek[]>>>();

  async playerWeeks(season: number): Promise<ProviderResult<PlayerWeek[]>> {
    // Same reasoning as the roster cache: one action builds many boards from the same two
    // seasons of statistics, and these are the largest files the project touches.
    const cached = this.weeksCache.get(season);
    if (cached !== undefined) return cached;
    // The in-flight promise is shared too, for the same reason as `players`.
    let inFlight = this.weeksInFlight.get(season);
    if (inFlight === undefined) {
      inFlight = this.fetchPlayerWeeks(season).finally(() => {
        this.weeksInFlight.delete(season);
      });
      this.weeksInFlight.set(season, inFlight);
    }
    const result = await inFlight;
    // Only successes are cached. A failure is usually transient — a network blip, or a
    // release that upstream has not published yet — and one provider serves a whole
    // board-building run, so caching the failure turns a single bad fetch into every
    // later call for that season failing too, for the lifetime of the action.
    if (result.ok) this.weeksCache.set(season, result);
    return result;
  }

  private async fetchPlayerWeeks(season: number): Promise<ProviderResult<PlayerWeek[]>> {
    try {
      const text = await this.fetchText(weeklyStatsUrl(season));
      return ok(toRegularSeasonPlayerWeeks(parseCsv(text)));
    } catch (cause) {
      return failed(
        `Weekly statistics for ${season} are unavailable. The season may not have started.`,
        cause,
      );
    }
  }

  /**
   * Rostered players for a season, with their team.
   *
   * Retired and otherwise inactive players are dropped. Upstream keeps them on the file
   * with a `status` other than `ACT`, and a draft board that offered them would be
   * recommending players who will not take a snap.
   */
  private readonly rosterCache = new Map<number, ProviderResult<RosterEntry[]>>();
  private readonly rosterInFlight = new Map<
    number,
    Promise<ProviderResult<RosterEntry[]>>
  >();

  async seasonRoster(season: number): Promise<ProviderResult<RosterEntry[]>> {
    // Cached for the provider's lifetime. A single action builds a board for every scoring
    // format and league size, and each one needs the same roster file; without this it is
    // fetched and parsed once per shape.
    const cached = this.rosterCache.get(season);
    if (cached !== undefined) return cached;
    let inFlight = this.rosterInFlight.get(season);
    if (inFlight === undefined) {
      inFlight = this.fetchSeasonRoster(season).finally(() => {
        this.rosterInFlight.delete(season);
      });
      this.rosterInFlight.set(season, inFlight);
    }
    const result = await inFlight;
    // Only successes are cached. A failure is usually transient — a network blip, or a
    // release that upstream has not published yet — and one provider serves a whole
    // board-building run, so caching the failure turns a single bad fetch into every
    // later call for that season failing too, for the lifetime of the action.
    if (result.ok) this.rosterCache.set(season, result);
    return result;
  }

  private async fetchSeasonRoster(season: number): Promise<ProviderResult<RosterEntry[]>> {
    try {
      const text = await this.fetchText(seasonRosterUrl(season));
      const entries = parseSeasonRoster(parseCsv(text));
      // An empty file parses cleanly and would report success, leaving every downstream
      // caller to conclude the league has no players rather than that the fetch was bad.
      if (entries.length === 0) {
        return failed(
          `Rosters for ${season} parsed to no active players. The release is probably a ` +
            `placeholder that has not been populated yet.`,
        );
      }
      return ok(entries);
    } catch (cause) {
      return failed(
        `Rosters for ${season} are unavailable. They are usually published well before ` +
          `the season starts.`,
        cause,
      );
    }
  }

  /**
   * Every player upstream knows about, with age, experience, and the `pfr_id` bridge.
   *
   * Cached for the provider's lifetime like the roster and weekly files. This one is a
   * single multi-megabyte download shared by every caller that needs an age or a bridge
   * lookup, so re-fetching it per use would dominate the cost of any run that touches it.
   */
  private playersCache: ProviderResult<PlayerProfile[]> | null = null;
  private playersInFlight: Promise<ProviderResult<PlayerProfile[]>> | null = null;

  async players(): Promise<ProviderResult<PlayerProfile[]>> {
    if (this.playersCache !== null) return this.playersCache;
    // The in-flight promise is shared, not just the settled result. Populating the cache
    // only after the fetch resolves leaves a window in which every concurrent caller starts
    // its own download of the same multi-megabyte file — and callers here are concurrent by
    // construction, since one action builds many boards at once. Cleared on settlement, so a
    // failure is retried rather than remembered.
    this.playersInFlight ??= this.fetchPlayers().finally(() => {
      this.playersInFlight = null;
    });
    const result = await this.playersInFlight;
    // Only successes are cached, for the same reason as everywhere else here: a transient
    // failure cached for the provider's lifetime turns one bad fetch into every later call
    // failing too.
    if (result.ok) this.playersCache = result;
    return result;
  }

  private async fetchPlayers(): Promise<ProviderResult<PlayerProfile[]>> {
    try {
      const text = await this.fetchText(playersUrl());
      const profiles = toPlayerProfiles(parseCsv(text));
      // A file that answers 200 with a valid header and no usable rows parses cleanly and
      // reports success, leaving every caller to conclude the league has no players. That
      // exact shape is real in these releases — `snap_counts_2012.csv` is one — so it is
      // refused here rather than propagated.
      if (profiles.length === 0) {
        return failed(
          "The player directory parsed to no players with a gsis_id. The release is " +
            "probably a placeholder that has not been populated yet.",
        );
      }
      return ok(profiles);
    } catch (cause) {
      return failed("The nflverse player directory is unavailable.", cause);
    }
  }

  /**
   * One season of weekly injury reports.
   *
   * Returns the parse report rather than bare rows, so a caller sees the count of
   * unrecognised status values alongside the data. A new designation appearing upstream
   * should be visible, not folded into "no designation" and discovered a season later.
   */
  private readonly injuriesCache = new Map<number, ProviderResult<InjuryParseReport>>();
  private readonly injuriesInFlight = new Map<
    number,
    Promise<ProviderResult<InjuryParseReport>>
  >();

  async injuries(season: number): Promise<ProviderResult<InjuryParseReport>> {
    const cached = this.injuriesCache.get(season);
    if (cached !== undefined) return cached;
    // Concurrent callers for one season share a single download, as everywhere else here.
    let inFlight = this.injuriesInFlight.get(season);
    if (inFlight === undefined) {
      inFlight = this.fetchInjuries(season).finally(() => {
        this.injuriesInFlight.delete(season);
      });
      this.injuriesInFlight.set(season, inFlight);
    }
    const result = await inFlight;
    if (result.ok) this.injuriesCache.set(season, result);
    return result;
  }

  private async fetchInjuries(
    season: number,
  ): Promise<ProviderResult<InjuryParseReport>> {
    try {
      const text = await this.fetchText(injuriesUrl(season));
      const parsed = toRegularSeasonInjuries(parseCsv(text));
      // Non-zero rows asserted per season. Filtering the wrong column — `season_type`
      // instead of `game_type` — discards 100% of 2024 and yields a clean-looking result
      // built from nothing, which is a debugging cycle this project has already spent once.
      if (parsed.reports.length === 0) {
        return failed(
          `Injury reports for ${season} parsed to no regular-season rows. Either the ` +
            `release is unpopulated or the header shape has drifted again.`,
        );
      }
      // The row count catches a rename of `game_type` or `gsis_id`, because both zero it.
      // It does not catch a rename of the *payload* — `report_status` or `practice_status`.
      // `str()` reads an absent column as blank and blank is legitimately "no designation",
      // so a renamed status column yields thousands of rows in which nobody was ever listed
      // Out, with the unknown counters empty because blank is exactly what they skip. That
      // is the clean-looking result built from nothing this seam exists to refuse, reached
      // through the one door the count leaves open.
      if (
        parsed.reports.every(
          (r) => r.gameStatus === "none" && r.practiceStatus === "none",
        )
      ) {
        return failed(
          `Injury reports for ${season} parsed ${parsed.reports.length} rows with no ` +
            `designation on any of them. report_status and practice_status have probably ` +
            `been renamed.`,
        );
      }
      return ok(parsed);
    } catch (cause) {
      return failed(`Injury reports for ${season} are unavailable.`, cause);
    }
  }

  /**
   * One season of weekly snap counts, still keyed by `pfr_player_id`.
   *
   * Bridging is left to the caller, which needs `players()` anyway and is the only layer
   * that can decide what to do with a row that does not resolve.
   */
  private readonly snapsCache = new Map<number, ProviderResult<SnapCount[]>>();
  private readonly snapsInFlight = new Map<number, Promise<ProviderResult<SnapCount[]>>>();

  async snapCounts(season: number): Promise<ProviderResult<SnapCount[]>> {
    const cached = this.snapsCache.get(season);
    if (cached !== undefined) return cached;
    let inFlight = this.snapsInFlight.get(season);
    if (inFlight === undefined) {
      inFlight = this.fetchSnapCounts(season).finally(() => {
        this.snapsInFlight.delete(season);
      });
      this.snapsInFlight.set(season, inFlight);
    }
    const result = await inFlight;
    if (result.ok) this.snapsCache.set(season, result);
    return result;
  }

  private async fetchSnapCounts(season: number): Promise<ProviderResult<SnapCount[]>> {
    try {
      const text = await this.fetchText(snapCountsUrl(season));
      const snaps = toRegularSeasonSnaps(parseCsv(text));
      // HTTP 200, a valid sixteen-column header, and not one data row is a real shape here.
      // Reporting success on it would have a caller conclude nobody took a snap that season.
      //
      // The message says what happened and not which seasons are populated: which they are
      // is a measurement, it lives in `docs/data-sources.md` where `pnpm verify-sources`
      // reproduces it, and a range baked into an error string goes stale the first time
      // upstream backfills.
      if (snaps.length === 0) {
        return failed(
          `Snap counts for ${season} parsed to no regular-season rows. The release answered ` +
            `but is empty for this season; see docs/data-sources.md for which seasons are ` +
            `populated.`,
        );
      }
      return ok(snaps);
    } catch (cause) {
      return failed(`Snap counts for ${season} are unavailable.`, cause);
    }
  }

  /**
   * One season of weekly rosters.
   *
   * Cached and coalesced like every other seasonal file here — a projection run asks for it
   * once per ruleset otherwise.
   */
  private readonly weeklyRosterCache = new Map<
    number,
    ProviderResult<WeeklyRosterReport>
  >();
  private readonly weeklyRosterInFlight = new Map<
    number,
    Promise<ProviderResult<WeeklyRosterReport>>
  >();

  async weeklyRoster(season: number): Promise<ProviderResult<WeeklyRosterReport>> {
    const cached = this.weeklyRosterCache.get(season);
    if (cached !== undefined) return cached;
    let inFlight = this.weeklyRosterInFlight.get(season);
    if (inFlight === undefined) {
      inFlight = this.fetchWeeklyRoster(season).finally(() => {
        this.weeklyRosterInFlight.delete(season);
      });
      this.weeklyRosterInFlight.set(season, inFlight);
    }
    const result = await inFlight;
    if (result.ok) this.weeklyRosterCache.set(season, result);
    return result;
  }

  private async fetchWeeklyRoster(
    season: number,
  ): Promise<ProviderResult<WeeklyRosterReport>> {
    try {
      const text = await this.fetchText(weeklyRosterUrl(season));
      const parsed = toWeeklyRoster(parseCsv(text));
      if (parsed.entries.length === 0) {
        return failed(
          `Weekly rosters for ${season} parsed to no regular-season rows. The release ` +
            `answered but is empty or its header has drifted.`,
        );
      }
      // A file full of rows in which nobody is active is the payload-level failure the row
      // count cannot see — the same shape the injury seam already refuses. Every player
      // would be skipped and the week would look uncovered for a reason that is not true.
      if (parsed.entries.every((entry) => entry.status !== "active")) {
        return failed(
          `Weekly rosters for ${season} parsed ${parsed.entries.length} rows with no ` +
            `active player among them. The status column has probably been renamed or ` +
            `recoded.`,
        );
      }
      return ok(parsed);
    } catch (cause) {
      return failed(`Weekly rosters for ${season} are unavailable.`, cause);
    }
  }

  async contestsForPeriod(period: Period): Promise<ProviderResult<Contest[]>> {
    const all = await this.allContests();
    if (!all.ok) return all;
    return ok(
      all.data.filter(
        (c) => c.period.season === period.season && c.period.index === period.index,
      ),
    );
  }

  async linesForContests(contestIds: readonly string[]): Promise<ProviderResult<MarketLine[]>> {
    const rows = await this.schedules();
    if (!rows.ok) return failed(rows.reason, rows.cause);
    const wanted = new Set(contestIds);
    return ok(parseMarketLines(rows.data).filter((line) => wanted.has(line.contestId)));
  }

  /**
   * Every contest across all seasons, parsed once per provider.
   *
   * The raw rows were already cached, but the *parse* was not — and `parseContests`
   * resolves an Eastern wall-clock per row through `Intl.DateTimeFormat`, which is the
   * expensive part. `refreshDraftBoards` now calls this once per board shape inside a
   * single action (33 shapes over a ~7,000-row file), which is exactly the repeated-work
   * shape the one-provider-per-run comment there exists to prevent.
   *
   * The in-flight promise is shared, following `AdpProvider`'s discipline: with only the
   * settled cache, two concurrent callers on one provider both miss it and fetch and
   * parse the whole file twice. Only a success populates the cache — a failure is
   * usually transient, and one provider serves a whole run.
   */
  async allContests(): Promise<ProviderResult<Contest[]>> {
    if (this.contestsCache) return ok(this.contestsCache);
    if (this.contestsInFlight === null) {
      this.contestsInFlight = this.fetchAllContests().finally(() => {
        this.contestsInFlight = null;
      });
    }
    return this.contestsInFlight;
  }

  private async fetchAllContests(): Promise<ProviderResult<Contest[]>> {
    const rows = await this.schedules();
    if (!rows.ok) return failed(rows.reason, rows.cause);
    this.contestsCache = parseContests(rows.data);
    return ok(this.contestsCache);
  }

  async allMarketLines(): Promise<ProviderResult<MarketLine[]>> {
    const rows = await this.schedules();
    if (!rows.ok) return failed(rows.reason, rows.cause);
    return ok(parseMarketLines(rows.data));
  }

  private async schedules(): Promise<ProviderResult<CsvRow[]>> {
    if (this.schedulesCache) return ok(this.schedulesCache);
    try {
      const text = await this.fetchText(schedulesUrl());
      this.schedulesCache = parseCsv(text);
      return ok(this.schedulesCache);
    } catch (cause) {
      return failed("The NFL schedule feed is unavailable.", cause);
    }
  }
}
