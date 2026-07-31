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
  for (const row of rows) {
    // Only active players. `RET`, `CUT`, and the rest are on the file too.
    if (str(row, "status").toUpperCase() !== "ACT") continue;

    // `gsis_id` is the join key to weekly statistics. Without it a roster row cannot be
    // connected to any production history, so it would price a player from nothing.
    const playerId = str(row, "gsis_id");
    if (playerId === "") continue;

    const name = str(row, "full_name") || str(row, "player_name");
    if (name === "") continue;

    let position = str(row, "position").toUpperCase();
    if (position === "FB") position = "RB";

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
  async playerWeeks(season: number): Promise<ProviderResult<PlayerWeek[]>> {
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
  async seasonRoster(season: number): Promise<ProviderResult<RosterEntry[]>> {
    try {
      const text = await this.fetchText(seasonRosterUrl(season));
      return ok(parseSeasonRoster(parseCsv(text)));
    } catch (cause) {
      return failed(
        `Rosters for ${season} are unavailable. They are usually published well before ` +
          `the season starts.`,
        cause,
      );
    }
  }

  async contestsForPeriod(period: Period): Promise<ProviderResult<Contest[]>> {
    const rows = await this.schedules();
    if (!rows.ok) return failed(rows.reason, rows.cause);
    return ok(
      parseContests(rows.data).filter(
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

  /** Every contest across all seasons. */
  async allContests(): Promise<ProviderResult<Contest[]>> {
    const rows = await this.schedules();
    if (!rows.ok) return failed(rows.reason, rows.cause);
    return ok(parseContests(rows.data));
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
