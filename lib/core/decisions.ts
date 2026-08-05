/**
 * Decision-quality metrics.
 *
 * Mean absolute error is the wrong instrument for what this product is actually for.
 * Start/sit is a **pairwise choice** and drafting is a **ranking**; neither is a question
 * about the size of an error. A model can move MAE without changing a single decision a
 * user would make, and can flip a great many decisions while MAE sits still — reduce every
 * projection by a constant and MAE moves while every ordering is untouched.
 *
 * So these measure what the interface is graded on. Two things:
 *
 * **Pairwise accuracy.** Given two players a user must choose between, does the model rank
 * the one who actually scored more first, and what does being wrong cost? Stratified by the
 * size of the projected gap, because a model that only gets the obvious calls right has
 * told you nothing: those are the calls you did not need it for.
 *
 * **Lineup regret.** Points left on the bench against a lineup set with perfect hindsight.
 * This is the metric that matches what `/lineup` delivers, since the optimizer's guarantee
 * is about slot assignment given projections, not about the projections themselves.
 *
 * Sport-agnostic, and pure. Both estimators return per-observation rows so the caller can
 * hand them to `pairedComparison` and get a clustered interval rather than a bare rate.
 */

import { type LineupSolution, type OptimizableCompetitor, type RosterSlot, solveLineup } from "./optimizer";

/** One competitor in one scoring period, with what was predicted and what happened. */
export interface Outcome {
  competitorId: string;
  /** The unit decisions are made within: a single week, a single position. */
  groupId: string;
  predicted: number;
  actual: number;
}

/** One head-to-head choice, resolved. */
export interface PairwiseDecision {
  /** The cluster the pair belongs to. Both players are in it; see `pairClusterId`. */
  cluster: string;
  /** How far apart the two projections were. The axis difficulty is measured along. */
  projectedGap: number;
  /** How far apart the two outcomes were. Zero when the week was a genuine tie. */
  actualGap: number;
  /** True when the higher-projected player did score more. */
  correct: boolean;
  /**
   * Points given up by following the model, and zero when it was right.
   *
   * The quantity a user actually feels. A wrong call on two players who finished a point
   * apart is not the same mistake as a wrong call on two who finished twenty apart, and a
   * raw accuracy rate cannot tell them apart.
   */
  forgone: number;
}

export interface PairwiseSummary {
  pairs: number;
  /** Share of pairs the predictor ordered correctly, ties excluded. */
  accuracy: number;
  /** Mean points given up across **all** pairs, including the ones it got right. */
  meanForgone: number;
  /** Mean points given up across the pairs it got wrong. */
  meanForgoneWhenWrong: number;
}

/**
 * Every within-group pair, resolved against what happened.
 *
 * Pairs are formed inside a group — one week, one position — because those are the choices
 * a lineup actually poses. Comparing a Week 3 tight end against a Week 11 quarterback is a
 * decision nobody makes, and including such pairs would pad the accuracy rate with
 * comparisons that are easy for reasons unrelated to the model.
 *
 * A pair whose outcomes are exactly equal is dropped rather than scored. There is no right
 * answer to grade against, and counting it either way moves the rate without meaning.
 */
export function pairwiseDecisions(outcomes: readonly Outcome[]): PairwiseDecision[] {
  const groups = new Map<string, Outcome[]>();
  for (const outcome of outcomes) {
    const bucket = groups.get(outcome.groupId) ?? [];
    bucket.push(outcome);
    groups.set(outcome.groupId, bucket);
  }

  const decisions: PairwiseDecision[] = [];
  for (const bucket of [...groups.values()]) {
    // Sorted so pair order is a property of the data rather than of input order — the same
    // reason the optimizer sorts before building its matrix.
    const ordered = [...bucket].sort((a, b) =>
      a.competitorId < b.competitorId ? -1 : a.competitorId > b.competitorId ? 1 : 0,
    );
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i];
        const b = ordered[j];
        if (a.actual === b.actual) continue;

        const favoured = a.predicted >= b.predicted ? a : b;
        const other = favoured === a ? b : a;
        const correct = favoured.actual > other.actual;
        decisions.push({
          cluster: pairClusterId(a.competitorId, b.competitorId),
          projectedGap: Math.abs(a.predicted - b.predicted),
          actualGap: Math.abs(a.actual - b.actual),
          correct,
          forgone: correct ? 0 : other.actual - favoured.actual,
        });
      }
    }
  }
  return decisions;
}

