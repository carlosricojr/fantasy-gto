import { describe, expect, it } from "vitest";

import {
  type Outcome,
  lineupRegret,
  pairClusterId,
  pairwiseDecisions,
  stratifyByGap,
  summarizePairwise,
} from "./decisions";
import type { OptimizableCompetitor, RosterSlot } from "./optimizer";

/**
 * The metrics the product is actually graded on.
 *
 * Every fixture here has an answer worked out by hand, because the whole reason these exist
 * is that MAE can move without any decision changing. A test that checked these against
 * whatever the implementation returned would reproduce that same blindness one level up.
 */

const outcome = (
  competitorId: string,
  groupId: string,
  predicted: number,
  actual: number,
): Outcome => ({ competitorId, groupId, predicted, actual });

describe("pairwiseDecisions", () => {
  it("scores a call the model got right as costing nothing", () => {
    const decisions = pairwiseDecisions([
      outcome("a", "w1:WR", 15, 20),
      outcome("b", "w1:WR", 10, 8),
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].correct).toBe(true);
    expect(decisions[0].forgone).toBe(0);
    expect(decisions[0].projectedGap).toBe(5);
    expect(decisions[0].actualGap).toBe(12);
  });

  it("charges a wrong call the points it actually cost", () => {
    // Favoured 15 over 10; the favoured player scored 8 and the other scored 20. Starting
    // the model's pick cost 12 points.
    const decisions = pairwiseDecisions([
      outcome("a", "w1:WR", 15, 8),
      outcome("b", "w1:WR", 10, 20),
    ]);
    expect(decisions[0].correct).toBe(false);
    expect(decisions[0].forgone).toBe(12);
  });

  it("only pairs within a group", () => {
    // Four players over two weeks. Two pairs, not six — a Week 1 receiver against a Week 2
    // receiver is a choice nobody is asked to make, and counting it would pad the rate with
    // comparisons that are easy for reasons unrelated to the model.
    const decisions = pairwiseDecisions([
      outcome("a", "w1:WR", 15, 20),
      outcome("b", "w1:WR", 10, 8),
      outcome("c", "w2:WR", 12, 18),
      outcome("d", "w2:WR", 9, 4),
    ]);
    expect(decisions).toHaveLength(2);
  });

  it("drops a pair whose outcomes tied", () => {
    // No right answer exists, so grading it either way moves the rate without meaning.
    expect(
      pairwiseDecisions([
        outcome("a", "w1:WR", 15, 11),
        outcome("b", "w1:WR", 10, 11),
      ]),
    ).toHaveLength(0);
  });

  it("breaks a projection tie deterministically rather than by input order", () => {
    const forward = pairwiseDecisions([
      outcome("a", "w1:WR", 12, 5),
      outcome("b", "w1:WR", 12, 9),
    ]);
    const reversed = pairwiseDecisions([
      outcome("b", "w1:WR", 12, 9),
      outcome("a", "w1:WR", 12, 5),
    ]);
    expect(forward).toEqual(reversed);
    expect(forward[0].projectedGap).toBe(0);
  });

  it("produces every pair in a group of more than two", () => {
    const decisions = pairwiseDecisions([
      outcome("a", "g", 20, 21),
      outcome("b", "g", 15, 14),
      outcome("c", "g", 10, 9),
      outcome("d", "g", 5, 4),
    ]);
    // Four players choose two.
    expect(decisions).toHaveLength(6);
    expect(decisions.every((d) => d.correct)).toBe(true);
  });
});

describe("pairClusterId", () => {
  it("is the same for a pair whichever way round it arrives", () => {
    expect(pairClusterId("x", "y")).toBe(pairClusterId("y", "x"));
    expect(pairClusterId("a", "b")).not.toBe(pairClusterId("a", "c"));
  });
});

