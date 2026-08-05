import type { Contribution, Period, Projection } from "../../core/domain";
import { round2, scoreOffense } from "../scoring/score";
import type { Position, ScoringRules } from "../scoring/types";
import type { PlayerWeek } from "../stats/parse";

import {
  CALIBRATION,
  DEFAULT_MODEL_CONFIG,
  DVP_FACTOR_MAX,
  DVP_FACTOR_MIN,
  EFFICIENCY_PRIOR,
  EFFICIENCY_SHRINKAGE,
  LEAGUE_MEAN_IMPLIED_TEAM_TOTAL,
  MODEL_VERSION,
  type ModelConfig,
  OUTCOME_QUANTILES,
  VEGAS_RATIO_MAX,
  VEGAS_RATIO_MIN,
  clamp,
} from "./config";

/**
 * The projection model.
 *
 * Pure: no network, no clock, no database. Every time-varying input is passed in, which is
 * what allows the backtest to replay historical weeks exactly and what makes the whole
 * model unit-testable.
 *
 * The published accuracy figure belongs to this function with the constants in
 * `config.ts`. See `docs/model-validation.md`.
 */

/**
 * Exponentially weighted mean, most recent observation last.
 *
 * The most recent value carries weight 1 and each step back is multiplied by
 * `(1 - alpha)`. Normalizing by the summed weights keeps the result on the same scale as
 * the inputs regardless of how many observations exist, so a player with three games and a
 * player with fifteen are directly comparable.
 */
export function ema(values: readonly number[], alpha: number): number {
  if (values.length === 0) return 0;
  let weighted = 0;
  let weight = 0;
  const last = values.length - 1;
  for (let i = 0; i < values.length; i += 1) {
    const w = (1 - alpha) ** (last - i);
    weighted += w * values[i];
    weight += w;
  }
  return weight === 0 ? 0 : weighted / weight;
}

/** Game context for the week being projected. */
export interface GameContext {
  opponent: string | null;
  /**
   * Points this team is implied to score, from the market total and spread.
   * `null` when no line is posted.
   */
  impliedTeamTotal: number | null;
  /**
   * This team's own average implied total across the weeks **already played**.
   *
   * The Vegas adjustment is measured against this rather than the league average.
   * Sweeping showed league-relative scaling is worth almost nothing at its best weight and
   * degrades steeply beyond it, ending worse than omitting the term, while the
   * team-relative form has a clear optimum: a player on a strong offense already carries
   * that strength in their own scoring history, so scaling by team quality again counts it
   * twice. See `docs/model-validation.md`.
   *
   * It must exclude the week being projected and everything after it — see
   * `meanImpliedTotalBefore`. Averaging the whole season is lookahead bias, and it
   * inflated this model's reported accuracy until it was caught in review.
   *
   * `null` when there is no prior week, in which case the league mean is used.
   */
  teamMeanImpliedTotal: number | null;
}

export interface ProjectionInput {
  competitorId: string;
  position: Position;
  period: Period;
  /** Prior weeks only, chronological. Any same-week data here would be leakage. */
  history: readonly PlayerWeek[];
  game: GameContext | null;
  scoring: ScoringRules;
  /**
   * Opponent defense-vs-position factors, keyed `TEAM:POS`, built from a prior season.
   * A missing entry is treated as neutral.
   */
  defenseFactors?: ReadonlyMap<string, number>;
  /**
   * Parameter overrides. Only the backtest's sweep mode supplies this; application code
   * must not, because the published accuracy figure belongs to the default configuration.
   */
  config?: ModelConfig;
}

/** Opportunity units that drive scoring, by position. */
function opportunityFor(week: PlayerWeek, position: Position): number {
  switch (position) {
    case "QB":
      return week.usage.passAttempts;
    case "RB":
      return week.usage.carries + week.usage.targets;
    case "WR":
    case "TE":
      return week.usage.targets;
    default:
      return 0;
  }
}

/**
 * Estimates production from opportunity rather than from points directly.
 *
 * Volume is more stable week to week than fantasy points, so this term carries signal the
 * points EMA misses — particularly for a player whose role has grown while their scoring
 * has not yet caught up. Efficiency is shrunk toward a positional prior so a player with
 * one lucky touchdown does not project as permanently elite.
 *
 * Returns `null` for positions with no meaningful opportunity metric.
 */
