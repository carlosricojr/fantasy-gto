import { type RosterSlot, solveLineup } from "./optimizer";
import { type Rng, Z_90, createRng, standardNormal } from "./rng";

/**
 * What a roster is actually worth.
 *
 * The season-long valuation this replaces summed each player's projected points and
 * discounted anyone who did not fit the starting lineup by a hand-picked constant. That
 * objective is wrong in a way no amount of tuning fixes, because a fantasy roster does not
 * score the sum of its players. **Each week it scores the best legal lineup it can field
 * from whoever is available.** Value is a sum of maxima, and the two are not close:
 *
 *  - **A bench exists to be the maximum.** Its worth is the chance a starter is out times
 *    what the replacement saves, which is a derived quantity — not a weight to be guessed.
 *    `BENCH_VALUE_WEIGHT` was a symptom of the wrong objective, not a modeling choice.
 *  - **Bye weeks are a real constraint, not a footnote.** Two running backs sharing a bye
 *    means one week fielding nobody there. Summing season points cannot see it; a sum of
 *    weekly maxima sees it exactly, because that week's matching leaves the slot empty.
 *  - **An unfilled starting slot costs its whole contribution, every week.** No special
 *    rule is needed to stop the optimizer leaving one open — a zero in the matching says
 *    it.
 *  - **Jensen's inequality is load-bearing.** E[max] exceeds max[E], so a roster of volatile
 *    players with depth behind them is worth more than its expected points suggest. The
 *    old objective was blind to this by construction.
 *
 * Everything here is exact except the expectation, which is estimated by simulation. The
 * inner problem — the best legal lineup for a given week and a given set of available
 * players — is solved exactly by maximum-weight matching, never approximated.
 */

/** How a player's weekly scoring and availability are distributed. */
export interface PlayerRisk {
  id: string;
  name: string;
  position: string;
  /** Expected fantasy points in a week he plays. */
  weeklyMean: number;
  /**
   * Measured spread of actual/projected, as ratio quantiles. These come from the weekly
   * model's own backtest rather than being assumed.
   */
  p10: number;
  p90: number;
  /**
   * The week his team is idle, or `null` if unknown.
   *
   * Unknown is not "no bye". A null here used to mean the player played every simulated
   * week, which handed a free week of season value to exactly the rows with the worst
   * data behind them; `simulateAvailability` now charges an unknown bye as a
   * probabilistic absence instead — one assumed week per scenario, drawn from the
   * player's own stream.
   */
  byeWeek: number | null;
  /**
   * Probability he is fit in any given non-bye week, from his own availability history.
   * A player who has finished each of the last two seasons sits near 1.
   */
  availability: number;
  /**
   * Where the market drafts him, and how widely that varies.
   *
   * Not used by the season simulation, which does not care how a roster was assembled.
   * They live here because the draft layer needs the market's view of the same player and
   * a parallel type would have to be kept in step by hand. Optional, so a caller that only
   * simulates a season need not invent them.
   */
  adp?: number | null;
  adpStdev?: number | null;
}

export interface UtilityConfig {
  /** Fantasy weeks that count. Excludes the NFL weeks after the fantasy season ends. */
  weeks: readonly number[];
  /** Scenarios to simulate. */
  scenarios: number;
  /**
   * Expected length of an absence, in weeks.
   *
   * Injuries persist — a player out this week is likely out next week — and treating each
   * week as an independent coin flip would scatter absences thinly across the season
   * instead of clustering them. Clustering is what makes a backup valuable, so ignoring it
   * would undervalue depth, which is the very thing this objective exists to price.
   *
   * Judgement, not measurement, and marked as such.
   */
  meanAbsenceWeeks: number;
}

export interface RosterUtility {
  /** Expected total points across the fantasy season, from the best lineup each week. */
  expectedPoints: number;
  /**
   * The same mean before rounding.
   *
   * Exists so `marginalUtility` can subtract before rounding. The difference between two
   * rosters is often a fraction of a point where the totals are hundreds, so quantizing
   * both terms at 0.01 lands squarely on the quantity being measured.
   */
  rawExpectedPoints: number;
  /** Standard error of that estimate, so a comparison inside the noise is visible. */
  standardError: number;
  /** Expected points by week, which exposes bye-week holes directly. */
  expectedByWeek: number[];
  /** Expected count of starting slots left empty across the season. */
  expectedEmptySlots: number;
}

