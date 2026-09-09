import { invalid } from "./auth";

/** Per-request budgets, not result truncation or a substitute for authentication. */
export const READ_LIMITS = {
  playerIds: 2_048,
  projections: 1_024,
  boardRows: 2_048,
  catalogRows: 2_048,
  publishedRuns: 16,
  weekContests: 32,
  seasonContests: 400,
  positionPlayers: 500,
} as const;

export function integerIn(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalid(`${label} must be an integer from ${min} to ${max}.`);
  }
}

export function boundedText(value: string, max: number, label: string): void {
  if (value.length === 0 || value.length > max || value.trim() !== value) {
    throw invalid(`${label} must contain 1–${max} characters without surrounding whitespace.`);
  }
}

export function seasonArgs(season: number): void {
  integerIn(season, 2000, 2100, "Season");
}

export function weekArgs(season: number, week: number, scoringId?: string): void {
  seasonArgs(season);
  integerIn(week, 1, 18, "Week");
  if (scoringId !== undefined) boundedText(scoringId, 8_192, "Scoring ID");
}

export function boardArgs(season: number, scoringId: string, teams: number): void {
  seasonArgs(season);
  boundedText(scoringId, 8_192, "Scoring ID");
  // Match the existing normalized draft setup range; a shape with no published market
  // board may still return no rows, rather than introducing a new format restriction.
  integerIn(teams, 2, 32, "Team count");
}

export function positionArg(position: string): void {
  if (!["QB", "RB", "WR", "TE", "K", "DST"].includes(position)) {
    throw invalid("Position must be QB, RB, WR, TE, K or DST.");
  }
}

export function playerIdsArg(ids: readonly string[]): string[] {
  // Bound the raw request before deduplication; repeated IDs are not free to parse.
  if (ids.length > READ_LIMITS.playerIds) throw invalid(`At most ${READ_LIMITS.playerIds} player IDs per request.`);
  for (const id of ids) boundedText(id, 128, "Player ID");
  return [...new Set(ids)];
}

/** Call after take(max + 1): refuse incomplete inputs instead of silently serving a slice. */
export function completeRows<T>(rows: T[], max: number, label: string): T[] {
  if (rows.length > max) throw invalid(`${label} exceeds the safe read budget. No partial result was returned; contact the operator.`);
  return rows;
}