function usageImpliedPoints(
  history: readonly PlayerWeek[],
  position: Position,
  scoring: ScoringRules,
  alpha: number,
): number | null {
  const prior = EFFICIENCY_PRIOR[position];
  if (prior === 0 || history.length === 0) return null;

  const opportunities = history.map((week) => opportunityFor(week, position));
  const expectedOpportunity = ema(opportunities, alpha);
  if (expectedOpportunity <= 0) return null;

  const observed: number[] = [];
  for (const week of history) {
    const opportunity = opportunityFor(week, position);
    if (opportunity > 0) {
      observed.push(scoreOffense(week.stats, scoring).total / opportunity);
    }
  }

  const efficiency =
    (observed.reduce((sum, value) => sum + value, 0) + EFFICIENCY_SHRINKAGE * prior) /
    (observed.length + EFFICIENCY_SHRINKAGE);

  return expectedOpportunity * efficiency;
}

function pushContribution(
  into: Contribution[],
  key: string,
  label: string,
  points: number,
  detail: string,
): void {
  const rounded = round2(points);
  if (rounded === 0) return;
  into.push({ key, label, points: rounded, detail });
}

/**
 * Produces a projection with an itemized explanation.
 *
 * Contributions are accumulated as deltas from the preceding step, so they sum exactly to
 * the mean by construction. The mean is then derived from that sum rather than computed
 * separately, which makes an unexplained residual structurally impossible.
 */
export function projectPlayer(input: ProjectionInput): Projection {
  const { competitorId, position, period, history, game, scoring } = input;
  const config = input.config ?? DEFAULT_MODEL_CONFIG;
  const contributions: Contribution[] = [];

  const points = history.map((week) => scoreOffense(week.stats, scoring).total);
  const base = ema(points, config.emaAlpha);

  pushContribution(
    contributions,
    "base.form",
    "Recent production",
    base,
    history.length > 0
      ? `Weighted average of ${history.length} prior game${history.length === 1 ? "" : "s"}, favoring recent weeks.`
      : "No prior games, so no projection can be formed yet.",
  );

  let running = base;

  // Usage: blend toward an opportunity-derived estimate as history accumulates.
  const usagePoints = usageImpliedPoints(history, position, scoring, config.emaAlpha);
  if (usagePoints !== null) {
    const weight = Math.min(config.usageWeightCap, 0.15 * history.length);
    const blended = (1 - weight) * running + weight * usagePoints;
    const delta = blended - running;
    pushContribution(
      contributions,
      "usage.opportunity",
      "Usage trend",
      delta,
      delta >= 0
        ? "Recent volume — attempts, carries, and targets — points to more production than raw scoring shows."
        : "Recent opportunity is below what this player's scoring implies.",
    );
    running = blended;
  }

  // Vegas: scale by how this game's implied total compares to the team's own norm.
  if (game?.impliedTeamTotal != null && config.vegasWeight !== 0) {
    const reference =
      config.vegasReference === "league"
        ? LEAGUE_MEAN_IMPLIED_TEAM_TOTAL
        : (game.teamMeanImpliedTotal ?? LEAGUE_MEAN_IMPLIED_TEAM_TOTAL);
    if (reference > 0) {
      const ratio = clamp(
        game.impliedTeamTotal / reference,
        VEGAS_RATIO_MIN,
        VEGAS_RATIO_MAX,
      );
      const adjusted = running * (1 + config.vegasWeight * (ratio - 1));
      const delta = adjusted - running;
      pushContribution(
        contributions,
        "context.vegas",
        "Game environment",
        delta,
        delta >= 0
          ? `Betting markets expect a higher-scoring game than this team's average (${game.impliedTeamTotal.toFixed(1)} implied points).`
          : `Betting markets expect a lower-scoring game than this team's average (${game.impliedTeamTotal.toFixed(1)} implied points).`,
      );
      running = adjusted;
    }
  }

  // Opponent: shrunk defense-vs-position factor.
  if (game?.opponent && input.defenseFactors && config.dvpWeight !== 0) {
    const raw = input.defenseFactors.get(`${game.opponent}:${position}`);
    if (raw !== undefined) {
      const factor = clamp(raw, DVP_FACTOR_MIN, DVP_FACTOR_MAX);
      const adjusted = running * (1 + config.dvpWeight * (factor - 1));
      const delta = adjusted - running;
      pushContribution(
        contributions,
        "context.matchup",
        "Matchup",
        delta,
        delta >= 0
          ? `${game.opponent} has conceded more than average to ${position}s.`
          : `${game.opponent} has conceded less than average to ${position}s.`,
      );
      running = adjusted;
    }
  }

  // Calibration: correct the model's known tendency to project high.
  const calibration = config.calibrate ? CALIBRATION[position] : 1;
  if (calibration !== 1) {
    const adjusted = running * calibration;
    pushContribution(
      contributions,
      "model.calibration",
      "Regression adjustment",
      adjusted - running,
      "Corrects the model's measured tendency to over-project players coming off strong stretches.",
    );
    running = adjusted;
  }

  const mean = round2(contributions.reduce((sum, c) => sum + c.points, 0));
  const band = OUTCOME_QUANTILES[position];

  return {
    competitorId,
    period,
    position,
    mean,
    // The band multiplies the mean, so a negative mean would swap the two: the floor
    // clamps at 0 while the ceiling stays below it, inverting the `floor <= mean <=
    // ceiling` invariant that `lib/core/domain.ts` documents and the projections page
    // renders as a range. `scoreOffense` really can go negative — interceptions and lost
    // fumbles with no production — so this is reachable, not theoretical.
    floor: round2(Math.min(mean, Math.max(0, mean * band.p10))),
    ceiling: round2(Math.max(mean, mean * band.p90)),
    contributions,
    modelVersion: MODEL_VERSION,
  };
}

