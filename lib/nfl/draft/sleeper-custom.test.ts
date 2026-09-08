import { describe, expect, it } from "vitest";

import { parseSleeperScoring } from "../scoring/sleeper";
import {
  buildSleeperCustomHistory,
  CUSTOM_SKILL_OUTCOME_KNOTS,
  customAdpImpliedPoints,
  customDstId,
  fitRequiredCustomCurves,
  type CustomBoardIdentity,
  type CustomMarketEntry,
  type SleeperHistoryWeek,
} from "./sleeper-custom";

const profile = (() => {
  const parsed = parseSleeperScoring({
    pass_yd: 0.04, rush_yd: 0.1, rec: 1, rec_yd: 0.1, fgm_20_29: 3, sack: 1,
  });
  if (!parsed.ok) throw new Error(parsed.unsupported.join(", "));
  return parsed.profile;
})();

const positions = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

function stats(position: (typeof positions)[number], multiplier: number) {
  if (position === "QB") return { gp: 1, pass_yd: 100 * multiplier };
  if (position === "RB") return { gp: 1, rush_yd: 40 * multiplier };
  if (position === "WR" || position === "TE") return { gp: 1, rec: multiplier, rec_yd: 30 * multiplier };
  if (position === "K") return { gp: 1, fgm: multiplier, fgm_20_29: multiplier, fgm_0_19: 0, fgm_30_39: 0, fgm_40_49: 0, fgm_50_59: 0, fgm_60p: 0 };
  return { gp: 1, sack: multiplier };
}

function history(): SleeperHistoryWeek[] {
  return positions.flatMap((position, positionIndex) =>
    Array.from({ length: 8 }, (_, index) => [1, 2].map((week) => ({
      playerId: position === "DST" ? `T${index}` : `${position}-${index}`,
      position: position === "DST" ? "DEF" : position,
      team: position === "DST" ? `T${index}` : "CHI",
      season: 2025,
      week,
      stats: stats(position, index + week + positionIndex),
    }))).flat(),
  );
}

function fixture() {
  const current: CustomBoardIdentity[] = positions.flatMap((position) =>
    Array.from({ length: 8 }, (_, index) => ({
      playerId: position === "DST" ? customDstId(`T${index}`) : `${position}-${index}`,
      sleeperId: position === "DST" ? `T${index}` : `${position}-${index}`,
      name: `${position} Player ${index}`,
      position,
      team: position === "DST" ? `T${index}` : "CHI",
    })),
  );
  const market: CustomMarketEntry[] = current.map((identity, index) => ({
    name: identity.name,
    position: identity.position === "DST" ? "DEF" : identity.position,
    team: identity.team,
    adp: index + 1,
    stdev: 4,
    bye: 9,
  }));
  return { current, market };
}

describe("custom Sleeper draft history", () => {
  it("scores raw weekly statistics, preserves canonical team defenses, and measures bands", () => {
    const scored = buildSleeperCustomHistory(history(), profile);
    expect(scored.latestSeasonTotals.get(customDstId("T0"))).toBeGreaterThan(0);
    expect(scored.bands.get("QB")).toMatchObject({ p10: expect.any(Number), p90: expect.any(Number) });
    expect(scored.bands.has("K")).toBe(false);
    expect(scored.bands.has("DST")).toBe(false);
    expect(scored.weeklyStdDev.get("DST")).toBeGreaterThan(0);
    for (const position of ["QB", "RB", "WR", "TE"] as const) {
      const ratios = scored.weeklyOutcomeRatios.get(position)!;
      expect(ratios).toHaveLength(CUSTOM_SKILL_OUTCOME_KNOTS);
      expect(ratios.every(Number.isFinite)).toBe(true);
      expect(ratios.reduce((sum, value) => sum + value, 0) / ratios.length).toBeCloseTo(1, 12);
    }
  });

  it("requires a position-specific custom curve instead of pooling K/DST with PPR skill players", () => {
    const scored = buildSleeperCustomHistory(history(), profile);
    const { current, market } = fixture();
    const curves = fitRequiredCustomCurves({
      season: 2025, current, market, latestSeasonTotals: scored.latestSeasonTotals,
    });
    expect(curves.K.sampleSize).toBe(8);
    expect(curves.DST.sampleSize).toBe(8);
    // D/ST market labels are not stable across seasons; the team identity is. A label
    // refresh must not erase the custom defense curve or change its canonical IDs.
    const renamedDefenses = market.map((entry) => entry.position === "DEF"
      ? { ...entry, name: `Prior season ${entry.name}` }
      : entry);
    expect(fitRequiredCustomCurves({
      season: 2025, current, market: renamedDefenses, latestSeasonTotals: scored.latestSeasonTotals,
    }).DST.sampleSize).toBe(8);
    expect(() => fitRequiredCustomCurves({
      season: 2025,
      current,
      market: market.filter((entry) => entry.position !== "DEF"),
      latestSeasonTotals: scored.latestSeasonTotals,
    })).toThrow(/DST/);
  });

  it("uses each completed ADP/score season independently for sparse PK coverage", () => {
    const scored = buildSleeperCustomHistory(history(), profile);
    const { current, market } = fixture();
    const latestWithoutK = market.filter((entry) => entry.position !== "K");
    const historicalPk = market.map((entry) => entry.position === "K"
      ? { ...entry, position: "PK" }
      : entry);
    const curves = fitRequiredCustomCurves({
      season: 2025,
      current,
      market: latestWithoutK,
      latestSeasonTotals: scored.latestSeasonTotals,
      additionalSources: [{ market: historicalPk, seasonTotals: scored.latestSeasonTotals }],
    });
    expect(curves.K.sampleSize).toBe(8);
  });

  it("rejects conflicting duplicate market matches rather than taking the first ADP row", () => {
    const scored = buildSleeperCustomHistory(history(), profile);
    const { current, market } = fixture();
    const conflicting = { ...market[0], adp: market[0].adp + 100 };
    expect(() => fitRequiredCustomCurves({
      season: 2025,
      current,
      market: [...market, conflicting],
      latestSeasonTotals: scored.latestSeasonTotals,
    })).toThrow(/conflicting entries.*order-dependent/i);
  });

  it("keeps K/DST on additive residuals when every defense has a nonpositive mean", () => {
    const negativeDefenseProfile = (() => {
      const parsed = parseSleeperScoring({
        pass_yd: 0.04, rush_yd: 0.1, rec: 1, rec_yd: 0.1,
        fgm_20_29: 3, sack: -1,
      });
      if (!parsed.ok) throw new Error(parsed.unsupported.join(", "));
      return parsed.profile;
    })();
    const scored = buildSleeperCustomHistory(history(), negativeDefenseProfile);
    expect(scored.latestSeasonTotals.get(customDstId("T0"))).toBeLessThanOrEqual(0);
    expect(scored.weeklyStdDev.get("DST")).toBeGreaterThan(0);
    expect(scored.bands.has("DST")).toBe(false);
  });

  it("does not turn a signed custom defense curve into a zero-valued one", () => {
    const curves = Object.fromEntries(positions.map((position) => [position, {
      intercept: position === "DST" ? -20 : 100,
      slope: 0,
      sampleSize: 8,
      season: 2025,
    }])) as Record<(typeof positions)[number], { intercept: number; slope: number; sampleSize: number; season: number }>;
    expect(customAdpImpliedPoints(12, "DST", curves)).toBe(-20);
  });
});
