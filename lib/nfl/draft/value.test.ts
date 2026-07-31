import { describe, expect, it } from "vitest";

import { blendedSeasonValue, expectedGames, seasonProjection } from "./value";
import { MODEL_BLEND_WEIGHT } from "./config";

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
