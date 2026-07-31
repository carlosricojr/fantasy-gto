import { type RosterSlot, solveLineup } from "./optimizer";
import { type Rng, Z_90, standardNormal } from "./rng";

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
 *    `BENCH_VALUE_WEIGHT` was a symptom of the wrong objective, not a modelling choice.
 *  - **Bye weeks are a real constraint, not a footnote.** Two running backs sharing a bye
 *    means one week fielding nobody there. Summing season points cannot see it; a sum of
 *    weekly maxima sees it exactly, because that week's matching leaves the slot empty.
 *  - **An unfilled starting slot costs its whole contribution, every week.** No special
 *    rule is needed to stop the optimiser leaving one open — a zero in the matching says
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
  /** The week his team is idle, or `null` if unknown. */
  byeWeek: number | null;
  /**
   * Probability he is fit in any given non-bye week, from his own availability history.
   * A player who has finished each of the last two seasons sits near 1.
   */
  availability: number;
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

export const DEFAULT_UTILITY_CONFIG: Omit<UtilityConfig, "weeks"> = {
  scenarios: 200,
  meanAbsenceWeeks: 3,
};

export interface RosterUtility {
  /** Expected total points across the fantasy season, from the best lineup each week. */
  expectedPoints: number;
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
 * ratio and then rescaled to the player's own mean. It is renormalised so the mean of the
 * fitted distribution is the projection: the projection is calibrated to be a mean, and a
 * lognormal whose median matched it would systematically over-project.
 */
export function fitLognormal(p10: number, p90: number): { mu: number; sigma: number } {
  const low = Math.max(p10, 1e-6);
  const high = Math.max(p90, low * 1.000001);
  const sigma = Math.log(high / low) / (2 * Z_90);
  const mu = (Math.log(high) + Math.log(low)) / 2;
  return { mu, sigma };
}

/** Draws one week's points for a player who is playing. */
function drawPoints(player: PlayerRisk, rng: Rng): number {
  const { mu, sigma } = fitLognormal(player.p10, player.p90);
  const ratio = Math.exp(mu + sigma * standardNormal(rng));
  // Renormalise so E[ratio] is 1 and therefore E[points] is the projection.
  const meanRatio = Math.exp(mu + (sigma * sigma) / 2);
  return Math.max(0, (player.weeklyMean * ratio) / meanRatio);
}

/**
 * Simulates a season of availability as a two-state chain per player.
 *
 * `q` is the chance of going down in a given week and `r` the chance of returning, chosen
 * so the long-run fit rate matches the player's own availability and absences last
 * `meanAbsenceWeeks` on average.
 */
function simulateAvailability(
  player: PlayerRisk,
  weeks: readonly number[],
  meanAbsenceWeeks: number,
  rng: Rng,
): boolean[] {
  const availability = Math.min(Math.max(player.availability, 0), 1);
  const r = 1 / Math.max(meanAbsenceWeeks, 1);
  // Steady state of the chain is r / (q + r); solve for q to hit the target rate.
  const q = availability >= 1 ? 0 : (r * (1 - availability)) / availability;

  const out: boolean[] = [];
  let healthy = rng.next() < availability;
  for (const week of weeks) {
    healthy = healthy ? rng.next() >= q : rng.next() < r;
    out.push(healthy && week !== player.byeWeek);
  }
  return out;
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
  rng: Rng,
): RosterUtility {
  if (roster.length === 0) {
    return {
      expectedPoints: 0,
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
    const availability = roster.map((player) =>
      simulateAvailability(player, config.weeks, config.meanAbsenceWeeks, rng),
    );

    let seasonTotal = 0;
    for (let w = 0; w < config.weeks.length; w += 1) {
      // Only players who are fit and not on bye can be assigned. Everyone else is simply
      // absent from the matching, which is what makes a bye collision cost what it costs.
      const playing = roster
        .map((player, index) => ({ player, available: availability[index][w] }))
        .filter((entry) => entry.available)
        .map((entry) => ({
          id: entry.player.id,
          name: entry.player.name,
          position: entry.player.position,
          projectedPoints: drawPoints(entry.player, rng),
          availability: "active" as const,
        }));

      const solution = solveLineup(slots, playing);
      seasonTotal += solution.totalPoints;
      weekTotals[w] += solution.totalPoints;
      emptySlotTotal += solution.assignments.filter(
        (a) => a.competitorId === null,
      ).length;
    }

    sum += seasonTotal;
    sumOfSquares += seasonTotal * seasonTotal;
  }

  const n = config.scenarios;
  const mean = sum / n;
  const variance = Math.max(0, sumOfSquares / n - mean * mean);
  return {
    expectedPoints: round2(mean),
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
  createRng: (seed: number) => Rng,
): number {
  const without = rosterUtility(roster, slots, config, createRng(seed));
  const with_ = rosterUtility([...roster, candidate], slots, config, createRng(seed));
  return round2(with_.expectedPoints - without.expectedPoints);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
