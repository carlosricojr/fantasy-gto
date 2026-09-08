import { type ProviderResult, failed, ok } from "../core/providers";
import { type TextFetcher, httpTextFetcher } from "./nflverse";

/**
 * Historical weekly statistics published by Sleeper.
 *
 * This deliberately does not share the projection endpoint. That endpoint omits the
 * kicker distance and defensive tier inputs a custom league can score, so accepting it
 * would turn incomplete source data into plausible-looking custom values.
 */
const BASE = "https://api.sleeper.com/stats/nfl";

/** The season endpoint aggregates totals; only this endpoint carries one game-week. */
export function sleeperWeekStatsUrl(season: number, week: number): string {
  return `${BASE}/${season}/${week}?season_type=regular`;
}

export interface SleeperHistoricalWeek {
  playerId: string;
  /** Sleeper uses DEF; consumers normalize it to the app's DST position. */
  position: string;
  team: string | null;
  name: string | null;
  season: number;
  week: number;
  stats: Readonly<Record<string, unknown>>;
}

/** A complete, regular-season historical release for one NFL season. */
export class SleeperStatsProvider {
  constructor(private readonly fetchText: TextFetcher = httpTextFetcher) {}

  private readonly cache = new Map<number, ProviderResult<SleeperHistoricalWeek[]>>();
  private readonly inFlight = new Map<number, Promise<ProviderResult<SleeperHistoricalWeek[]>>>();

  async seasonWeeks(season: number): Promise<ProviderResult<SleeperHistoricalWeek[]>> {
    const cached = this.cache.get(season);
    if (cached !== undefined) return cached;
    let pending = this.inFlight.get(season);
    if (pending === undefined) {
      pending = this.fetchSeasonWeeks(season).finally(() => this.inFlight.delete(season));
      this.inFlight.set(season, pending);
    }
    const result = await pending;
    if (result.ok) this.cache.set(season, result);
    return result;
  }

  private async fetchSeasonWeeks(season: number): Promise<ProviderResult<SleeperHistoricalWeek[]>> {
    const parsedWeeks = await Promise.all(
      Array.from({ length: 18 }, async (_, index) => {
        const week = index + 1;
        try {
          const raw: unknown = JSON.parse(await this.fetchText(sleeperWeekStatsUrl(season, week)));
          return parseSleeperSeasonStats(raw, season, week);
        } catch (cause) {
          return failed<SleeperHistoricalWeek[]>(
            `Sleeper historical statistics for ${season} week ${week} could not be fetched or parsed.`,
            cause,
          );
        }
      }),
    );
    const weeks: SleeperHistoricalWeek[] = [];
    for (const result of parsedWeeks) {
      if (!result.ok) return result;
      weeks.push(...result.data);
    }
    return ok(weeks);
  }
}

export function parseSleeperSeasonStats(
  raw: unknown,
  expectedSeason: number,
  expectedWeek?: number,
): ProviderResult<SleeperHistoricalWeek[]> {
  if (!Array.isArray(raw)) {
    return failed(`Sleeper historical statistics for ${expectedSeason} were not an array.`);
  }

  const rows: SleeperHistoricalWeek[] = [];
  const keys = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (row.category !== "stat" || row.season_type !== "regular") continue;
    if (asPositiveInteger(row.season) !== expectedSeason) continue;

    const player = record(row.player);
    const stats = record(row.stats);
    const playerId = asNonEmptyString(row.player_id);
    const position = asNonEmptyString(player?.position);
    const week = asPositiveInteger(row.week);
    const gp = stats === null ? null : asFiniteNumber(stats.gp);
    // A row with no game played is neither a zero nor a usable appearance. It must not
    // turn an absent player into a historical sample or dilute a player's availability.
    if (player === null || playerId === null || position === null || week === null || stats === null || gp === null || gp <= 0) {
      continue;
    }
    if (expectedWeek !== undefined && week !== expectedWeek) {
      return failed(
        `Sleeper historical statistics for ${expectedSeason} week ${expectedWeek} contain a row for week ${week}.`,
      );
    }
    const key = `${playerId}|${expectedSeason}|${week}`;
    if (keys.has(key)) {
      return failed(
        `Sleeper historical statistics for ${expectedSeason} contain duplicate player-week ${key}.`,
      );
    }
    keys.add(key);
    rows.push({
      playerId,
      position,
      team: asNonEmptyString(row.team),
      name: asNonEmptyString(player.full_name) ?? asNonEmptyString(player.first_name),
      season: expectedSeason,
      week,
      stats,
    });
  }
  if (rows.length === 0) {
    return failed(
      `Sleeper historical statistics for ${expectedSeason} contain no regular-season player-weeks with an identity and games played.`,
    );
  }
  return ok(rows);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPositiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}
