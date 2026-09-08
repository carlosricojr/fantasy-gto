import { SCORING_PRESETS } from "../scoring/presets";

/**
 * Keys belonging to the separately disclosed K/DST model limitation. Never ignore an
 * unfamiliar offensive bonus just because the draft metadata still calls the league PPR.
 * Individual-player special teams (`st_*`) are deliberately NOT in this exemption.
 */
const NON_OFFENSE = new Set([
  "sack", "int", "fum_rec", "safe", "blk_kick", "ff", "def_td", "def_2pt",
  "def_st_td", "def_st_ff", "def_st_fum_rec", "def_st_tkl_solo",
  "def_4_and_stop", "def_pass_def", "def_tkl_solo", "def_tkl_ast", "def_tkl_loss",
  "def_sack_yd", "def_3_and_out", "def_forced_punts",
  "xpm", "xpmiss", "fgm", "fgmiss", "fgm_yds", "fgm_yds_over_30",
  "fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50_59", "fgm_60p",
  "fgmiss_0_19", "fgmiss_20_29", "fgmiss_30_39", "fgmiss_40_49", "fgmiss_50_59", "fgmiss_60p",
  "pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20", "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p",
  "yds_allow_0_100", "yds_allow_100_199", "yds_allow_200_299", "yds_allow_300_349", "yds_allow_350_399", "yds_allow_400_449", "yds_allow_450_499", "yds_allow_500_549", "yds_allow_550p",
]);

/** Missing numeric rules mean disabled (zero); a missing rules object means unverified. */
export function unsupportedSleeperScoring(identity: string | null, raw: unknown): string[] {
  const preset = SCORING_PRESETS.find((item) => item.id === identity);
  if (preset === undefined) return [`scoring: ${identity ?? "missing"}`];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return ["league scoring_settings missing; the draft scoring label is not verification"];
  }
  const rules = raw as Record<string, unknown>;
  const offense = preset.offense;
  const expected: Record<string, number> = {
    pass_yd: offense.passingYardsPerPoint, pass_td: offense.passingTd,
    pass_int: offense.passingInterception, rush_yd: offense.rushingYardsPerPoint,
    rush_td: offense.rushingTd, rec: offense.receptionPoints,
    rec_yd: offense.receivingYardsPerPoint, rec_td: offense.receivingTd,
    fum_lost: offense.fumbleLost, pass_2pt: offense.twoPointConversion,
    rush_2pt: offense.twoPointConversion, rec_2pt: offense.twoPointConversion,
    st_td: offense.specialTeamsTd,
  };
  const unsupported: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const actual = rules[key] ?? 0;
    // Sleeper has returned float32-expanded JSON coefficients (0.10000000149011612).
    // One float32 relative epsilon accepts representation error, not different rules.
    if (typeof actual !== "number" || !Number.isFinite(actual) ||
        Math.abs(actual - value) > 2 ** -23 * Math.max(1, Math.abs(value))) {
      unsupported.push(`scoring.${key}: ${String(actual)} (board ${value})`);
    }
  }
  for (const [key, value] of Object.entries(rules)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      unsupported.push(`scoring.${key}: invalid value`);
    } else if (value !== 0 && !Object.prototype.hasOwnProperty.call(expected, key) && !NON_OFFENSE.has(key)) {
      unsupported.push(`scoring.${key}: ${value} is not modeled`);
    }
  }
  return [...new Set(unsupported)].sort();
}