describe("summarizePairwise", () => {
  it("computes the rates a hand count gives", () => {
    const decisions = pairwiseDecisions([
      outcome("a", "g1", 20, 5),
      outcome("b", "g1", 10, 25), // wrong, cost 20
      outcome("c", "g2", 20, 30),
      outcome("d", "g2", 10, 4), // right, cost 0
      outcome("e", "g3", 20, 8),
      outcome("f", "g3", 10, 12), // wrong, cost 4
    ]);
    const summary = summarizePairwise(decisions);
    expect(summary.pairs).toBe(3);
    expect(summary.accuracy).toBeCloseTo(1 / 3, 12);
    expect(summary.meanForgone).toBeCloseTo(24 / 3, 12);
    // Averaged over the wrong calls only, which is the number that says what a mistake
    // costs rather than what the average decision costs.
    expect(summary.meanForgoneWhenWrong).toBeCloseTo(24 / 2, 12);
  });

  it("returns NaN rather than a flattering zero on an empty sample", () => {
    // An accuracy of 0 and an accuracy of "no data" are different claims, and a rate of
    // zero next to a published figure reads as a measurement.
    const empty = summarizePairwise([]);
    expect(empty.pairs).toBe(0);
    expect(empty.accuracy).toBeNaN();
    expect(empty.meanForgone).toBeNaN();
  });

  it("reports zero cost when every call was right", () => {
    const summary = summarizePairwise(
      pairwiseDecisions([outcome("a", "g", 20, 30), outcome("b", "g", 10, 4)]),
    );
    expect(summary.accuracy).toBe(1);
    expect(summary.meanForgoneWhenWrong).toBe(0);
  });
});

describe("stratifyByGap", () => {
  it("splits on the projected gap and collects the tail", () => {
    const decisions = pairwiseDecisions([
      // gap 1
      outcome("a", "g1", 11, 20),
      outcome("b", "g1", 10, 5),
      // gap 6
      outcome("c", "g2", 16, 20),
      outcome("d", "g2", 10, 5),
      // gap 20
      outcome("e", "g3", 30, 40),
      outcome("f", "g3", 10, 5),
    ]);
    const strata = stratifyByGap(decisions, [3, 10]);
    expect(strata).toHaveLength(3);
    expect(strata[0].label).toBe("0.0–3.0");
    expect(strata[0].summary.pairs).toBe(1);
    expect(strata[1].label).toBe("3.0–10.0");
    expect(strata[1].summary.pairs).toBe(1);
    expect(strata[2].label).toBe("10.0+");
    expect(strata[2].summary.pairs).toBe(1);
  });

  it("loses no decision and double-counts none", () => {
    const decisions = pairwiseDecisions(
      Array.from({ length: 12 }, (_, i) =>
        outcome(`p${i}`, `g${i % 3}`, i * 1.7, (i * 7) % 23),
      ),
    );
    const strata = stratifyByGap(decisions, [2, 5, 9]);
    expect(strata.reduce((n, s) => n + s.summary.pairs, 0)).toBe(decisions.length);
  });

  it("puts a gap exactly on an edge in the upper stratum", () => {
    // Half-open intervals, so a boundary value has exactly one home. Stated because an
    // off-by-one here would silently double-count or drop it.
    const decisions = pairwiseDecisions([
      outcome("a", "g", 13, 20),
      outcome("b", "g", 10, 5),
    ]);
    const strata = stratifyByGap(decisions, [3, 10]);
    expect(strata[0].summary.pairs).toBe(0);
    expect(strata[1].summary.pairs).toBe(1);
  });
});

const SLOTS: RosterSlot[] = [
  { id: "wr1", label: "WR", eligiblePositions: ["WR"] },
  { id: "flex", label: "FLEX", eligiblePositions: ["WR", "RB"] },
];

const player = (
  id: string,
  position: string,
  projectedPoints: number,
): OptimizableCompetitor => ({
  id,
  name: id,
  position,
  projectedPoints,
  availability: "active",
});

