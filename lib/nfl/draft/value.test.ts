import { describe, expect, it } from "vitest";

import {
  MIN_AVAILABILITY_FOR_RATE,
  emaRate,
  MIN_CURVE_SAMPLES,
  adpImpliedPoints,
  fitAdpCurve,
  fitAdpCurves,
  blendedSeasonValue,
  expectedGames,
  perGameRate,
  seasonProjection,
} from "./value";
import { AVAILABILITY_FLOOR, GAMES_IN_SEASON, MODEL_BLEND_WEIGHT } from "./config";
import { rosterUtility } from "../../core/roster-utility";

/**
 * Season valuation.
 *
 * The blend's handling of *absence* is what these pin. Absence on either side has to mean
 * "no opinion", and the failure mode when it does not is silent and systematic.
 */

describe("blendedSeasonValue", () => {
  it("blends when both sides have an opinion", () => {
    expect(blendedSeasonValue(100, 200)).toBeCloseTo(
      MODEL_BLEND_WEIGHT * 100 + (1 - MODEL_BLEND_WEIGHT) * 200,
      2,
    );
  });

  it("does not mark a rookie down for having no history", () => {
    // The defect this exists to prevent. A rookie has no prior games, so the model has no
    // opinion — passing that through as a zero priced a market-300 rookie at 240, a
    // systematic markdown of exactly the players the model knows least about.
    expect(blendedSeasonValue(null, 300)).toBeCloseTo(300, 2);
    expect(blendedSeasonValue(null, 300)).toBeGreaterThan(
      MODEL_BLEND_WEIGHT * 0 + (1 - MODEL_BLEND_WEIGHT) * 300,
    );
  });

  it("uses the model alone when the market is silent", () => {
    expect(blendedSeasonValue(150, null)).toBeCloseTo(150, 2);
  });

  it("is zero only when neither side knows anything", () => {
    expect(blendedSeasonValue(null, null)).toBe(0);
  });

  it("still treats a genuine zero projection as a zero", () => {
    // A player with history who is projected at nothing is different from a player with
    // no history at all, and the two must not collapse.
    expect(blendedSeasonValue(0, 300)).toBeCloseTo((1 - MODEL_BLEND_WEIGHT) * 300, 2);
  });
});

describe("seasonProjection", () => {
  it("scales a per-game rate by expected games", () => {
    const flat = Array.from({ length: 17 }, () => 10);
    expect(seasonProjection({ perGamePoints: flat, priorSeasonGames: 17 })).toBeCloseTo(
      10 * 17,
      1,
    );
  });

  it("discounts a player who missed most of last season", () => {
    const flat = Array.from({ length: 17 }, () => 10);
    const full = seasonProjection({ perGamePoints: flat, priorSeasonGames: 17 });
    const partial = seasonProjection({ perGamePoints: flat, priorSeasonGames: 4 });
    expect(partial).toBeLessThan(full);
    // But not written off: availability ramps from a floor rather than scaling linearly.
    expect(partial).toBeGreaterThan(full * 0.5);
  });

  it("never projects more games than a season has", () => {
    expect(expectedGames(40)).toBeLessThanOrEqual(17);
    expect(expectedGames(-5)).toBeGreaterThan(0);
  });
});

describe("perGameRate", () => {
  const GAMES = 17;

  it("round-trips: the simulator realises the season total it was given", () => {
    // The property the whole conversion exists for. A season total goes in, the simulator
    // plays the player in `availability` of his games, and what comes out must be the
    // total we started with — otherwise the discount has been applied a different number
    // of times than once.
    for (const availability of [0.3, 0.5, 0.75, 0.94, 1]) {
      for (const seasonPoints of [80, 210, 300]) {
        const rate = perGameRate(seasonPoints, availability, GAMES);
        const realised = rate * availability * GAMES;
        expect(realised).toBeCloseTo(seasonPoints, 6);
      }
    }
  });

  it("charges the fragile player nothing extra, which the naive conversion did not", () => {
    // Dividing by a full season and letting the simulator discount again cost a player at
    // 0.50 availability half his value — 150 points of an intended 300 — while barely
    // touching an ironman. The error was entirely differential.
    const naive = (season: number) => season / GAMES;
    const fragile = 0.5;
    expect(naive(300) * fragile * GAMES).toBeCloseTo(150, 6);
    expect(perGameRate(300, fragile, GAMES) * fragile * GAMES).toBeCloseTo(300, 6);
  });

  it("gives a fragile player a higher per-game rate than a durable one at equal totals", () => {
    // He has to score more in each game he plays to reach the same season total.
    expect(perGameRate(300, 0.5, GAMES)).toBeGreaterThan(perGameRate(300, 1, GAMES));
  });

  it("does not divide by zero or explode at no recorded availability", () => {
    const rate = perGameRate(200, 0, GAMES);
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBe(perGameRate(200, MIN_AVAILABILITY_FOR_RATE, GAMES));
  });

  it("is zero for a player worth nothing, whatever his availability", () => {
    for (const availability of [0, 0.5, 1]) {
      expect(perGameRate(0, availability, GAMES)).toBe(0);
    }
  });
});

