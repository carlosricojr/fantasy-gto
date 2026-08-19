import { describe, expect, it } from "vitest";

import { type DepthPlayer, coverValue as coverValueWithWire } from "./draft-bench";

/**
 * What depth is worth.
 *
 * The property that matters is that it *diminishes*. The term this replaced did not, which
 * is why a fifteen-round roster came back holding seven quarterbacks in a league that starts
 * one. Every test here is on a hand-computable fixture, so a regression names the wrong
 * number rather than only the wrong roster.
 */

/**
 * A fourteen-week regular season, as week numbers rather than as a count.
 *
 * A fixture, not the product's season. The draft screen hands `coverValue` whatever
 * regular season the league's championship week implies — fourteen weeks for a week-17
 * final, twelve for a week-15 one with a six-team bracket — so a test that described this
 * as "what the screen passes" would be describing one league of six.
 *
 * The weeks themselves, because `coverValue` uses this argument for two different jobs: it
 * is the denominator, and it is the set each bye is tested for membership in. A count only
 * answers the second while the weeks run `1..n` from one, which is a coincidence the season
 * layout no longer has any reason to preserve. See `PolicyLeague.weeks`.
 */
const WEEKS = Array.from({ length: 14 }, (_, i) => i + 1);

// Week zero is the explicit "no bye in any played week" control — a known bye no league
// plays through, exactly what `coverValue`'s own baseline uses. It used to be `null`, but
// null now means *unknown* and is charged an expected absent week, which would move every
// hand-computed figure below.
/**
 * `coverValue` with no waiver wire, which is what every test written before the wire
 * existed means and what its hand-computed figures are all against.
 *
 * A default rather than a sixth argument repeated forty times, and a *test* default
 * rather than a production one: `coverValue` itself requires the share, because a
 * caller who forgets it silently gets the pre-#88 pricing that drafted two kickers.
 * The wire's own behaviour is tested through this wrapper by passing the share
 * explicitly — see "the waiver wire discounts cover" below.
 */
const coverValue = (
  rosterAtPosition: readonly DepthPlayer[],
  candidate: DepthPlayer,
  slots: number,
  replacement: number,
  weeks: readonly number[],
  wireCover = 0,
): number =>
  coverValueWithWire(rosterAtPosition, candidate, slots, replacement, weeks, wireCover);

const p = (
  value: number,
  availability: number,
  byeWeek: number | null = 0,
): DepthPlayer => ({ value, availability, byeWeek });