/**
 * Fits a lognormal to a player's measured outcome quantiles.
 *
 * The spread is expressed as ratios of actual to projected, so the shape is fitted on the
 * ratio and then rescaled to the player's own mean. It is renormalized so the mean of the
 * fitted distribution is the projection: the projection is calibrated to be a mean, and a
 * lognormal whose median matched it would systematically over-project.
 */
export function fitLognormal(p10: number, p90: number): { mu: number; sigma: number } {
  // Both floors are one-sided bounds rather than tuned values. `low` must be positive, or
  // `log` returns -Infinity and every draw from this fit is NaN; any positive value small
  // against a real quantile does equally well. `high` must exceed `low`, or sigma is zero
  // or negative; the multiplier only has to be the smallest step that guarantees it.
  const low = Math.max(p10, 1e-6);
  const high = Math.max(p90, low * 1.000001);
  const sigma = Math.log(high / low) / (2 * Z_90);
  const mu = (Math.log(high) + Math.log(low)) / 2;
  return { mu, sigma };
}

/**
 * A player's own random stream for one scenario.
 *
 * Per player rather than per roster, and this is what makes common random numbers
 * actually work. Sharing one stream across a roster ties every player's draws to how many
 * players precede him and to whether they happened to be fit — so adding a candidate, or
 * an unrelated player getting injured, shifted everyone else's numbers. Two rosters being
 * compared then differed by far more than the player under test, and the estimate of what
 * he was worth was a difference of two nearly independent samples.
 *
 * Measured before the fix: a player projected at zero points scored anywhere from -8.4 to
 * +12.7 depending only on the seed.
 *
 * Keying on the player id also means a player performs identically in a scenario however
 * he is reached — same team, different team, drafted a round earlier — which is both
 * correct and what lets two candidate rosters be compared under genuinely identical
 * conditions.
 */
function playerStream(playerId: string, seed: number, scenario: number): Rng {
  let hash = 0x811c9dc5;
  for (let i = 0; i < playerId.length; i += 1) {
    hash ^= playerId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Mixed rather than added, so nearby seeds and scenarios do not produce nearby streams.
  hash ^= Math.imul(seed >>> 0, 0x9e3779b1) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 0x85ebca6b) >>> 0;
  hash ^= Math.imul(scenario + 1, 0xc2b2ae35) >>> 0;
  return createRng((hash ^ (hash >>> 16)) >>> 0);
}

/** Draws one week's points for a player who is playing. */
function drawPoints(player: PlayerRisk, rng: Rng): number {
  const { mu, sigma } = fitLognormal(player.p10, player.p90);
  const ratio = Math.exp(mu + sigma * standardNormal(rng));
  // Renormalize so E[ratio] is 1 and therefore E[points] is the projection.
  const meanRatio = Math.exp(mu + (sigma * sigma) / 2);
  return Math.max(0, (player.weeklyMean * ratio) / meanRatio);
}

/**
 * Simulates a season of availability as a two-state chain per player.
 *
 * `q` is the chance of going down in a given week and `r` the chance of returning, chosen
 * so the long-run fit rate matches the player's own availability and absences last
 * `meanAbsenceWeeks` on average.
 *
 * A *known* bye is a certain absence in one known week. An *unknown* bye (`byeWeek:
 * null`) is not the absence of one: every team sits out a week, and reading null as
 * "plays every week" paid a free week of season value to exactly the players whose data
 * was worst — the #89.D subsidy. So a null bye is charged as a probabilistic absence in
 * an unknown week: each scenario draws one assumed bye week uniformly, from the player's
 * own stream, which keeps the expected cost at one week while admitting the week itself
 * is not known. The draw is per scenario and per player, so common random numbers still
 * hold — the same player misses the same assumed week in both rosters of a comparison.
 *
 * `byeCandidateWeeks` is where the assumed week may fall, defaulting to the whole
 * simulated span. A caller whose span includes weeks a real bye cannot occupy — the
 * season simulation appends the playoff bracket, where the league schedules no byes at
 * all — passes the narrower list, or the draw would charge bracket rounds a team fact
 * that cannot land there.
 *
 * One admitted limit: the draws are independent per player, so two unknown-bye teammates
 * — who in reality share one bye with certainty — collide only at 1/|candidates|.
 * `PlayerRisk` carries no team, so the correlation cannot be modeled here; after the
 * schedule-derivation fix, unknown byes are rare enough (teamless rows only) that the
 * error is confined to players who may not have a shared team at all.
 */
