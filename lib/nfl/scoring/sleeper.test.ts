import { describe, expect, it } from "vitest";
import { parseSleeperScoring, scoreSleeperWeek, sleeperScoringFromId } from "./sleeper";

// Minimal rules fixture verified against league 1389387330229374976, September 7 2026.
const rules = {
  pass_yd: .04, pass_td: 4, pass_int: -2, pass_2pt: 2,
  rush_yd: .1, rush_td: 6, rush_2pt: 2, rec: .5, rec_yd: .1, rec_td: 6,
  rec_2pt: 2, fum_lost: -2, st_td: 6, st_ff: 1, st_fum_rec: 1, fum_rec_td: 6,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5,
  fgm_60p: 6, fgmiss: -1, xpm: 1, xpmiss: -1,
  sack: 1, int: 2, fum_rec: 2, ff: 1, safe: 2, blk_kick: 2,
  def_td: 6, def_st_td: 6, def_st_ff: 1, def_st_fum_rec: 1,
  pts_allow_0: 5, pts_allow_1_6: 4, pts_allow_7_13: 3, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
  yds_allow_0_100: 5, yds_allow_100_199: 3, yds_allow_200_299: 2,
  yds_allow_300_349: 0, yds_allow_350_399: -1, yds_allow_400_449: -3,
  yds_allow_450_499: -5, yds_allow_500_549: -6, yds_allow_550p: -7,
};
const parsed = parseSleeperScoring(rules);
if (!parsed.ok) throw new Error(parsed.unsupported.join(", "));
const profile = parsed.profile;

describe("exact Sleeper scoring profiles", () => {
  it("uses canonical coefficients as identity, with separate half-PPR market source", () => {
    expect(profile.adpScoringId).toBe("half_ppr");
    const reordered = parseSleeperScoring({ ...Object.fromEntries(Object.entries(rules).reverse()), unknown_disabled_bonus: 0 });
    expect(reordered).toEqual(parsed);
    expect(sleeperScoringFromId(profile.id)).toEqual(profile);
    expect(sleeperScoringFromId("sleeper-v1:{}")).toBeNull();
    expect(sleeperScoringFromId("half_ppr")).toBeNull();
    expect(parseSleeperScoring({ ...rules, fgm_60p: 5 })).not.toEqual(parsed);
  });
  it.each([null, {}, [], { rec: NaN }, { rec: .7 }, { ...rules, bonus_rec_te: 1 }])("rejects absent, malformed or unsupported rules %j", (input) => {
    expect(parseSleeperScoring(input).ok).toBe(false);
  });
  it("scores individual return and recovery events without applying defense events", () => {
    const result = scoreSleeperWeek({ rec: 3, rec_yd: 40, st_td: 1, st_ff: 1, st_fum_rec: 1, fum_rec_td: 1, def_st_td: 1 }, "WR", profile);
    expect(result.total).toBe(19.5);
    expect(result.components.reduce((sum, item) => sum + item.points, 0)).toBe(result.total);
  });
  it("scores verified CHI week 1 2024 stats with both touchdowns, blocked kick and custom tiers", () => {
    const stats = { sack: 3, int: 2, ff: 1, fum_rec: 1, def_td: 1, def_st_td: 1, blk_kick: 1, pts_allow_14_20: 1, yds_allow_200_299: 1 };
    expect(scoreSleeperWeek(stats, "DST", profile).total).toBe(27);
    expect(scoreSleeperWeek({ ...stats, st_td: 1 }, "DST", profile).total).toBe(27);
  });
  it("requires complete, single weekly DST tiers, including zero-point bins", () => {
    expect(scoreSleeperWeek({ pts_allow_21_27: 1, yds_allow_300_349: 1 }, "DST", profile).total).toBe(0);
    expect(() => scoreSleeperWeek({ pts_allow_21_27: 1 }, "DST", profile)).toThrow("tier coverage");
    expect(() => scoreSleeperWeek({ pts_allow_0: 1, pts_allow_1_6: 1, yds_allow_0_100: 1 }, "DST", profile)).toThrow("tier coverage");
  });
  it("scores 60+ at six and checks distance-band completeness", () => {
    expect(scoreSleeperWeek({ fgm: 2, fgm_50p: 2, fgm_50_59: 1, fgm_60p: 1, xpm: 2, fgmiss: 1 }, "K", profile).total).toBe(12);
    expect(scoreSleeperWeek({ fgmiss: 1 }, "K", profile).total).toBe(-1);
    expect(() => scoreSleeperWeek({ fgm: 2, fgm_50p: 2 }, "K", profile)).toThrow("distance bands");
    expect(() => scoreSleeperWeek({ fgm: 1, fgm_50p: 2, fgm_50_59: 1 }, "K", profile)).toThrow("50+/60+");
  });
  it("never coerces malformed numeric events to zero", () => {
    expect(() => scoreSleeperWeek({ rec: "3" }, "WR", profile)).toThrow("Invalid");
    expect(() => scoreSleeperWeek({ rec: Infinity }, "WR", profile)).toThrow("Invalid");
  });
});