describe("coverValue diminishes as the same position is stacked", () => {
  it("is worth less for each further reserve at a one-slot position", () => {
    // One starting slot, a starter who plays 90% of weeks, and identical candidates behind
    // him. The second reserve only plays when *both* the starter and the first reserve are
    // out; the third when all three are.
    const starter = p(20, 0.9);
    const candidate = p(18, 0.9);
    const first = coverValue([starter], candidate, 1, 10, WEEKS);
    const second = coverValue([starter, p(18.5, 0.9)], candidate, 1, 10, WEEKS);
    const third = coverValue(
      [starter, p(18.5, 0.9), p(18.2, 0.9)],
      candidate,
      1,
      10,
      WEEKS,
    );

    expect(first).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(third);
    // And it falls fast rather than gently: each further body has to be out too.
    expect(second).toBeLessThan(first / 5);
    expect(third).toBeLessThan(second / 5);
  });

  it("is worth more behind a fragile starter than behind a durable one", () => {
    // The reason each player's own availability is carried through the distribution rather
    // than averaged. Backing up somebody who misses a third of the season is a different
    // proposition from backing up somebody who misses none.
    const candidate = p(15, 0.95);
    const behindFragile = coverValue([p(20, 0.6)], candidate, 1, 8, WEEKS);
    const behindDurable = coverValue([p(20, 0.98)], candidate, 1, 8, WEEKS);
    expect(behindFragile).toBeGreaterThan(behindDurable * 5);
  });

  it("is worth more where the position occupies more slots", () => {
    // Three players ahead of him and three slots means any one of them being out lets him
    // in; three ahead and one slot means all three have to be. Which way that falls is not
    // obvious from the shape of the formula and is worth pinning.
    const ahead = [p(16, 0.9), p(15, 0.9), p(14, 0.9)];
    const candidate = p(12, 0.9);
    expect(coverValue(ahead, candidate, 3, 8, WEEKS)).toBeGreaterThan(
      coverValue(ahead, candidate, 1, 8, WEEKS),
    );
  });

  it("is exactly the arithmetic, on a fixture small enough to do by hand", () => {
    // One slot, one starter available 80% of weeks, replacement worth 5, candidate worth 12,
    // no byes anywhere so every week is the same week.
    //
    //   with him, stochastic: starter 0.8 * 1 * (20-5) = 12
    //                         candidate 0.9 * P(starter out) * (12-5)
    //                                 = 0.9 * 0.2 * 7 = 1.26
    //   without him:          starter 0.8 * 15 = 12
    //   stochastic gain = 1.26
    //
    //   all-available, with him: starter 15, candidate crowded out -> 0
    //   all-available, without:  15
    //   certain gain = 0
    //
    //   cover = 1.26 - 0 = 1.26
    expect(coverValue([p(20, 0.8)], p(12, 0.9), 1, 5, WEEKS)).toBeCloseTo(1.26, 10);
  });

  it("subtracts what the starting lineup already prices, so a clear starter earns only cover", () => {
    // Candidate is better than the incumbent, so the all-available lineup already credits
    // him with the upgrade.
    //
    //   with him, stochastic: candidate 0.9 * (20-5) = 13.5
    //                         incumbent 0.9 * 0.1 * (10-5) = 0.45
    //   without him:          incumbent 0.9 * (10-5) = 4.5
    //   stochastic gain = 9.45
    //   all-available: 15 with him, 5 without -> certain gain = 10
    //   cover = max(9.45 - 10, 0) = 0
    //
    // Zero, and correctly: a strictly better starter with a much worse body behind him adds
    // nothing that shows up only in absence weeks. The upgrade is the whole story and the
    // lineup solver has it.
    expect(coverValue([p(10, 0.9)], p(20, 0.9), 1, 5, WEEKS)).toBe(0);
  });
});