export function simulateAvailability(
  player: PlayerRisk,
  weeks: readonly number[],
  meanAbsenceWeeks: number,
  rng: Rng,
  byeCandidateWeeks: readonly number[] = weeks,
): boolean[] {
  const availability = Math.min(Math.max(player.availability, 0), 1);
  const r = 1 / Math.max(meanAbsenceWeeks, 1);

  // A player who never plays is a fixed state, not a chain — solving for `q` divides by
  // zero and yields Infinity. Returning before the assumed-bye draw keeps common random
  // numbers intact for a subtler reason than "nothing follows": point draws do follow on
  // this same stream, but the branch depends only on the player's own fields, so both
  // rosters of any comparison skip the bye draw together — and the skipped player's
  // points are never read, because he is available in no week.
  if (availability <= 0) return weeks.map(() => false);

  // Drawn before the chain starts, so a null-bye player consumes one extra draw whether
  // the chain runs or the `availability >= 1` shortcut does. `rng.next()` is on [0, 1),
  // so the index never reaches the candidate count.
  const candidates = byeCandidateWeeks.length > 0 ? byeCandidateWeeks : weeks;
  const byeWeek =
    player.byeWeek ?? candidates[Math.floor(rng.next() * candidates.length)] ?? null;

  if (availability >= 1) {
    return weeks.map((week) => week !== byeWeek);
  }

  // Steady state of the chain is r / (q + r); solve for q to hit the target rate. Clamped
  // because `q` is a probability: below roughly a quarter the unclamped solution exceeds
  // one, at which point `rng.next() >= q` is never true, the player goes down every week
  // regardless, and the realized rate stops matching the target it was solved for. The
  // board does not currently produce a value that low — `shrunkAvailability` floors near
  // 0.31 — but this is a public function and the invariant should hold for any caller.
  const q = Math.min((r * (1 - availability)) / availability, 1);

  // The comparisons below are `>=` and `<` rather than `>` and `<=` only by convention:
  // `rng.next()` is continuous on [0, 1), so the two forms differ on an event of measure
  // zero. A mutation run flags swapping them as a surviving change, and it is right that
  // no test can tell them apart — that pair is genuinely equivalent, not a coverage gap.
  const out: boolean[] = [];
  let healthy = rng.next() < availability;
  for (const week of weeks) {
    healthy = healthy ? rng.next() >= q : rng.next() < r;
    out.push(healthy && week !== byeWeek);
  }
  return out;
}

/**
 * One scenario's weekly scores for a roster: the best legal lineup it can field each week.
 *
 * Exported because the league simulation needs exactly this, per team, and duplicating it
 * would let the two drift apart — the whole point is that a team's score is computed the
 * same way whether it is yours or an opponent's.
 */
export function drawWeek(
  roster: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
  weeks: readonly number[],
  meanAbsenceWeeks: number,
  seed: number,
  scenario: number,
  /** Where an unknown bye may fall — see `simulateAvailability`. */
  byeCandidateWeeks: readonly number[] = weeks,
): number[] {
  // Every player draws his availability and his points for every week, from his own
  // stream, before anything is filtered. Drawing only for the weeks he turns out to be fit
  // would make how much randomness he consumes depend on the result of the randomness, and
  // that is precisely what desynchronized the comparison.
  const draws = roster.map((player) => {
    const rng = playerStream(player.id, seed, scenario);
    const available = simulateAvailability(
      player,
      weeks,
      meanAbsenceWeeks,
      rng,
      byeCandidateWeeks,
    );
    const points = weeks.map(() => drawPoints(player, rng));
    return { player, available, points };
  });

  return weeks.map((_, w) => {
    const playing = draws
      .filter((entry) => entry.available[w])
      .map((entry) => ({
        id: entry.player.id,
        name: entry.player.name,
        position: entry.player.position,
        projectedPoints: entry.points[w],
        availability: "active" as const,
      }));
    return solveLineup(slots, playing).totalPoints;
  });
}

/**
 * Expected season points from fielding the best legal lineup each week.
 *
 * `rng` is supplied by the caller so two rosters can be compared under identical
 * scenarios. That is not a convenience: independently estimated expectations differ by
 * more than the effect being measured at any practical sample size, and shared scenarios
 * remove almost all of that noise from the difference.
 */
