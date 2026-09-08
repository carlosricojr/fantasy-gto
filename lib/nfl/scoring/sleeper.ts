import type { Position, ScoreBreakdown } from "./types";

// These are event counts in Sleeper's *weekly stats*, not its incomplete projection
// payload. Unknown nonzero rules fail closed. Zero-valued rules do not affect identity.
const OFFENSE = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt", "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost", "st_td", "st_ff", "st_fum_rec", "fum_rec_td"] as const;
const KICKING = ["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50_59", "fgm_60p", "fgmiss", "xpm", "xpmiss"] as const;
export const SLEEPER_POINTS_ALLOWED_KEYS = ["pts_allow_0", "pts_allow_1_6", "pts_allow_7_13", "pts_allow_14_20", "pts_allow_21_27", "pts_allow_28_34", "pts_allow_35p"] as const;
export const SLEEPER_YARDS_ALLOWED_KEYS = ["yds_allow_0_100", "yds_allow_100_199", "yds_allow_200_299", "yds_allow_300_349", "yds_allow_350_399", "yds_allow_400_449", "yds_allow_450_499", "yds_allow_500_549", "yds_allow_550p"] as const;
const DEFENSE = ["sack", "int", "fum_rec", "ff", "safe", "blk_kick", "def_td", "def_st_td", "def_st_ff", "def_st_fum_rec", ...SLEEPER_POINTS_ALLOWED_KEYS, ...SLEEPER_YARDS_ALLOWED_KEYS] as const;
const SUPPORTED = new Set<string>([...OFFENSE, ...KICKING, ...DEFENSE]);
const PREFIX = "sleeper-v1:";

export interface SleeperScoringProfile {
  /** Exact canonical rules, not a lossy hash or a generic PPR label. */
  id: string;
  coefficients: Readonly<Record<string, number>>;
  adpScoringId: "standard" | "half_ppr" | "ppr";
}

export function parseSleeperScoring(raw: unknown):
  | { ok: true; profile: SleeperScoringProfile }
  | { ok: false; unsupported: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) {
    return { ok: false, unsupported: ["league scoring_settings missing"] };
  }
  const unsupported: string[] = [];
  const entries: [string, number][] = [];
  for (const [key, value] of Object.entries(raw).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (typeof value !== "number" || !Number.isFinite(value)) unsupported.push(`scoring.${key}: invalid value`);
    else if (value !== 0) {
      if (!SUPPORTED.has(key)) unsupported.push(`scoring.${key}: ${value} is not modeled`);
      else entries.push([key, value]);
    }
  }
  const coefficients = Object.fromEntries(entries);
  const rec = coefficients.rec ?? 0;
  // The survival/market source has only these three formats. Do not invent ADP for
  // arbitrary premiums. Exact scoring is kept separate from this market-source label.
  if (![0, 0.5, 1].includes(rec)) unsupported.push(`scoring.rec: no corresponding ADP source for ${rec}`);
  if (entries.length === 0) unsupported.push("league has no supported nonzero scoring rules");
  return unsupported.length > 0 ? { ok: false, unsupported } : {
    ok: true,
    profile: { id: PREFIX + JSON.stringify(coefficients), coefficients, adpScoringId: rec === 1 ? "ppr" : rec === 0.5 ? "half_ppr" : "standard" },
  };
}

export function sleeperScoringFromId(id: string): SleeperScoringProfile | null {
  if (!id.startsWith(PREFIX)) return null;
  try {
    const parsed = parseSleeperScoring(JSON.parse(id.slice(PREFIX.length)));
    return parsed.ok && parsed.profile.id === id ? parsed.profile : null;
  } catch { return null; }
}

/**
 * Sparse absent event counts mean zero in a verified weekly stats row. In contrast,
 * missing DST tier coverage or incomplete kicker distance bands is a source failure.
 * Never apply this function to season projections: those omit required scoring inputs.
 */
export function scoreSleeperWeek(stats: Readonly<Record<string, unknown>>, position: Position, profile: SleeperScoringProfile): ScoreBreakdown {
  const count = (key: string): number => {
    const value = stats[key] === undefined ? 0 : stats[key];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid Sleeper weekly statistic ${key}`);
    return value;
  };
  if (position === "DST") {
    for (const keys of [SLEEPER_POINTS_ALLOWED_KEYS, SLEEPER_YARDS_ALLOWED_KEYS]) {
      if (!keys.some((key) => (profile.coefficients[key] ?? 0) !== 0)) continue;
      const bins = keys.map(count);
      if (bins.some((value) => value !== 0 && value !== 1) || bins.reduce((a, b) => a + b, 0) !== 1) {
        throw new Error(`Incomplete Sleeper weekly DST tier coverage: ${keys[0]}`);
      }
    }
  }
  if (position === "K") {
    const makes = KICKING.slice(0, 6).reduce((total, key) => total + count(key), 0);
    if (makes !== count("fgm")) throw new Error("Incomplete Sleeper weekly kicker distance bands");
    if (stats.fgm_50p !== undefined && count("fgm_50p") !== count("fgm_50_59") + count("fgm_60p")) {
      throw new Error("Incomplete Sleeper weekly kicker 50+/60+ split");
    }
  }
  const keys: readonly string[] = position === "DST" ? DEFENSE : position === "K" ? [...OFFENSE, ...KICKING] : OFFENSE;
  const components = keys.flatMap((key) => {
    const points = count(key) * (profile.coefficients[key] ?? 0);
    return points === 0 ? [] : [{ label: key, points }];
  });
  return { total: components.reduce((total, term) => total + term.points, 0), components };
}