describe("perGameRate against the real simulator", () => {
  /**
   * The earlier round-trip test is algebra.
   *
   * `rate × availability × games === seasonPoints` reduces to `x/(G·a)·a·G === x` and holds
   * for any implementation of that shape, never touching the simulator it exists to feed.
   * It does catch the specific regression it was written for — reintroducing the naive
   * conversion fails it — but it cannot see the discount coming back anywhere else.
   *
   * This drives the actual simulation instead, and asserts the property that matters: two
   * players with the same expected season total contribute the same amount, however
   * durable they are. The absolute total is *not* asserted, because it should not match —
   * a fantasy season is 17 scoring weeks minus a bye, not 17 games — and pinning a number
   * the model does not claim would be worse than pinning none.
   */
  const SLOTS = [{ id: "wr1", label: "WR", eligiblePositions: ["WR"] }];
  const WEEKS = Array.from({ length: 14 }, (_, i) => i + 1);
  const CONFIG = { weeks: WEEKS, scenarios: 600, meanAbsenceWeeks: 3 };

  const seasonPlayer = (id: string, seasonPoints: number, availability: number) => ({
    id,
    name: id,
    position: "WR",
    weeklyMean: perGameRate(seasonPoints, availability),
    p10: 0.186,
    p90: 1.808,
    byeWeek: null,
    availability,
  });

  it("gives equal season totals equal value, however durable the player", () => {
    // The differential error the fix was about. Before it, the fragile player realised
    // roughly half the durable one's total from the same season projection.
    // One id for both. `playerStream` derives each player's random stream from his id, so
    // a shared seed does not pair two samples — only a shared id does. With "d" and "f"
    // these were independent draws, and the 0.9–1.1 band is about the size of the sampling
    // error on two single-player estimates at 600 scenarios, so the test could fail on the
    // draw rather than on the behaviour.
    const durable = rosterUtility([seasonPlayer("p", 240, 0.95)], SLOTS, CONFIG, 11);
    const fragile = rosterUtility([seasonPlayer("p", 240, 0.55)], SLOTS, CONFIG, 11);

    const ratio = fragile.expectedPoints / durable.expectedPoints;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("catches the naive conversion, which the algebraic test cannot do alone", () => {
    // Same two players, converted the old way: divide by a full season and let the
    // simulator discount again. The gap that opens up is the bug.
    const naive = (id: string, seasonPoints: number, availability: number) => ({
      ...seasonPlayer(id, seasonPoints, availability),
      weeklyMean: seasonPoints / 17,
    });
    // Same id for both, for the same reason as above. The margin here is wide enough that
    // this is consistency rather than a flake fix.
    const durable = rosterUtility([naive("p", 240, 0.95)], SLOTS, CONFIG, 11);
    const fragile = rosterUtility([naive("p", 240, 0.55)], SLOTS, CONFIG, 11);

    expect(fragile.expectedPoints / durable.expectedPoints).toBeLessThan(0.7);
  });

  it("scales linearly in the season total", () => {
    const single = rosterUtility([seasonPlayer("a", 120, 0.8)], SLOTS, CONFIG, 12);
    const double = rosterUtility([seasonPlayer("a", 240, 0.8)], SLOTS, CONFIG, 12);
    expect(double.expectedPoints / single.expectedPoints).toBeCloseTo(2, 1);
  });
});

/**
 * The market curve.
 *
 * None of this was tested. A mutation run put `fitAdpCurve` at the bottom of the repo, and
 * the survivors were not edge cases: computing `meanY` by folded subtraction, flipping the
 * intercept's sign, inverting the curve, or switching the per-position system off entirely
 * all left every test green. Each of those reprices the whole board — this is the function
 * that turns a draft slot into points, so an error here is not one wrong player, it is
 * every player.
 *
 * What made it invisible is that nothing pinned an *absolute* number. The convex tests
 * compare one board against another and re-derive the blend from the row's own
 * `marketPoints`, so a uniformly wrong market is perfectly self-consistent. These fit a
 * curve to points that lie exactly on a known line and check the line comes back.
 */
describe("fitAdpCurve", () => {
  /** Points on `y = 300 - 50·ln(adp)` exactly, so the fit has one right answer. */
  const onTheLine = (adps: readonly number[], position = "WR") =>
    adps.map((adp) => ({
      adp,
      actualSeasonPoints: 300 - 50 * Math.log(adp),
      position,
    }));

  it("recovers the line its samples were drawn from", () => {
    // Exact, not approximate. Every arithmetic mutant in the fit — the two means, the two
    // accumulator seeds, the loop bounds, the covariance and variance terms, and the
    // intercept — moves one of these two numbers.
    const curve = fitAdpCurve(onTheLine([1, 2, 5, 12, 24, 50, 80, 200]), 2024);
    expect(curve).not.toBeNull();
    expect(curve!.slope).toBeCloseTo(-50, 6);
    expect(curve!.intercept).toBeCloseTo(300, 6);
    expect(curve!.sampleSize).toBe(8);
  });

  it("recovers a steeper line too, so a shrunk slope cannot pass", () => {
    // A wrong mean leaves the covariance alone but inflates the variance, which shrinks
    // the slope toward zero rather than breaking it outright. One line cannot show that;
    // two of visibly different steepness can.
    const steep = [1, 2, 5, 12, 24, 50, 80, 200].map((adp) => ({
      adp,
      actualSeasonPoints: 400 - 90 * Math.log(adp),
      position: "QB",
    }));
    const curve = fitAdpCurve(steep, 2024);
    expect(curve!.slope).toBeCloseTo(-90, 6);
    expect(curve!.intercept).toBeCloseTo(400, 6);
  });

  it("refuses a fit it cannot make rather than returning a flat line", () => {
    expect(fitAdpCurve([], 2024)).toBeNull();
    expect(fitAdpCurve(onTheLine([10]), 2024)).toBeNull();
    // Every sample at one draft slot: no spread in x, so no slope exists.
    expect(fitAdpCurve(onTheLine([10, 10, 10, 10]), 2024)).toBeNull();
    // Non-positive ADP and non-finite points are dropped before the count is taken.
    expect(
      fitAdpCurve(
        [
          { adp: 0, actualSeasonPoints: 100, position: "WR" },
          { adp: -5, actualSeasonPoints: 100, position: "WR" },
          { adp: 10, actualSeasonPoints: Number.NaN, position: "WR" },
          { adp: 20, actualSeasonPoints: 50, position: "WR" },
        ],
        2024,
      ),
    ).toBeNull();
  });
});

describe("adpImpliedPoints", () => {
  const curves = fitAdpCurves(
    [1, 2, 5, 12, 24, 50, 80, 200].map((adp) => ({
      adp,
      actualSeasonPoints: 300 - 50 * Math.log(adp),
      position: "WR",
    })),
    2024,
  );

  it("prices a slot at the value the curve says", () => {
    // Absolute numbers, computed by hand from `300 - 50·ln(adp)`. A test that re-derives
    // them from the curve it is checking would pass against an inverted one.
    expect(adpImpliedPoints(1, "WR", curves)).toBeCloseTo(300, 2);
    expect(adpImpliedPoints(5, "WR", curves)).toBeCloseTo(219.53, 2);
    expect(adpImpliedPoints(24, "WR", curves)).toBeCloseTo(141.1, 2);
    expect(adpImpliedPoints(200, "WR", curves)).toBeCloseTo(35.08, 2);
  });

  it("falls as the draft slot rises, which is the whole premise", () => {
    // The sign flip that made the last player on the board the most valuable.
    const prices = [1, 5, 24, 80, 200].map((adp) => adpImpliedPoints(adp, "WR", curves)!);
    for (let i = 1; i < prices.length; i += 1) {
      expect(prices[i]).toBeLessThan(prices[i - 1]);
    }
  });

  it("never returns a negative price, and says nothing when it knows nothing", () => {
    expect(adpImpliedPoints(100_000, "WR", curves)).toBe(0);
    expect(adpImpliedPoints(0, "WR", curves)).toBe(0);
    expect(adpImpliedPoints(10, "WR", { byPosition: {}, pooled: null, season: 2024 }))
      .toBeNull();
  });
});

describe("fitAdpCurves, per position", () => {
  const bucket = (position: string, n: number, base: number, slope: number) =>
    Array.from({ length: n }, (_, i) => {
      const adp = 2 + i * 7;
      return { adp, actualSeasonPoints: base - slope * Math.log(adp), position };
    });

  it("fits a curve per position, and they price a slot differently", () => {
    // Inverting the null check switched the whole per-position system off, leaving every
    // player on the pooled curve — the mis-specification the module docstring records as
    // the difference between the market looking beatable and the market looking correct.
    const curves = fitAdpCurves(
      [...bucket("WR", 10, 300, 50), ...bucket("QB", 10, 400, 90)],
      2024,
    );
    expect(Object.keys(curves.byPosition).sort()).toEqual(["QB", "WR"]);

    const wr = adpImpliedPoints(5, "WR", curves)!;
    const qb = adpImpliedPoints(5, "QB", curves)!;
    expect(Math.abs(qb - wr)).toBeGreaterThan(20);

    // And each differs from what the pooled curve alone would have said.
    const pooledOnly = { ...curves, byPosition: {} };
    expect(adpImpliedPoints(5, "QB", pooledOnly)).not.toBeCloseTo(qb, 1);
  });

  it("needs MIN_CURVE_SAMPLES before it will fit a position at all", () => {
    // One short and the position falls back to pooled, which reprices it. Raising the
    // threshold silently does that to every thin position.
    const withEnough = fitAdpCurves(
      [...bucket("WR", 10, 300, 50), ...bucket("TE", MIN_CURVE_SAMPLES, 250, 30)],
      2024,
    );
    const oneShort = fitAdpCurves(
      [...bucket("WR", 10, 300, 50), ...bucket("TE", MIN_CURVE_SAMPLES - 1, 250, 30)],
      2024,
    );
    expect(Object.keys(withEnough.byPosition)).toContain("TE");
    expect(Object.keys(oneShort.byPosition)).not.toContain("TE");
    expect(adpImpliedPoints(9, "TE", withEnough)).not.toBeCloseTo(
      adpImpliedPoints(9, "TE", oneShort)!,
      1,
    );
  });
});

/**
 * The two functions every season projection is built from.
 *
 * `emaRate` weights a player's history and `expectedGames` turns last season's availability
 * into this season's games. Both feed `seasonProjection`, which feeds the blend, which is
 * the board. Neither was pinned to a value, so the EMA could seed from the wrong game and
 * the availability ramp could start from the wrong floor with nothing objecting.
 */
describe("emaRate", () => {
  it("seeds from the first game and weights the most recent most", () => {
    // Seeding from the second game instead leaves a one-game history undefined, which
    // turns the stored projection into NaN, and weights every longer history wrongly.
    expect(emaRate([10], 0.3)).toBe(10);
    // 0.3 * 20 + 0.7 * 10 = 13
    expect(emaRate([10, 20], 0.3)).toBeCloseTo(13, 10);
    // 0.3 * 0 + 0.7 * 13 = 9.1
    expect(emaRate([10, 20, 0], 0.3)).toBeCloseTo(9.1, 10);
    expect(emaRate([], 0.3)).toBe(0);
  });

  it("weights recent games above old ones", () => {
    const improving = emaRate([5, 5, 5, 20], 0.4);
    const declining = emaRate([20, 5, 5, 5], 0.4);
    expect(improving).toBeGreaterThan(declining);
  });
});

describe("expectedGames", () => {
  it("ramps from the documented floor to a full season", () => {
    // A player who played nothing is projected for the floor, not for nothing — the
    // distinction the config's comment turns on. Absolute values, so a shifted ramp or a
    // clamp that lets the floor drift is visible.
    expect(expectedGames(0)).toBeCloseTo(GAMES_IN_SEASON * AVAILABILITY_FLOOR, 10);
    expect(expectedGames(GAMES_IN_SEASON)).toBeCloseTo(GAMES_IN_SEASON, 10);
    expect(expectedGames(-3)).toBeCloseTo(GAMES_IN_SEASON * AVAILABILITY_FLOOR, 10);
    expect(expectedGames(GAMES_IN_SEASON + 10)).toBeCloseTo(GAMES_IN_SEASON, 10);
  });

  it("is monotonic between the two ends", () => {
    let previous = -Infinity;
    for (let played = 0; played <= GAMES_IN_SEASON; played += 1) {
      const games = expectedGames(played);
      expect(games).toBeGreaterThan(previous);
      previous = games;
    }
  });
});
