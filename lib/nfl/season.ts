import type { Contest, Period } from "../core/domain";

/**
 * Season and week resolution.
 *
 * "What week is it?" cannot be answered from the wall clock alone. At the time of writing
 * the most recent season with complete statistics is 2025 while the calendar year is 2026,
 * because the 2026 season has not started — upstream returns 404 for its player statistics.
 * A product that trusted `new Date().getFullYear()` would render an empty current week and
 * look broken for seven months of the year.
 *
 * These functions resolve from data availability, with the clock as a secondary signal.
 * All of them are pure, taking `now` as an argument.
 */

export const NFL_REGULAR_SEASON_WEEKS = 18;

/** Where the league is in its calendar. */
export type SeasonPhase = "preseason" | "regular" | "offseason";

export interface SeasonState {
  /** The season the product should display. */
  season: number;
  /** The week to display. During the offseason this is the final completed week. */
  week: number;
  phase: SeasonPhase;
  /** True when no games remain to be played in the displayed season. */
  isComplete: boolean;
}

/**
 * Resolves the season and week to display from the schedule.
 *
 * Prefers the latest season that has any completed game. Within it, the current week is
 * the earliest week with an unplayed game — that is the week a user still has decisions to
 * make about. When every game is played, the season is complete and the last week is shown.
 */
export function resolveSeasonState(
  contests: readonly Contest[],
  now: number,
): SeasonState | null {
  if (contests.length === 0) return null;

  const seasons = [...new Set(contests.map((c) => c.period.season))].sort((a, b) => b - a);

  const playedSeasons = seasons.filter((season) =>
    contests.some((c) => c.period.season === season && c.result !== null),
  );

  // Prefer a season already underway; otherwise the next one scheduled.
  const season = playedSeasons[0] ?? seasons[seasons.length - 1];
  const inSeason = contests.filter((c) => c.period.season === season);

  const unplayed = inSeason
    .filter((c) => c.result === null)
    .sort((a, b) => a.period.index - b.period.index);

  if (unplayed.length === 0) {
    const lastWeek = Math.max(...inSeason.map((c) => c.period.index));
    return { season, week: lastWeek, phase: "offseason", isComplete: true };
  }

  const anyPlayed = inSeason.some((c) => c.result !== null);
  const week = unplayed[0].period.index;

  // A scheduled season with nothing played yet is upcoming, not current.
  if (!anyPlayed) {
    const firstKickoff = unplayed[0].startsAt;
    const started = firstKickoff !== null && Date.parse(firstKickoff) <= now;
    return {
      season,
      week,
      phase: started ? "regular" : "preseason",
      isComplete: false,
    };
  }

  return { season, week, phase: "regular", isComplete: false };
}

/**
 * The most recent season for which complete statistics exist.
 *
 * Distinct from the displayed season: during the 2026 preseason the product shows 2026's
 * schedule while every projection is still built from 2025 production.
 */
export function latestCompletedSeason(contests: readonly Contest[]): number | null {
  const played = contests.filter((c) => c.result !== null);
  if (played.length === 0) return null;
  return Math.max(...played.map((c) => c.period.season));
}

/** Periods with at least one completed game, oldest first. */
export function completedPeriods(contests: readonly Contest[]): Period[] {
  const keys = new Set<string>();
  const periods: Period[] = [];
  for (const contest of contests) {
    if (contest.result === null) continue;
    const key = `${contest.period.season}:${contest.period.index}`;
    if (keys.has(key)) continue;
    keys.add(key);
    periods.push(contest.period);
  }
  return periods.sort((a, b) => a.season - b.season || a.index - b.index);
}

/** True when a week falls inside the fantasy regular season. */
export function isFantasyWeek(week: number): boolean {
  return Number.isInteger(week) && week >= 1 && week <= NFL_REGULAR_SEASON_WEEKS;
}

/** A short human label, e.g. `2025 Week 7`. */
export function describePeriod(period: Period): string {
  return `${period.season} Week ${period.index}`;
}

/** Explains an offseason or preseason state in one sentence for the interface. */
export function describeSeasonState(state: SeasonState): string {
  switch (state.phase) {
    case "offseason":
      // "results" would be wrong: the pages that render this string show model
      // projections with floor/ceiling bands, never actual scores. A user comparing them
      // against real box scores would conclude the data is broken.
      return `The ${state.season} season is complete. Showing projections for its final week, Week ${state.week}.`;
    case "preseason":
      return `The ${state.season} season has not kicked off yet. Showing Week ${state.week} projections.`;
    case "regular":
      return `${state.season} Week ${state.week}`;
  }
}
