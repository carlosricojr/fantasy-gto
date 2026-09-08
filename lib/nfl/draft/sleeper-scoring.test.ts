import { describe, expect, it } from "vitest";
import { unsupportedSleeperScoring } from "./sleeper-scoring";

/** Synthetic rules: exact model compatibility is tested, not claimed for Sleeper defaults. */
export const COMPATIBLE_SLEEPER_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, pass_2pt: 2, rush_2pt: 2, rec_2pt: 2, st_td: 6,
};
describe("actual league scoring versus draft metadata", () => {
  it("accepts represented coefficients, including half and non-PPR", () => {
    for (const [identity, rec] of [["ppr", 1], ["half_ppr", 0.5], ["standard", 0]] as const) {
      expect(unsupportedSleeperScoring(identity, { ...COMPATIBLE_SLEEPER_SCORING, rec })).toEqual([]);
    }
  });
  it("rejects six-point passing TDs even when the label still says PPR", () => {
    expect(unsupportedSleeperScoring("ppr", { ...COMPATIBLE_SLEEPER_SCORING, pass_td: 6 })).toEqual(["scoring.pass_td: 6 (board 4)"]);
  });
  it("accepts observed float32 representation error but rejects a different coefficient", () => {
    expect(unsupportedSleeperScoring("ppr", { ...COMPATIBLE_SLEEPER_SCORING, pass_yd: 0.03999999910593033, rush_yd: 0.10000000149011612, rec_yd: 0.10000000149011612 })).toEqual([]);
    expect(unsupportedSleeperScoring("ppr", { ...COMPATIBLE_SLEEPER_SCORING, pass_yd: 0.04001 })).toHaveLength(1);
  });
  it("rejects unmodeled bonuses and individual special-teams scoring", () => {
    for (const key of ["bonus_pass_td_50p", "bonus_rec_te", "rec_fd", "fum_rec_td", "st_fum_rec", "new_unknown_stat"]) {
      expect(unsupportedSleeperScoring("ppr", { ...COMPATIBLE_SLEEPER_SCORING, [key]: 1 })).toEqual([`scoring.${key}: 1 is not modeled`]);
    }
  });
  it("does not call absent, empty or malformed league rules verified", () => {
    for (const raw of [null, undefined, {}, [], "ppr"]) expect(unsupportedSleeperScoring("ppr", raw).length).toBeGreaterThan(0);
    expect(unsupportedSleeperScoring("ppr", { ...COMPATIBLE_SLEEPER_SCORING, rec: "1" })).toContain("scoring.rec: invalid value");
  });
  it("keeps K/DST outside the offensive match, without ignoring unknown offensive keys", () => {
    expect(unsupportedSleeperScoring("ppr", { ...COMPATIBLE_SLEEPER_SCORING, sack: 0, def_td: 6, xpm: 1, pts_allow_0: 0, bonus_rec_te: 0 })).toEqual([]);
  });
});
