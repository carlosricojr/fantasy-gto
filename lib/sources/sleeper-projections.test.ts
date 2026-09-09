import { describe, expect, it } from "vitest";
import { parseSleeperAdp, parseSleeperProjections, sleeperProjectionsUrl } from "./sleeper-projections";
import { scoreSleeperProjection, sleeperProjectionFreshness } from "../nfl/sleeper-projections";
import { parseSleeperScoring } from "../nfl/scoring/sleeper";

// Synthetic minimum row matching the observed 2026-09-09 primary endpoint shape.
const now = 1788979800000;
function row(overrides: Record<string, unknown> = {}) {
  return { category: "proj", sport: "nfl", company: "rotowire", season_type: "regular",
    season: "2026", week: 1, player_id: "5844", player: { position: "TE" },
    team: "MIN", opponent: "GB", game_id: "202610120", updated_at: now - 1000,
    last_modified: now - 2000, stats: { gp: 1, rec: 3.73, rec_yd: 35.14, rec_td: 0.2, pts_std: 4.69 }, ...overrides };
}
function profile(coefficients: Record<string, number>) {
  const parsed = parseSleeperScoring(coefficients);
  if (!parsed.ok) throw new Error(parsed.unsupported.join(","));
  return parsed.profile;
}

describe("Sleeper projection import", () => {
  it("retains source timestamps, raw stats, provider totals, and normalized identity", () => {
    const parsed = parseSleeperProjections([row({ team: "LAR", player: { position: "DEF" } })], 2026, 1, now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toMatchObject({ source: "sleeper", company: "rotowire", season: 2026, week: 1,
      retrievedAt: now, providerUpdatedAt: now - 2000, excludedRows: 0 });
    expect(parsed.data.players[0]).toMatchObject({ playerId: "5844", position: "DST", team: "LA",
      stats: { rec: 3.73 }, reportedPoints: { standard: 4.69, half_ppr: null, ppr: null } });
  });

  it("counts ADP-only placeholders and unsupported positions without inventing zero projections", () => {
    const parsed = parseSleeperProjections([row(), row({ player_id: "2", stats: { adp_dd_ppr: 999 } }),
      row({ player_id: "3", player: { position: "DB" } })], 2026, 1, now);
    expect(parsed.ok && parsed.data.excludedRows).toBe(2);
    expect(parseSleeperProjections([row({ stats: { gp: 1 } })], 2026, 1, now).ok).toBe(false);
    expect(parseSleeperProjections([row({ stats: { gp: 1, pts_std: 0 } })], 2026, 1, now).ok).toBe(true);
  });

  it.each([{ season: "2025" }, { week: 2 }, { category: "stat" }, { sport: "nba" },
    { company: "unknown" }, { season_type: "post" }, { stats: null }, { player_id: "" }])(
    "rejects unexpected source dimensions or missing identity: %j", overrides => {
      expect(parseSleeperProjections([row(overrides)], 2026, 1, now).ok).toBe(false);
    },
  );

  it("rejects duplicates and malformed payloads", () => {
    expect(parseSleeperProjections([row(), row()], 2026, 1, now).ok).toBe(false);
    for (const payload of [null, {}, [], [null]]) expect(parseSleeperProjections(payload, 2026, 1, now).ok).toBe(false);
    expect(parseSleeperProjections([row()], 2026, 1, NaN).ok).toBe(false);
  });

  it("cannot refresh old or unknown source data just by importing it now", () => {
    const result = parseSleeperProjections([row({ updated_at: null, last_modified: null })], 2026, 1, now);
    expect(result.ok && result.data.providerUpdatedAt).toBe(null);
    expect(sleeperProjectionFreshness(null, now, 1000)).toBe("unknown");
    expect(sleeperProjectionFreshness(now - 1001, now, 1000)).toBe("stale");
    expect(sleeperProjectionFreshness(now - 1000, now, 1000)).toBe("fresh");
    expect(sleeperProjectionFreshness(now + 1, now, 1000)).toBe("future");
    expect(() => sleeperProjectionFreshness(now, now, 0)).toThrow();
  });

  it("validates URL inputs and keeps season summaries distinct from weekly data", () => {
    expect(sleeperProjectionsUrl(2026)).toBe("https://api.sleeper.com/projections/nfl/2026?season_type=regular");
    expect(() => sleeperProjectionsUrl(2026, 0)).toThrow();
    expect(() => sleeperProjectionsUrl(NaN, 1)).toThrow();
    expect(parseSleeperProjections([row()], 2026, 0, now).ok).toBe(false);
    expect(parseSleeperAdp([row({ week: null })], NaN, "ppr", now).ok).toBe(false);
    expect(parseSleeperProjections([row({ week: null })], 2026, 1, now).ok).toBe(false);
  });

  it("returns the same trimmed identity it uses to detect collisions", () => {
    const parsed = parseSleeperProjections([row({ player_id: " 5844 " })], 2026, 1, now);
    expect(parsed.ok && parsed.data.players[0].playerId).toBe("5844");
    expect(parseSleeperProjections([row(), row({ player_id: " 5844 " })], 2026, 1, now).ok).toBe(false);
  });
});

describe("platform ADP comparison", () => {
  it("selects the exact format, retains missing price and never invents dispersion or league size", () => {
    const parsed = parseSleeperAdp([row({ week: null, stats: { adp_half_ppr: 183.6, adp_ppr: 165.9 } }),
      row({ player_id: "2", week: null, stats: { adp_half_ppr: 999 } })], 2026, "half_ppr", now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data).toMatchObject({ sourceField: "adp_half_ppr", format: "half_ppr", sourceTeams: null });
    expect(parsed.data.players[0]).toMatchObject({ adp: 183.6, stdev: null, timesDrafted: null });
    expect(parsed.data.players[1].adp).toBe(null);
  });
  it("does not substitute another format or search rank for an absent market", () => {
    for (const stats of [{ adp_ppr: 32, search_rank: 1 }, { adp_half_ppr: 999 }, { adp_half_ppr: "12" }]) {
      expect(parseSleeperAdp([row({ week: null, stats })], 2026, "half_ppr", now).ok).toBe(false);
    }
  });
  it("preserves the source's two-QB label without asserting superflex equivalence", () => {
    const parsed = parseSleeperAdp([row({ week: null, stats: { adp_2qb: 130 } })], 2026, "two_qb", now);
    expect(parsed.ok && parsed.data.sourceField).toBe("adp_2qb");
  });
});

describe("strict expected-stat custom scoring", () => {
  it("scores fractional expected counts under the exact supplied coefficients", () => {
    const scored = scoreSleeperProjection({ position: "TE", stats: { rec: 3.73, rec_yd: 35.14, rec_td: 0.2 } },
      profile({ rec: 0.5, rec_yd: 0.1, rec_td: 6 }));
    expect(scored.ok && scored.points).toBeCloseTo(6.579);
  });
  it("reports every missing scored counter instead of manufacturing zeros or using provider totals", () => {
    const scored = scoreSleeperProjection({ position: "TE", stats: { rec: 3.73, pts_ppr: 8.42 } },
      profile({ rec: 1, pass_td: 6, rush_td: 6, st_td: 6 }));
    expect(scored).toEqual({ ok: false, missingStats: ["pass_td", "rush_td", "st_td"], unsupportedRules: [] });
  });
  it("accepts explicit zero, rejects null/string/NaN, and preserves negative custom totals", () => {
    expect(scoreSleeperProjection({ position: "QB", stats: { pass_int: 1 } }, profile({ pass_int: -2 })))
      .toMatchObject({ ok: true, points: -2 });
    expect(scoreSleeperProjection({ position: "TE", stats: { rec: 0 } }, profile({ rec: 1 })))
      .toMatchObject({ ok: true, points: 0 });
    for (const rec of [null, "0", NaN]) expect(scoreSleeperProjection({ position: "TE", stats: { rec } }, profile({ rec: 1 })).ok).toBe(false);
  });
  it("rejects defense expected-value tier bins and missing kicker distance data", () => {
    expect(scoreSleeperProjection({ position: "DST", stats: { pts_allow_21_27: 1 } }, profile({ pts_allow_21_27: 1 })))
      .toEqual({ ok: false, missingStats: [], unsupportedRules: ["pts_allow_21_27"] });
    expect(scoreSleeperProjection({ position: "K", stats: { fgm: 1.9 } }, profile({ fgm_20_29: 3 })))
      .toEqual({ ok: false, missingStats: ["fgm_20_29"], unsupportedRules: [] });
  });
});
