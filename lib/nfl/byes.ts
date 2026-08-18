import type { Contest } from "../core/domain";

/**
 * Bye weeks, derived from the schedule.
 *
 * A bye is a property of the *team*: the one regular-season week its schedule leaves
 * empty. The draft board used to take it from the ADP payload instead, which ties a team
 * fact to whether a market happens to price the player — every player without a market
 * row got `byeWeek: null`, and the season simulation read null as "plays every week".
 * That handed a systematic ~1/14th season-value bonus to exactly the rows that already
 * lacked market discipline (#89.D, #90.1). The schedule has no such coverage hole: the
 * full season's contests are ingested before any board is built.
 */

/**
 * Each team's bye week, from one season's schedule.
 *
 * A team's bye is the week it does not play, so the derivation is a complement: the weeks
 * the season's schedule spans, minus the weeks the team appears in. A team earns an entry
 * only when exactly one week is missing — a partial schedule leaves several weeks empty
 * for every team, and guessing among them would manufacture the very kind of silent wrong
 * number this module exists to remove. Callers treat an absent entry as "unknown", never
 * as "no bye".
 *
 * The span runs from week 1 to the highest week the schedule contains, rather than to a
 * hardcoded 18: the season length is the schedule's fact, not this function's. Teams the
 * schedule never mentions get no entry at all.
 */
export function teamByeWeeks(
  contests: readonly Contest[],
  season: number,
): Map<string, number> {
  const weeksPlayed = new Map<string, Set<number>>();
  // A mutation run reports the `0` initializer, the `>` in the max, and the `??` on the
  // Set lookup as survivors, and all three are genuinely equivalent rather than coverage
  // gaps: real week numbers start at 1, so any initializer at or below 1 yields the same
  // maximum (and with no season contests, `weeksPlayed` is empty and the sweep below
  // visits nobody, whatever `lastWeek` says); `>=` differs from `>` only in re-assigning
  // an equal value; and the lookup produces a `Set` or `undefined`, never a falsy `Set`,
  // so `||` and `??` cannot disagree.
  let lastWeek = 0;
  for (const contest of contests) {
    if (contest.period.season !== season) continue;
    const week = contest.period.index;
    if (week > lastWeek) lastWeek = week;
    for (const team of [contest.homeTeam, contest.awayTeam]) {
      const played = weeksPlayed.get(team) ?? new Set<number>();
      played.add(week);
      weeksPlayed.set(team, played);
    }
  }

  const byes = new Map<string, number>();
  for (const [team, played] of weeksPlayed) {
    let bye: number | null = null;
    let ambiguous = false;
    for (let week = 1; week <= lastWeek; week += 1) {
      if (played.has(week)) continue;
      if (bye !== null) {
        ambiguous = true;
        break;
      }
      bye = week;
    }
    if (bye !== null && !ambiguous) byes.set(team, bye);
  }
  return byes;
}
