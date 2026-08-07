import type { LeagueConfig } from "@/lib/core/season-sim";

/**
 * Saying which season the odds are for.
 *
 * Two registers of the same fact — a control's summary line and a sentence in the caveat
 * paragraph — and both are derived from the config the simulation is actually run with.
 *
 * They are here, together and tested, because the sentence they replace was a literal:
 * "Odds assume a 14-week regular season and a three-week bracket". That was true while the
 * board wrote those numbers out and false for five of the six league shapes the controls
 * now offer, and it sat two panels away from a settings summary describing the real one. A
 * screen that contradicts itself about the season it simulated is the failure mode the
 * honesty ledger exists to prevent, and a string built inline in a component is the shape
 * that failure takes: nothing can assert on it.
 */

/** The shape both descriptions read. `LeagueConfig` satisfies it; nothing else needs to. */
export type SeasonShape = Pick<LeagueConfig, "weeks" | "playoffWeeks">;

/** `14–16`, or `16` when the bracket is one week long. */
function weekRange(weeks: readonly number[]): string {
  const first = weeks[0];
  const last = weeks[weeks.length - 1];
  return first === last ? String(first) : `${first}–${last}`;
}

/**
 * The compact form, for under the championship-week control: `Weeks 1–13 · playoffs 14–16`.
 *
 * The reader is choosing between "Week 15", "Week 16" and "Week 17", and what those expand
 * to depends on the playoff field two controls above. Nobody should have to do that in
 * their head when getting it wrong means drafting for the wrong season.
 */
export function seasonSummary(season: SeasonShape): string {
  const regular = `Weeks ${weekRange(season.weeks)}`;
  if (season.playoffWeeks.length === 0) return `${regular} · no playoffs`;
  return `${regular} · playoffs ${weekRange(season.playoffWeeks)}`;
}

/**
 * The prose form, for the caveat paragraph: `a 13-week regular season and a 3-week bracket
 * ending in week 16`.
 *
 * Written to slot into "Odds are for …", so it begins with an article and carries no full
 * stop.
 */
export function describeSeason(season: SeasonShape): string {
  const regular = `a ${season.weeks.length}-week regular season`;
  if (season.playoffWeeks.length === 0) return `${regular} and no playoffs`;
  const rounds = season.playoffWeeks.length;
  const last = season.playoffWeeks[rounds - 1];
  return `${regular} and a ${rounds}-week bracket ending in week ${last}`;
}
