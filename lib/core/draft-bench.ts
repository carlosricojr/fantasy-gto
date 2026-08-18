/**
 * What depth at a position is worth.
 *
 * The draft has to price two different things with one number. A starter is worth what he
 * adds to the lineup you field every week. A reserve is worth nothing most weeks and a whole
 * slot the week a starter is out — and the second of those has no expression at all in "what
 * does he add to the best legal lineup right now", because the answer is zero.
 *
 * Leaving it at zero is not an option: every bench candidate then scores the same and the
 * board becomes whatever order the rows arrived in. What stood there instead was
 * `weeklyMean * availability * 1e-3` — a raw projection, scaled small. That ranks reserves
 * *by position*, because quarterbacks outscore everyone in raw points, and a completed
 * fifteen-round roster in a one-quarterback league came back holding seven of them. Pricing
 * against replacement fixed the position bias and left the shape: the term still did not
 * diminish, so the roster went on hoarding whichever position happened to lead it.
 *
 * ## The model
 *
 * Take one position in isolation. It occupies `slots` places in the lineup, the roster holds
 * players `w_1 >= w_2 >= ...` at it with availabilities `a_i`, and a replacement-level player
 * worth `R` can always be had. Each week the lineup starts the best `slots` of whoever is
 * available, backfilling from replacement. So the expected weekly return from those slots is
 *
 *   slots * R + sum_i  a_i * P(fewer than `slots` of the players above him are available)
 *                          * max(w_i - R, 0)
 *
 * — a player contributes what he beats replacement by, in the weeks he is both available and
 * not crowded out. The probability is a Poisson-binomial (independent trials, different
 * probabilities) accumulated as a running distribution, which is what lets a *fragile*
 * starter raise his own backup's value. A shared average availability cannot express that.
 *
 * ## Why this is a cover bonus and not the whole value
 *
 * The all-available case is already priced, exactly and across positions, by the lineup
 * solver: it knows that a third back is worth a FLEX slot on one roster and nothing on
 * another, and that taking that FLEX pushes a receiver out. This function must not price it
 * again. So it returns the *difference* between the expression above and the same expression
 * with every availability set to one — the value that exists only because players miss weeks.
 *
 * That difference is what makes the two regimes comparable. A candidate who improves the
 * starting lineup by a tenth of a point is not worth less than a slightly worse candidate at
 * the same position who improves it by nothing: both cover the same absences, and the better
 * one covers them better. Splitting the two into separate branches said otherwise, and
 * ordered a 14.8 back above a 15.0 one.
 *
 * ## Byes are absences too
 *
 * A *known* bye is a *certain* absence in one known week rather than a probable one in any
 * week, so it does not fold into an availability. The expectation is therefore taken per
 * week: in a week that is nobody's bye every player is present with his own availability,
 * and in a week that is somebody's bye that player is present with probability zero. Weeks
 * that are nobody's bye are identical to each other and are computed once, so a position
 * holding four players costs five evaluations rather than fourteen.
 *
 * An *unknown* bye (`byeWeek: null`) is not the absence of one — every team sits out a
 * week — and treating it as "never idle" credited exactly the rows with the worst data a
 * full season of cover, the same #89.D subsidy the season simulation used to pay. Because
 * the week is unknown, it *does* fold into the availability, as the one uniform discount
 * consistent with "his bye is equally likely to be any played week": presence in every
 * week is scaled by `(weeks - 1) / weeks`, which prices the expected cost of one absent
 * week without electing a week for it.
 *
 * This is not a refinement. Without it a sixth running back behind five is needed about once
 * in eight hundred weeks, which is less often than a backup kicker is needed — so a fifteenth
 * pick went on a second kicker. With byes counted the same back is needed about once in
 * seventy, because five backs have five byes between them, and the ordering is the one every
 * draft guide gives for reasons it never quantifies.
 *
 * ## What this deliberately does not model
 *
 * - **Correlated absence.** `UtilityConfig.meanAbsenceWeeks` says injuries cluster, which
 *   makes depth worth slightly more than independent draws suggest. The simulation models it;
 *   this filter does not.
 * - **Cross-position cover.** A back covers a FLEX a receiver vacates. Only same-position
 *   cover is counted, which understates depth at every flex-eligible position by the same
 *   kind of term.
 * - **The waiver wire.** Depth you could stream is worth less than depth you must draft, and
 *   the gap is not the same at every position: a league of twelve rosters twelve kickers and
 *   sixty backs, so the best undrafted kicker is nearly the best drafted one while the best
 *   undrafted back is nowhere near. `docs/draft-validation.md` records this as unmodeled and
 *   it still is. The effect is to overstate reserves at shallow, streamable positions —
 *   which is exactly where a second kicker comes from when one does.
 *
 * Each of those makes this an estimate used to *narrow* a field, which is what it is for. The
 * objective is the simulation.
 */