describe("a bye is an absence the depth model can see", () => {
  it("makes a backup worth more than the same backup behind a starter who never sits", () => {
    // Identical players, identical availabilities. The only difference is that one starter
    // has a bye inside the season and the other has none.
    const candidate = p(15, 0.95, 9);
    const withBye = coverValue([p(20, 0.95, 6)], candidate, 1, 8, WEEKS);
    const withoutBye = coverValue([p(20, 0.95, 0)], candidate, 1, 8, WEEKS);
    expect(withBye).toBeGreaterThan(withoutBye);
    // One week of fourteen, and the arithmetic is exact. In that week the starter is out
    // for certain, where in an ordinary week he is out with probability 0.05 — so the bye
    // adds the remaining 0.95 of the cover, weighted by the candidate's own availability
    // and by what he beats replacement by:
    //
    //   0.95 (candidate available) * 7 (15 - 8) * 0.95 (not already covered) / 14 = 0.45125
    expect(withBye - withoutBye).toBeCloseTo((0.95 * 7 * 0.95) / WEEKS.length, 10);
  });

  it("is worth nothing extra when the backup shares the starter's bye", () => {
    // Both idle in week 6, so the cover is not there in the week it is needed for.
    const shared = coverValue([p(20, 0.95, 6)], p(15, 0.95, 6), 1, 8, WEEKS);
    const separate = coverValue([p(20, 0.95, 6)], p(15, 0.95, 9), 1, 8, WEEKS);
    expect(separate).toBeGreaterThan(shared);
  });

  it("ignores a bye week outside the season", () => {
    // A week nobody plays through is not a week to reserve a share of the average for —
    // any known out-of-season week prices identically to any other.
    expect(coverValue([p(20, 0.95, 18)], p(15, 0.95), 1, 8, WEEKS)).toBeCloseTo(
      coverValue([p(20, 0.95, 0)], p(15, 0.95), 1, 8, WEEKS),
      12,
    );
  });

  it("prices an unknown bye between sharing the starter's bye and certainly missing it", () => {
    // The #89.D subsidy, closed on the heuristic side too. Three otherwise-identical
    // backups behind a starter idle in week 6: one shares the bye (worthless in the one
    // week cover matters), one is certainly present then (bye week 9), one has no bye
    // listed. Unknown must land strictly between — his bye falls on the starter's with
    // probability 1/14, not 0 and not 1. Before this change the unknown backup priced
    // *above* the certainly-present one: missing data read as playing every week.
    const starter = [p(20, 0.95, 6)];
    const shared = coverValue(starter, p(15, 0.95, 6), 1, 8, WEEKS);
    const unknown = coverValue(starter, p(15, 0.95, null), 1, 8, WEEKS);
    const separate = coverValue(starter, p(15, 0.95, 9), 1, 8, WEEKS);
    expect(unknown).toBeGreaterThan(shared);
    expect(unknown).toBeLessThan(separate);
  });

  it("reads the weeks it is given, not their count", () => {
    // What the list buys over a number, on a season that is not `1..n`. Week 14 is in this
    // one and week 13 is not, so a bye in 14 must be priced and a bye in 13 must not —
    // which a length test against 15 gets backwards for both. The production caller passes
    // a contiguous regular season today, so nothing currently depends on this; it is here
    // because the argument used to be a count doing two jobs, and this is the job it did
    // only by coincidence.
    const gappy = [...Array.from({ length: 12 }, (_, i) => i + 1), 14, 15];
    const noBye = coverValue([p(20, 0.95, 0)], p(15, 0.95), 1, 8, gappy);
    expect(coverValue([p(20, 0.95, 14)], p(15, 0.95), 1, 8, gappy)).toBeGreaterThan(noBye);
    expect(coverValue([p(20, 0.95, 13)], p(15, 0.95), 1, 8, gappy)).toBeCloseTo(noBye, 12);
  });

  it("weighs a bye more heavily in a shorter season", () => {
    const weeks = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const short = coverValue([p(20, 0.95, 6)], p(15, 0.95, 9), 1, 8, weeks(10));
    const long = coverValue([p(20, 0.95, 6)], p(15, 0.95, 9), 1, 8, weeks(17));
    expect(short).toBeGreaterThan(long);
  });
});

