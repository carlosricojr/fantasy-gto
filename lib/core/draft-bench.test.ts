import { describe, expect, it } from "vitest";

import { type DepthPlayer, coverValue } from "./draft-bench";

/**
 * What depth is worth.
 *
 * The property that matters is that it *diminishes*. The term this replaced did not, which
 * is why a fifteen-round roster came back holding seven quarterbacks in a league that starts
 * one. Every test here is on a hand-computable fixture, so a regression names the wrong
 * number rather than only the wrong roster.
 */

/** A fourteen-week fantasy regular season, matching the draft screen's `LeagueConfig`. */
const WEEKS = 14;

const p = (
  value: number,
  availability: number,
  byeWeek: number | null = null,
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
    const withoutBye = coverValue([p(20, 0.95, null)], candidate, 1, 8, WEEKS);
    expect(withBye).toBeGreaterThan(withoutBye);
    // One week of fourteen, and the arithmetic is exact. In that week the starter is out
    // for certain, where in an ordinary week he is out with probability 0.05 — so the bye
    // adds the remaining 0.95 of the cover, weighted by the candidate's own availability
    // and by what he beats replacement by:
    //
    //   0.95 (candidate available) * 7 (15 - 8) * 0.95 (not already covered) / 14 = 0.45125
    expect(withBye - withoutBye).toBeCloseTo((0.95 * 7 * 0.95) / WEEKS, 10);
  });

  it("is worth nothing extra when the backup shares the starter's bye", () => {
    // Both idle in week 6, so the cover is not there in the week it is needed for.
    const shared = coverValue([p(20, 0.95, 6)], p(15, 0.95, 6), 1, 8, WEEKS);
    const separate = coverValue([p(20, 0.95, 6)], p(15, 0.95, 9), 1, 8, WEEKS);
    expect(separate).toBeGreaterThan(shared);
  });

  it("ignores a bye week outside the season", () => {
    // A week nobody plays through is not a week to reserve a share of the average for.
    expect(coverValue([p(20, 0.95, 17)], p(15, 0.95), 1, 8, WEEKS)).toBeCloseTo(
      coverValue([p(20, 0.95, null)], p(15, 0.95), 1, 8, WEEKS),
      12,
    );
  });

  it("weighs a bye more heavily in a shorter season", () => {
    const short = coverValue([p(20, 0.95, 6)], p(15, 0.95, 9), 1, 8, 10);
    const long = coverValue([p(20, 0.95, 6)], p(15, 0.95, 9), 1, 8, 17);
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
    expect(coverValue([p(20, 0.9)], p(15, 0.9), 1, 5, 0)).toBe(0);
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