describe("lineupRegret", () => {
  it("is zero when the projections ordered the roster correctly", () => {
    const roster = [player("a", "WR", 20), player("b", "WR", 15), player("c", "RB", 10)];
    const actual = new Map([
      ["a", 22],
      ["b", 16],
      ["c", 9],
    ]);
    const result = lineupRegret("w1", SLOTS, roster, actual);
    expect(result.achieved).toBeCloseTo(38, 10);
    expect(result.best).toBeCloseTo(38, 10);
    expect(result.regret).toBe(0);
  });

  it("charges the points a wrong ordering left on the bench", () => {
    // Projections put a in WR and b in FLEX, which actually scores 10 + 12 = 22.
    // In hindsight WR must still take a receiver, so b (12) goes there and c (30) takes
    // FLEX, for 42. Regret is 20. Note the hindsight lineup does *not* simply start the two
    // highest actual scorers — slot eligibility binds, which is why both sides are solved
    // rather than sorted.
    const roster = [player("a", "WR", 20), player("b", "WR", 15), player("c", "RB", 1)];
    const actual = new Map([
      ["a", 10],
      ["b", 12],
      ["c", 30],
    ]);
    const result = lineupRegret("w1", SLOTS, roster, actual);
    expect(result.achieved).toBeCloseTo(22, 10);
    expect(result.best).toBeCloseTo(42, 10);
    expect(result.regret).toBeCloseTo(20, 10);
  });

  it("scores the chosen lineup on what happened, not on what was predicted", () => {
    // A model that projects 100 and delivers 1 must not be credited with 100. This is the
    // single easiest way to build a regret metric that flatters a confidently wrong model.
    const roster = [player("a", "WR", 100), player("b", "WR", 1), player("c", "RB", 1)];
    const actual = new Map([
      ["a", 1],
      ["b", 1],
      ["c", 1],
    ]);
    expect(lineupRegret("w1", SLOTS, roster, actual).achieved).toBeCloseTo(2, 10);
  });

  it("treats a player with no recorded outcome as zero rather than dropping the slot", () => {
    const roster = [player("a", "WR", 20), player("b", "WR", 15), player("c", "RB", 10)];
    const result = lineupRegret("w1", SLOTS, roster, new Map([["a", 12]]));
    expect(result.achieved).toBeCloseTo(12, 10);
    expect(result.best).toBeCloseTo(12, 10);
  });

  it("clamps regret where the solver's quantization can actually make it negative", () => {
    // The previous version of this test used three players with identical actuals and
    // asserted `>= 0`. It passed with or without the clamp, because `best >= achieved`
    // holds by construction whenever the solver is exact — a mutation survivor asserting a
    // property no implementation can violate.
    //
    // The clamp is only reachable through the one place the solver is *not* exact:
    // `solveLineup` scales projections by 100 and rounds, so actual points with more than
    // two decimals can make the hindsight lineup pick a different assignment than the
    // unrounded sum would. Below, a and b differ by a thousandth — invisible after
    // quantization, so the hindsight solve may choose either, and the achieved lineup can
    // legitimately hold the fractionally better one.
    // No fixture has been found that makes the clamp bind, and this test says so rather
    // than pretending otherwise. Two attempts failed: three equal actuals (passes with the
    // clamp deleted, because `best >= achieved` holds whenever the solver is exact), and a
    // sub-quantization fraction on a benched player (same reason). Moving the fraction onto
    // a started player does not do it either — both solves still return the same lineup.
    //
    // What the clamp guards is narrow and real: `solveLineup` scales by 100 and rounds, so
    // it maximises the *rounded* actual total, which need not maximise the unrounded one.
    // The gap is bounded by that quantization. Reaching it requires the two solves to
    // disagree on a tie the rounding created, which the deterministic tie-break has so far
    // resolved the same way on both sides.
    //
    // So this is documentation, not coverage, and it is labelled as such. What it does pin
    // is the normal-path identity — that `regret` is the difference and not something else.
    const roster = [player("a", "WR", 1), player("b", "WR", 2), player("c", "RB", 3)];
    const actual = new Map([
      ["a", 5.0],
      ["b", 5.0004],
      ["c", 5.0],
    ]);
    const result = lineupRegret("w1", SLOTS, roster, actual);
    expect(result.regret).toBe(Math.max(0, result.best - result.achieved));
    expect(result.regret).toBeGreaterThanOrEqual(0);
  });

  it("compares like with like — both lineups solved by the same optimizer", () => {
    // The measured difference has to be down to the projections alone. If the hindsight
    // side were filled greedily it would sometimes lose to the model's optimal assignment
    // and understate regret. Here greedy would take the two highest actual scorers (30, 20)
    // but only one is FLEX-eligible alongside the WR slot, so the optimal answer differs.
    const roster = [player("a", "WR", 9), player("b", "RB", 8), player("c", "RB", 7)];
    const actual = new Map([
      ["a", 5],
      ["b", 30],
      ["c", 20],
    ]);
    const result = lineupRegret("w1", SLOTS, roster, actual);
    // WR slot can only take `a`; FLEX takes the better back.
    expect(result.best).toBeCloseTo(35, 10);
    expect(result.achieved).toBeCloseTo(35, 10);
  });
});
