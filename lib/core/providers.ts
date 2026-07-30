import type { Competitor, Contest, MarketLine, Period, SportId } from "./domain";

/**
 * Provider seams.
 *
 * Each interface here marks a boundary where a second implementation is genuinely
 * foreseeable — another sport's statistics, another fantasy platform's leagues, another
 * source of market prices. Each currently has exactly one implementation. That is
 * deliberate: the value is in the seam being in the right place, not in having built
 * generic machinery ahead of a second caller.
 *
 * All three are async and may fail. None of them are permitted to throw for the ordinary
 * "upstream is unavailable" case — see `ProviderResult` — because a dead provider must
 * degrade the product rather than crash it. That rule exists because the previous
 * implementation pointed at a hostname that no longer resolves and had no way to say so.
 */

/** The outcome of a provider call. Never throws for an expected upstream failure. */
export type ProviderResult<T> =
  | { ok: true; data: T; degraded: false }
  /** Succeeded, but the data is stale or incomplete; `reason` is shown to the user. */
  | { ok: true; data: T; degraded: true; reason: string }
  /** Failed. `reason` is user-facing; `cause` is for logs. */
  | { ok: false; reason: string; cause?: unknown };

export function ok<T>(data: T): ProviderResult<T> {
  return { ok: true, data, degraded: false };
}

export function degraded<T>(data: T, reason: string): ProviderResult<T> {
  return { ok: true, data, degraded: true, reason };
}

export function failed<T>(reason: string, cause?: unknown): ProviderResult<T> {
  return { ok: false, reason, cause };
}

/**
 * Supplies historical production for a sport.
 *
 * `TStatLine` is the sport's own stat shape. It is a type parameter rather than a shared
 * union so that adding a sport cannot force edits to another sport's types.
 */
export interface StatsProvider<TStatLine> {
  readonly sport: SportId;
  readonly id: string;

  /** Periods for which complete statistics exist, oldest first. */
  availablePeriods(season: number): Promise<ProviderResult<Period[]>>;

  /** Every competitor's production for one period. */
  productionForPeriod(
    period: Period,
  ): Promise<ProviderResult<Array<{ competitor: Competitor; stats: TStatLine }>>>;
}

/** Supplies schedule and market prices. */
export interface MarketProvider {
  readonly sport: SportId;
  readonly id: string;

  contestsForPeriod(period: Period): Promise<ProviderResult<Contest[]>>;

  /**
   * Market lines for the given contests.
   *
   * Returns a line only where one is posted. A missing entry means "no line available",
   * which callers must distinguish from a line of zero.
   */
  linesForContests(contestIds: readonly string[]): Promise<ProviderResult<MarketLine[]>>;
}

/** A roster slot as defined by a fantasy platform. */
export interface ExternalRosterSlot {
  slotId: string;
  competitorId: string | null;
  /** Platform-specific slot name, e.g. `FLEX`. */
  slotLabel: string;
}

export interface ExternalTeam {
  id: string;
  name: string;
  managerName: string | null;
  slots: ExternalRosterSlot[];
}

export interface ExternalLeague {
  id: string;
  name: string;
  season: number;
  /** Scoring preset id the platform reports, when it reports one. */
  scoringId: string | null;
  teams: ExternalTeam[];
}

/** Credentials a platform needs. Opaque to the core; never logged. */
export interface LeagueCredentials {
  [key: string]: string;
}

/**
 * Supplies a user's league and roster from a fantasy platform.
 *
 * `isAvailable` exists because availability is a real, changing property rather than an
 * assumption: ESPN's league API has no working host today. A provider that cannot work
 * reports so, and the interface presents the alternatives instead of failing.
 */
export interface LeagueProvider {
  readonly id: string;
  readonly label: string;
  readonly sport: SportId;
  /** True when this provider needs user-supplied credentials. */
  readonly requiresCredentials: boolean;

  isAvailable(): Promise<ProviderResult<boolean>>;

  fetchLeague(
    leagueId: string,
    season: number,
    credentials?: LeagueCredentials,
  ): Promise<ProviderResult<ExternalLeague>>;
}
