import { z } from "zod";
import { weeksBetween } from "./season";

const common = {
  version: z.literal(1),
  points: z.number().finite().min(-10000).max(10000),
  condition: z.literal("active-at-kickoff"),
  historyGames: z.number().int().min(4).max(36),
  lastPlayed: z.object({ season: z.number().int().min(2011).max(2100), index: z.number().int().min(1).max(18) }).strict(),
  historyGapWeeks: z.number().int().min(1).max(36),
  excludedRules: z.array(z.string().min(1).max(100)).max(100),
  evidence: z.literal("exploratory-development-tuning"),
};

/** Explicit, unvalidated alternatives. Neither is an availability-adjusted forecast. */
export const weeklyExperimentalEstimateSchema = z.discriminatedUnion("method", [
  z.object({ ...common, method: z.literal("frozen-model-returning-history"), calibration: z.literal("ppr-only"), scoringScope: z.literal("supported-offense") }).strict(),
  z.object({ ...common, historyGames: z.number().int().min(8).max(18), method: z.literal("kicker-prior-season-game-mean"), calibration: z.literal("none"), scoringScope: z.literal("kicking-events-only") }).strict(),
]);

export type WeeklyExperimentalEstimate = z.infer<typeof weeklyExperimentalEstimateSchema>;

/** Shared trust-boundary check; unknown versions/methods/calibration cannot become model points. */
export function validWeeklyExperimentalEstimate(value: unknown, season: number, week: number, positions: readonly string[]): value is WeeklyExperimentalEstimate {
  const parsed = weeklyExperimentalEstimateSchema.safeParse(value);
  if (!parsed.success) return false;
  const row = parsed.data;
  if (row.lastPlayed.season !== season - 1 || weeksBetween(row.lastPlayed, { season, index: week }) !== row.historyGapWeeks) return false;
  if (row.method === "frozen-model-returning-history") {
    return week === 1 && row.historyGapWeeks > 4 && positions.some(position => ["QB", "RB", "WR", "TE", "FB"].includes(position));
  }
  return week === 1 && positions.length === 1 && positions[0] === "K";
}