describe("coverValue boundaries", () => {
  it("is nothing at a position with no starting slot", () => {
    // A kicker in a league that starts no kicker must not acquire value from being scarce.
    expect(coverValue([p(9, 0.95)], p(8.5, 0.95), 0, 5, WEEKS)).toBe(0);
    expect(coverValue([], p(8.5, 0.95), 0, 5, WEEKS)).toBe(0);
  });

  it("is nothing over a season with no weeks in it", () => {
    expect(coverValue([p(20, 0.9)], p(15, 0.9), 1, 5, [])).toBe(0);
  });

  it("is nothing for a player who is not better than replacement", () => {
    expect(coverValue([p(20, 0.9)], p(5, 0.9), 1, 5, WEEKS)).toBe(0);
    expect(coverValue([p(20, 0.9)], p(4, 0.9), 1, 5, WEEKS)).toBe(0);
  });

  it("is nothing for the first player at an empty position", () => {
    // Nobody to cover for. Everything he is worth is what the starting lineup shows.
    expect(coverValue([], p(20, 0.9), 1, 5, WEEKS)).toBe(0);
  });

  it("never goes negative", () => {
    // The expression is a difference of two expectations, so rounding can put a candidate
    // who adds nothing a few parts in 10^15 below zero. A negative depth value would rank
    // him below an empty roster spot, which is not a choice the draft offers.
    for (const value of [5, 5.0000001, 10, 19.999999, 20]) {
      expect(
        coverValue([p(20, 0.9), p(15, 0.9)], p(value, 0.9), 2, 5, WEEKS),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("treats an availability outside [0, 1] as the nearest legal one", () => {
    // Board rows arrive from a division and can carry 1.0000000001. Unclamped that makes the
    // distribution sum to something other than one and the answer stops being points.
    expect(coverValue([p(20, 1.0000000001)], p(12, 0.9), 1, 5, WEEKS)).toBe(0);
    expect(coverValue([p(20, -0.001)], p(12, 0.9), 1, 5, WEEKS)).toBeCloseTo(
      coverValue([p(20, 0)], p(12, 0.9), 1, 5, WEEKS),
      10,
    );
  });

  it("does not depend on the order the roster is listed in", () => {
    const roster = [p(20, 0.9, 6), p(14, 0.7, 9), p(17, 0.95, null)];
    const candidate = p(12, 0.9, 11);
    expect(coverValue(roster, candidate, 2, 5, WEEKS)).toBeCloseTo(
      coverValue([...roster].reverse(), candidate, 2, 5, WEEKS),
      12,
    );
  });
});

describe("the waiver wire discounts cover", () => {
  const starter = p(20, 0.9);
  const candidate = p(18, 0.9);
  const cover = (wireCover: number) =>
    coverValue([starter], candidate, 1, 10, WEEKS, wireCover);

  it("is the whole cover at a share of zero and none of it at a share of one", () => {
    // A share of one is the honest reading of "the wire supplies this position": a
    // drafted reserve there sells nothing you could not have signed on the day you
    // needed him. This is what stops the board wanting a second kicker.
    expect(cover(0)).toBeGreaterThan(0);
    expect(cover(1)).toBe(0);
  });

  it("scales the cover linearly by the share the wire does not supply", () => {
    // Not a re-weighting inside the per-week expectation: the wire takes a share of a
    // number the depth model has already computed, so the relationship is exact and a
    // reader can check it by hand.
    expect(cover(0.75)).toBeCloseTo(cover(0) * 0.25, 12);
    expect(cover(0.5)).toBeCloseTo(cover(0) * 0.5, 12);
  });

  it("keeps the ordering within a position, so it diminishes rather than flattens", () => {
    // Every cover at a position is scaled by the same share, so a better reserve stays a
    // better reserve. A discount that reordered candidates would be a different model,
    // not a cheaper wire.
    const better = coverValue([starter], p(19, 0.9), 1, 10, WEEKS, 0.75);
    const worse = coverValue([starter], p(12, 0.9), 1, 10, WEEKS, 0.75);
    expect(better).toBeGreaterThan(worse);
  });

  it("clamps a share outside [0, 1] rather than paying or charging for it", () => {
    // Above one would turn depth into a penalty and below zero would pay a bonus for it;
    // neither is a stronger claim about the wire, it is a caller with a bug.
    expect(cover(1.5)).toBe(0);
    expect(cover(-1)).toBeCloseTo(cover(0), 12);
  });

  it("reads a share that is not a number as no wire at all", () => {
    // Clamping does not reach `NaN` — `Math.min(Math.max(NaN, 0), 1)` is `NaN` — and a
    // `NaN` cover compares false against every other value, so the candidate would be
    // silently dropped from the shortlist rather than the caller being told. Zero is the
    // same default an absent position gets, and the conservative direction: it charges
    // the draft for depth instead of crediting it with free cover.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(Number.isFinite(cover(bad))).toBe(true);
    }
    // All three, not only `NaN`: an infinite share is not an emphatic one, it is the
    // same caller bug, and one rule for "not a finite number" is easier to hold than a
    // clamp for infinities beside a default for `NaN`. Note this makes a positive
    // infinity *charge* for depth where 1.5 credits nothing — deliberate, and the same
    // direction: a share nobody can have read is not read as a total one.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(cover(bad)).toBeCloseTo(cover(0), 12);
    }
  });
});