/**
 * The cluster a pair belongs to.
 *
 * Both players recur across weeks, so neither one alone is the unit of independence — and
 * the pairs themselves are not independent either, since one player's bad season correlates
 * every pair he appears in. Keying on the unordered pair is the honest compromise available
 * without a multi-way clustered estimator: it stops the same two players being counted as
 * seventeen independent verdicts, which is the largest of the dependencies.
 *
 * It does not remove all of it. An interval built on this is still optimistic, and that is
 * stated wherever one is published rather than left for a reader to work out.
 */
export function pairClusterId(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function summarizePairwise(
  decisions: readonly PairwiseDecision[],
): PairwiseSummary {
  if (decisions.length === 0) {
    return { pairs: 0, accuracy: Number.NaN, meanForgone: Number.NaN, meanForgoneWhenWrong: Number.NaN };
  }
  const wrong = decisions.filter((d) => !d.correct);
  const total = decisions.reduce((sum, d) => sum + d.forgone, 0);
  return {
    pairs: decisions.length,
    accuracy: (decisions.length - wrong.length) / decisions.length,
    meanForgone: total / decisions.length,
    meanForgoneWhenWrong: wrong.length === 0 ? 0 : total / wrong.length,
  };
}

/**
 * Splits decisions by how close the call was.
 *
 * The stratification is the point of the whole metric. Overall pairwise accuracy is
 * dominated by pairs nobody would hesitate over, and two models that differ only on the
 * hard calls will look nearly identical on the pooled rate while differing exactly where a
 * user needs help.
 *
 * `edges` are upper bounds on the projected gap, ascending. The final stratum collects
 * everything above the last edge.
 */
export function stratifyByGap(
  decisions: readonly PairwiseDecision[],
  edges: readonly number[],
): Array<{ label: string; upperBound: number; summary: PairwiseSummary }> {
  const strata: Array<{ label: string; upperBound: number; summary: PairwiseSummary }> = [];
  let lower = 0;
  for (const edge of edges) {
    const inside = decisions.filter(
      (d) => d.projectedGap >= lower && d.projectedGap < edge,
    );
    strata.push({
      label: `${lower.toFixed(1)}–${edge.toFixed(1)}`,
      upperBound: edge,
      summary: summarizePairwise(inside),
    });
    lower = edge;
  }
  strata.push({
    label: `${lower.toFixed(1)}+`,
    upperBound: Number.POSITIVE_INFINITY,
    summary: summarizePairwise(decisions.filter((d) => d.projectedGap >= lower)),
  });
  return strata;
}

/** What a lineup set on projections gave up against one set with hindsight. */
export interface LineupRegret {
  /** The scoring period. */
  groupId: string;
  /** Points the chosen lineup actually scored. */
  achieved: number;
  /** Points the best legal lineup would have scored, known only afterwards. */
  best: number;
  /** `best - achieved`. Never negative: the hindsight lineup is optimal by construction. */
  regret: number;
}

/**
 * Regret against a perfect-hindsight lineup, for one roster in one period.
 *
 * Both lineups are solved by the same optimizer. That is deliberate — the difference
 * measured is entirely down to the projections, because the assignment step is identical
 * and provably optimal on both sides. Comparing an optimally-assigned projection against a
 * greedily-assigned hindsight lineup would credit the projections for the solver's work.
 *
 * The achieved score is the *actual* points of the players the projection-driven lineup
 * started, not their projected points. Scoring a lineup by what it was predicted to do
 * would make a confidently wrong model look flawless.
 */
export function lineupRegret(
  groupId: string,
  slots: readonly RosterSlot[],
  roster: readonly OptimizableCompetitor[],
  actualPoints: ReadonlyMap<string, number>,
): LineupRegret {
  const chosen = solveLineup(slots, roster);
  const hindsight = solveLineup(
    slots,
    roster.map((player) => ({
      ...player,
      projectedPoints: actualPoints.get(player.id) ?? 0,
    })),
  );

  const scoreOf = (solution: LineupSolution) =>
    solution.assignments.reduce(
      (sum, a) => sum + (a.competitorId ? (actualPoints.get(a.competitorId) ?? 0) : 0),
      0,
    );

  const achieved = scoreOf(chosen);
  const best = scoreOf(hindsight);
  return {
    groupId,
    achieved,
    best,
    // Clamped at zero. The hindsight lineup maximises actual points by construction, so a
    // negative value is impossible and would mean the solver disagreed with itself; the
    // clamp keeps a solver bug from surfacing as a flattering statistic.
    regret: Math.max(0, best - achieved),
  };
}
