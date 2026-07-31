import { describe, expect, it } from "vitest";

import {
  MIN_AVAILABILITY_FOR_RATE,
  blendedSeasonValue,
  expectedGames,
  perGameRate,
  seasonProjection,
} from "./value";
import { MODEL_BLEND_WEIGHT } from "./config";
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
    const durable = rosterUtility([seasonPlayer("d", 240, 0.95)], SLOTS, CONFIG, 11);
    const fragile = rosterUtility([seasonPlayer("f", 240, 0.55)], SLOTS, CONFIG, 11);

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
    const durable = rosterUtility([naive("d", 240, 0.95)], SLOTS, CONFIG, 11);
    const fragile = rosterUtility([naive("f", 240, 0.55)], SLOTS, CONFIG, 11);

    expect(fragile.expectedPoints / durable.expectedPoints).toBeLessThan(0.7);
  });

  it("scales linearly in the season total", () => {
    const single = rosterUtility([seasonPlayer("a", 120, 0.8)], SLOTS, CONFIG, 12);
    const double = rosterUtility([seasonPlayer("a", 240, 0.8)], SLOTS, CONFIG, 12);
    expect(double.expectedPoints / single.expectedPoints).toBeCloseTo(2, 1);
  });
});
