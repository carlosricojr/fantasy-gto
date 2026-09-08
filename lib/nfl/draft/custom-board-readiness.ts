import { sleeperScoringFromId } from "../scoring/sleeper";
import { validWeeklyOutcomeRatios } from "../../core/roster-utility";

interface CustomRow {
  position: string;
  blendedPoints: number | null;
  historicalScoringSource?: string;
  weeklyStdDev?: number;
  weeklyOutcomeRatios?: number[];
}

/** A catalog is recordability, not evidence that the custom valuation job succeeded. */
export function customBoardBlock(scoringId: string, rows: readonly CustomRow[]): string | null {
  if (sleeperScoringFromId(scoringId) === null) return null;
  const valued = rows.filter((row) => row.blendedPoints !== null);
  if (valued.length === 0) return "The exact custom-scored board has not been published yet. Catalog identities alone cannot support recommendations.";
  if (valued.some((row) => row.historicalScoringSource !== "sleeper-custom-stats")) {
    return "Waiting for values built under this exact Sleeper scoring profile. Preset values cannot be substituted.";
  }
  if (valued.some((row) => !Number.isFinite(row.blendedPoints) ||
    ((row.position === "K" || row.position === "DST") &&
      (row.weeklyStdDev === undefined || !Number.isFinite(row.weeklyStdDev) || row.weeklyStdDev < 0)))) {
    return "Custom-scored values or signed K/DST ranges are incomplete. Rebuild the board before relying on estimates.";
  }
  if (valued.some((row) => ["QB", "RB", "WR", "TE"].includes(row.position) &&
    (row.weeklyStdDev !== undefined || !validWeeklyOutcomeRatios(row.weeklyOutcomeRatios)))) {
    return "Custom weekly outcome distributions are incomplete. Zero-scoring weeks must be modeled before estimates are available.";
  }
  return null;
}