/** A player as the depth model needs to see him. */
export interface DepthPlayer {
  /** Points times availability — the same quantity the lineup solver ranks by. */
  readonly value: number;
  /** Probability he is fit in a given non-bye week. */
  readonly availability: number;
  /**
   * The week his team is idle, or `null` when the board does not say.
   *
   * Null is *unknown*, not "no bye": it is charged as a uniform per-week discount (see
   * the module docstring). A caller that genuinely means "no bye in any played week" —
   * `coverValue`'s everybody-present baseline — says so with a week number outside the
   * played set, never with null.
   */
  readonly byeWeek: number | null;
}

/**
 * One week of it. `byeWeek` names the week being evaluated, or `null` for a week nobody is
 * idle; a player whose bye falls on it is present with probability zero rather than with his
 * availability.
 *
 * `ordered` must already be sorted by value descending — the running distribution is what
 * makes the crowding-out probability correct, and it is only correct walked in that order.
 *
 * Availabilities are clamped into `[0, 1]`. This runs inside a rollout, and a board row
 * carrying `1.0000000001` out of a division is not a reason to fail a draft — but left
 * unclamped it makes the distribution sum to something other than one and the result stops
 * being readable as points.
 */
function expectedInOneWeek(
  ordered: readonly DepthPlayer[],
  slots: number,
  replacement: number,
  byeWeek: number | null,
  /**
   * Multiplier on a null-bye player's availability — `(weeks - 1) / weeks` from the
   * caller. An unknown bye falls on *some* played week, so it discounts every week
   * uniformly rather than zeroing a known one; without this, missing bye data read as a
   * season of certain presence.
   */
  unknownByeDiscount: number,
): number {
  // `distribution[j]` — probability that exactly `j` of the players already walked past are
  // available. Starts as "none walked past, so zero are available, certainly".
  //
  // A mutation run reports the `total` initializer as a survivor, and it is equivalent
  // through the exported surface rather than a gap: `coverValue` consumes this only inside
  // two differences of two calls each, so a constant offset added to every call cancels
  // exactly.
  let distribution = [1];
  let total = 0;
  for (const player of ordered) {
    const available =
      player.byeWeek === null
        ? Math.min(Math.max(player.availability, 0), 1) * unknownByeDiscount
        : player.byeWeek === byeWeek
          ? 0
          : Math.min(Math.max(player.availability, 0), 1);
    let room = 0;
    for (let j = 0; j < Math.min(slots, distribution.length); j += 1) {
      room += distribution[j];
    }
    total += available * room * Math.max(player.value - replacement, 0);

    const next = new Array<number>(distribution.length + 1).fill(0);
    for (let j = 0; j < distribution.length; j += 1) {
      next[j] += distribution[j] * (1 - available);
      next[j + 1] += distribution[j] * available;
    }
    distribution = next;
  }
  return total;
}

/**
 * Expected weekly points from one position's slots, measured above replacement.
 *
 * The `slots * R` floor is left out because every caller subtracts two of these and it
 * cancels. What remains is the part that depends on who is actually rostered.
 *
 * Averaged over the season a week at a time, because a known bye is a certain absence in
 * one known week. Weeks nobody on this list is idle are identical, so they are evaluated
 * once and weighted; only the distinct known bye weeks cost an evaluation of their own. An
 * unknown bye has no week to evaluate — it rides through as the uniform availability
 * discount `expectedInOneWeek` applies, identical in every week by construction.
 *
 * Availabilities are clamped into `[0, 1]`. This runs inside a rollout, and a board row
 * carrying `1.0000000001` out of a division is not a reason to fail a draft — but left
 * unclamped it makes the distribution sum to something other than one and the result stops
 * being readable as points.
 */