/**
 * Builds shrunk defense-vs-position factors from completed weeks.
 *
 * A factor above 1 means the defense concedes more than average to that position. Raw
 * ratios on small samples are extremely noisy, so each is pulled toward neutral with
 * strength `DVP_SHRINKAGE`; a defense with few observations scores near 1.0 regardless of
 * how extreme its raw average looks.
 *
 * Callers must supply a *prior* season's weeks. Building factors from the season being
 * projected would leak future information into the projection.
 */
export function buildDefenseFactors(
  weeks: readonly PlayerWeek[],
  scoring: ScoringRules,
  shrinkage: number,
): Map<string, number> {
  const byPosition = new Map<string, number[]>();
  const byMatchup = new Map<string, number[]>();

  for (const week of weeks) {
    const opponent = week.opponent;
    if (!opponent) continue;
    const position = week.competitor.position;
    const points = scoreOffense(week.stats, scoring).total;

    const positionBucket = byPosition.get(position) ?? [];
    positionBucket.push(points);
    byPosition.set(position, positionBucket);

    const key = `${opponent}:${position}`;
    const matchupBucket = byMatchup.get(key) ?? [];
    matchupBucket.push(points);
    byMatchup.set(key, matchupBucket);
  }

  const positionMean = new Map<string, number>();
  for (const [position, values] of byPosition) {
    positionMean.set(
      position,
      values.reduce((sum, value) => sum + value, 0) / values.length,
    );
  }

  const factors = new Map<string, number>();
  for (const [key, values] of byMatchup) {
    const position = key.slice(key.indexOf(":") + 1);
    const league = positionMean.get(position);
    if (!league || league <= 0) continue;
    const observed = values.reduce((sum, value) => sum + value, 0) / values.length;
    const raw = observed / league;
    factors.set(key, (values.length * raw + shrinkage) / (values.length + shrinkage));
  }

  return factors;
}

/** A team's market-implied points for one week, used to build its own baseline. */
export interface ImpliedTotalEntry {
  week: number;
  impliedTotal: number;
}

/**
 * A team's average implied total over the weeks *before* the one being projected.
 *
 * The Vegas adjustment measures this week's implied total against the team's own norm.
 * That norm has to be computed from weeks already played: averaging the whole season would
 * let a team's later form leak into an earlier projection, which inflates backtest accuracy
 * by using information that did not exist at prediction time.
 *
 * Returns `null` when there is no prior week, so the caller falls back to the league mean
 * rather than silently comparing a team against itself with a sample of one.
 */
export function meanImpliedTotalBefore(
  entries: readonly ImpliedTotalEntry[],
  week: number,
): number | null {
  let sum = 0;
  let count = 0;
  for (const entry of entries) {
    if (entry.week >= week) continue;
    sum += entry.impliedTotal;
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

/**
 * Derives a team's implied points from a market line.
 *
 * `spread` is from the home team's perspective: positive means the home team is favored.
 * Getting this backwards silently inverts every game-environment adjustment, so it is
 * asserted directly in the tests.
 */
export function impliedTeamTotal(
  total: number | null,
  spread: number | null,
  team: string,
  homeTeam: string,
  awayTeam: string,
): number | null {
  if (total === null || total <= 0) return null;
  const margin = spread ?? 0;
  if (team === homeTeam) return total / 2 + margin / 2;
  if (team === awayTeam) return total / 2 - margin / 2;
  return null;
}