export function rosterUtility(
  roster: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
  config: UtilityConfig,
  seed: number,
): RosterUtility {
  // Checked here rather than left to the division at the end. A zero or fractional count
  // runs the sampling loop zero times — or a fractional number of times, which is the same
  // thing — and every figure comes back as 0/0. `simulateLeague` already refuses exactly
  // this, and the two are called from the same places with the same config; the one that
  // did not check returned a table of `NaN` that renders as an empty cell.
  if (!Number.isInteger(config.scenarios) || config.scenarios < 1) {
    throw new Error(
      `A roster cannot be valued over ${config.scenarios} scenario(s). Every figure ` +
        `would be a division by zero.`,
    );
  }
  if (roster.length === 0) {
    return {
      expectedPoints: 0,
      rawExpectedPoints: 0,
      standardError: 0,
      expectedByWeek: config.weeks.map(() => 0),
      expectedEmptySlots: slots.length * config.weeks.length,
    };
  }

  const weekTotals = config.weeks.map(() => 0);
  let emptySlotTotal = 0;
  let sum = 0;
  let sumOfSquares = 0;

  for (let scenario = 0; scenario < config.scenarios; scenario += 1) {
    const weekly = drawWeek(
      roster,
      slots,
      config.weeks,
      config.meanAbsenceWeeks,
      seed,
      scenario,
    );

    let seasonTotal = 0;
    for (let w = 0; w < config.weeks.length; w += 1) {
      seasonTotal += weekly[w];
      weekTotals[w] += weekly[w];
    }
    emptySlotTotal += countEmptySlots(roster, slots, config, seed, scenario);

    sum += seasonTotal;
    sumOfSquares += seasonTotal * seasonTotal;
  }

  const n = config.scenarios;
  const mean = sum / n;
  const variance = Math.max(0, sumOfSquares / n - mean * mean);
  return {
    expectedPoints: round2(mean),
    // Unrounded, for `marginalUtility`. Reported values stay rounded; a difference of two
    // rounded values does not, because the quantity it measures is far smaller than the
    // terms it comes from.
    rawExpectedPoints: mean,
    standardError: round2(Math.sqrt(variance / n)),
    expectedByWeek: weekTotals.map((total) => round2(total / n)),
    expectedEmptySlots: round2(emptySlotTotal / n),
  };
}

/**
 * What adding a player to a roster is worth, under identical scenarios.
 *
 * Both rosters are evaluated from the same seed, so the difference reflects the player
 * rather than the draw. Estimating them independently and subtracting would produce a
 * number whose noise exceeds the quantity being measured.
 */
export function marginalUtility(
  roster: readonly PlayerRisk[],
  candidate: PlayerRisk,
  slots: readonly RosterSlot[],
  config: UtilityConfig,
  seed: number,
): number {
  // Subtracted before rounding. Season totals are hundreds of points and a deep-bench
  // marginal value can be a fraction of one, so rounding both terms to two decimals first
  // put 0.01 of quantization directly on the quantity being measured — the thing common
  // random numbers exist to resolve.
  const without = rosterUtility(roster, slots, config, seed);
  const with_ = rosterUtility([...roster, candidate], slots, config, seed);
  return round2(with_.rawExpectedPoints - without.rawExpectedPoints);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Starting slots left unfilled in one scenario.
 *
 * Recomputed from the same streams rather than accumulated inside `drawWeek`, so that
 * function returns only what its name says. The streams are keyed on the player, so this
 * sees exactly the same draws.
 */
function countEmptySlots(
  roster: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
  config: UtilityConfig,
  seed: number,
  scenario: number,
): number {
  const draws = roster.map((player) => {
    const rng = playerStream(player.id, seed, scenario);
    return {
      player,
      available: simulateAvailability(player, config.weeks, config.meanAbsenceWeeks, rng),
    };
  });

  let empty = 0;
  for (let w = 0; w < config.weeks.length; w += 1) {
    const playing = draws
      .filter((entry) => entry.available[w])
      .map((entry) => ({
        id: entry.player.id,
        name: entry.player.name,
        position: entry.player.position,
        // Any constant does; only which slots fill is being counted, and `solveLineup`
        // seats an eligible player whatever he is worth. Deliberately not the player's
        // projection, so this cannot be misread as a points calculation.
        projectedPoints: 1,
        availability: "active" as const,
      }));
    empty += solveLineup(slots, playing).assignments.filter(
      (a) => a.competitorId === null,
    ).length;
  }
  return empty;
}
