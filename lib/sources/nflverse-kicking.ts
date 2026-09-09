import type { Period } from "../core/domain";
import type { CsvRow } from "../nfl/csv";
import { priorSeasonCoverageBaseline } from "../nfl/model/coverage-baseline";
import { sleeperScoringFromId, type SleeperScoringProfile } from "../nfl/scoring/sleeper";

export const NFLVERSE_KICKING_COUNTERS = {
  fgm_0_19: "fg_made_0_19", fgm_20_29: "fg_made_20_29", fgm_30_39: "fg_made_30_39",
  fgm_40_49: "fg_made_40_49", fgm_50_59: "fg_made_50_59", fgm_60p: "fg_made_60_",
  fgmiss: "fg_missed", xpm: "pat_made", xpmiss: "pat_missed",
} as const;
type KickingRule = keyof typeof NFLVERSE_KICKING_COUNTERS;
const OFFENSE = ["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt", "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost", "st_td", "st_ff", "st_fum_rec", "fum_rec_td"];

export interface NflverseKickingWeek {
  playerId: string;
  period: Period;
  /** Invalid/missing counters remain a row-level failure, never a zero or a dropped game. */
  counts: Record<KickingRule, number> | null;
}

/** Parse the raw CSV before the legacy general-purpose parser's absent-counter defaults. */
export function parseNflverseKickingWeeks(rows: readonly CsvRow[], season: number): NflverseKickingWeek[] {
  return rows.filter(row => row.position === "K" && row.season_type === "REG" && (row.player_id ?? "").trim() !== "").map(row => {
    const counters = Object.entries(NFLVERSE_KICKING_COUNTERS).map(([key, column]) => [key, row[column]?.trim() ? Number(row[column]) : NaN] as const);
    const valid = Number(row.season) === season && Number.isInteger(Number(row.week)) && Number(row.week) >= 1 && Number(row.week) <= 18
      && counters.every(([, count]) => Number.isInteger(count) && count >= 0);
    // If upstream provides a total, it must reconcile with all six distance bands.
    const makes = counters.slice(0, 6).reduce((sum, [, count]) => sum + count, 0);
    const totalMatches = row.fg_made === undefined || (row.fg_made.trim() !== "" && Number(row.fg_made) === makes);
    return { playerId: row.player_id, period: { season, index: Number(row.week) },
      counts: valid && totalMatches ? Object.fromEntries(counters) as Record<KickingRule, number> : null };
  });
}

/** Only explicitly observed kicking events, under the imported coefficients. No offense imputation. */
export function nflverseKickingBaseline(rows: readonly NflverseKickingWeek[], playerId: string, target: Period, profile: SleeperScoringProfile) {
  const canonical = sleeperScoringFromId(profile.id);
  if (canonical === null || JSON.stringify(canonical.coefficients) !== JSON.stringify(profile.coefficients)) return null;
  if (target.index !== 1 || !Object.keys(NFLVERSE_KICKING_COUNTERS).some(key => (profile.coefficients[key] ?? 0) !== 0)) return null;
  const prior = rows.filter(row => row.playerId === playerId && row.period.season === target.season - 1);
  if (prior.some(row => row.counts === null || Object.keys(NFLVERSE_KICKING_COUNTERS).some(key => {
    const count = row.counts![key as KickingRule];
    return !Number.isInteger(count) || count < 0;
  }))) return null;
  const scored = prior.map(row => ({ period: row.period, points: Object.entries(row.counts!).reduce((sum, [key, count]) => sum + count * (profile.coefficients[key] ?? 0), 0) }));
  const baseline = priorSeasonCoverageBaseline(scored, target);
  return baseline === null || Math.abs(baseline.points) > 10000 ? null : { ...baseline, excludedRules: OFFENSE.filter(key => (profile.coefficients[key] ?? 0) !== 0) };
}
