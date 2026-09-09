import type { Period } from "../../core/domain";
import { round2 } from "../scoring/score";

export interface ScoredHistoryWeek {
  period: Period;
  points: number;
}

/** An experimental benchmark, not a calibrated player projection or outcome distribution. */
export interface CoverageBaseline {
  points: number;
  method: "prior-season-game-mean";
  historyGames: number;
  lastPlayed: Period;
  calibration: "none";
}

/** Fixed benchmark already used by the K/DST band audit; no tuning or invented variance. */
export function priorSeasonCoverageBaseline(history: readonly ScoredHistoryWeek[], target: Period): CoverageBaseline | null {
  if (!Number.isInteger(target.season) || !Number.isInteger(target.index) || target.index < 1 || target.index > 18) return null;
  const prior = history.filter(row => row.period.season === target.season - 1);
  if (prior.length < 8 || prior.some(row => !Number.isFinite(row.points) || !Number.isInteger(row.period.index) || row.period.index < 1 || row.period.index > 18)) return null;
  if (new Set(prior.map(row => row.period.index)).size !== prior.length) return null;
  const last = prior.reduce((a, b) => a.period.index > b.period.index ? a : b);
  return { points: round2(prior.reduce((sum, row) => sum + row.points, 0) / prior.length),
    method: "prior-season-game-mean", historyGames: prior.length, lastPlayed: { ...last.period }, calibration: "none" };
}