function expectedAboveReplacement(
  players: readonly DepthPlayer[],
  slots: number,
  replacement: number,
  weeks: readonly number[],
): number {
  // A mutation run reports this guard's `<=` (as `<`) and its `0` return (as `1`) as
  // survivors; both are equivalent through `coverValue`, which guards `slots <= 0` itself
  // before calling — the zero-slot walk below contributes nothing anyway, and a changed
  // return for the empty-weeks case cancels in `coverValue`'s differences.
  if (slots <= 0 || weeks.length === 0) return 0;
  const ordered = [...players].sort((a, b) => b.value - a.value);
  const byes = new Set<number>();
  for (const player of ordered) {
    if (player.byeWeek !== null) byes.add(player.byeWeek);
  }
  // A bye week outside the season is not a bye anybody plays through. Counting it would
  // reserve a share of the average for a week that never happens.
  //
  // Membership in the week list, not `week <= weeks.length`. This argument answers two
  // questions — how many weeks the average is over, and which weeks exist — and a count
  // answers the second only because every season handed to it happens to run `1..n` from
  // week one. That is still true of the only production caller, so **this is not a bug
  // fix and nothing about the numbers changed**: `played.has(13)` rejects exactly the
  // weeks `13 <= 12` rejected. It is the coincidence being removed, so the next season
  // layout cannot quietly turn a length comparison into a wrong answer about which weeks
  // are played.
  //
  // What is *not* fixed, and is deliberate: byes in playoff rounds are still invisible
  // here, because the caller passes the regular season. See `PolicyLeague.weeks` for why,
  // and `docs/draft-validation.md` for what it costs.
  const played = new Set(weeks);
  const inSeason = [...byes].filter((week) => played.has(week));
  const ordinary = weeks.length - inSeason.length;
  // The expected value of "his bye is one of these weeks, uniformly": present in any
  // given week with `(n - 1) / n` of his availability. `weeks.length` is at least one
  // here — the zero case returned above — so the discount is a probability, not NaN.
  const unknownByeDiscount = (weeks.length - 1) / weeks.length;
  let total =
    expectedInOneWeek(ordered, slots, replacement, null, unknownByeDiscount) * ordinary;
  for (const week of inSeason) {
    total += expectedInOneWeek(ordered, slots, replacement, week, unknownByeDiscount);
  }
  return total / weeks.length;
}

/**
 * What a candidate adds at his position in the weeks somebody is unavailable.
 *
 * Zero when nobody at the position can be crowded out — a position with no starting slot,
 * or a candidate no better than replacement. Both are real states rather than degenerate
 * ones: a kicker in a league that starts no kicker must not acquire value from being scarce,
 * and a player at exactly replacement level is what you could have had for free.
 *
 * Floored at zero. The expression is a difference of two expectations and rounding can put it
 * a few parts in 10^15 below zero for a candidate who adds nothing; a negative depth value
 * would rank him below an empty roster spot, which is not a choice the draft offers.
 */
export function coverValue(
  rosterAtPosition: readonly DepthPlayer[],
  candidate: DepthPlayer,
  slots: number,
  replacement: number,
  /**
   * The weeks the average is taken over, by number rather than as a count.
   *
   * Both a denominator and the set a bye is tested for membership in. Those were one
   * argument doing two jobs while every season ran `1..n`; the list keeps them honest, and
   * makes a caller state which weeks it means rather than how many there are.
   */
  weeks: readonly number[],
): number {
  // `<` survives a mutation run here, and it is equivalent one mutant at a time: with
  // this shortcut skipped at exactly zero slots, `expectedAboveReplacement`'s own
  // `slots <= 0` guard returns zero for all four calls before anything is walked, and
  // `Math.max(0 - 0, 0)` is the same zero this line returns. The two guards vouch for
  // each other — which is fine under single-mutant testing and worth knowing if either
  // is ever removed.
  if (slots <= 0) return 0;
  const withHim = [...rosterAtPosition, candidate];
  // "Certain" is the world the lineup solver already priced: everybody present, every week.
  // Byes go with the availabilities, because a bye is an absence and the solver does not
  // know about it either. "Present every week" is a *known* bye in a week no league plays
  // — zero, which no `weeks` list contains — and deliberately not null: null now means
  // "unknown" and is charged an expected absent week, which would smuggle the very
  // absences this baseline exists to exclude back into it.
  const certain = (players: readonly DepthPlayer[]) =>
    expectedAboveReplacement(
      players.map((player) => ({
        value: player.value,
        availability: 1,
        byeWeek: 0,
      })),
      slots,
      replacement,
      weeks,
    );
  const stochasticGain =
    expectedAboveReplacement(withHim, slots, replacement, weeks) -
    expectedAboveReplacement(rosterAtPosition, slots, replacement, weeks);
  const certainGain = certain(withHim) - certain(rosterAtPosition);
  return Math.max(stochasticGain - certainGain, 0);
}
