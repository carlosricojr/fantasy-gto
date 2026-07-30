/**
 * Sport-agnostic domain vocabulary.
 *
 * These types deliberately contain nothing about football. They are the terms the
 * optimizer, the projection contract, and the provider interfaces are written in, so that
 * adding a sport means supplying adapters rather than editing shared logic.
 *
 * The line to hold: a concept belongs here only if a second sport would genuinely share
 * it. Anything football-specific — target share, points-allowed tiers, PPR — lives under
 * `lib/nfl`. Widening this file to fit one sport's quirk is how a shared core rots.
 */

/** Sports the platform can be extended to. Only `nfl` is implemented today. */
export const SPORTS = ["nfl"] as const;
export type SportId = (typeof SPORTS)[number];

/**
 * A scoring period. For the NFL this is a season plus a week; for a daily sport it would
 * be a season plus a date index. `index` is always monotonically increasing within a
 * season so periods sort correctly without sport-specific comparison logic.
 */
export interface Period {
  season: number;
  index: number;
}

export function periodKey(period: Period): string {
  return `${period.season}-${String(period.index).padStart(2, "0")}`;
}

export function comparePeriods(a: Period, b: Period): number {
  return a.season - b.season || a.index - b.index;
}

/** A person who accumulates production. A "player" in every sport that has them. */
export interface Competitor {
  /** Stable upstream identifier. The join key for all historical data. */
  id: string;
  name: string;
  /** Sport-specific position code, e.g. `WR`. Kept as a string in the shared core. */
  position: string;
  /** Team abbreviation, or `null` for a free agent. */
  team: string | null;
}

/** A scheduled event between two teams. */
export interface Contest {
  id: string;
  period: Period;
  homeTeam: string;
  awayTeam: string;
  /** ISO-8601 kickoff timestamp, or `null` when unscheduled. */
  startsAt: string | null;
  /** Present once the contest has been played. */
  result: { homeScore: number; awayScore: number } | null;
}

/**
 * Betting market prices for a contest.
 *
 * This exists today because the projection model consumes the implied team total derived
 * from `spread` and `total`. It is also the exact surface a future betting feature would
 * read from, which is why it is defined as a market concept rather than buried inside the
 * NFL model.
 *
 * `spread` is expressed from the home team's perspective: positive means the home team is
 * favoured by that many points. This convention is asserted in tests because getting it
 * backwards inverts every adjustment derived from it.
 */
export interface MarketLine {
  contestId: string;
  spread: number | null;
  total: number | null;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
}

/**
 * One named, signed term in a projection.
 *
 * Contributions are a product feature, not diagnostics: they are what the interface shows
 * to explain a number. They must sum to the projected mean, which the model's tests
 * assert, so an unexplained residual can never reach a user.
 */
export interface Contribution {
  /** Stable machine key, e.g. `usage.targets`. */
  key: string;
  /** Human-readable label shown in the interface. */
  label: string;
  /** Signed points contributed. */
  points: number;
  /** One sentence of plain English explaining this term. */
  detail: string;
}

/**
 * A projection for one competitor in one period.
 *
 * `floor` and `ceiling` are quantiles of the modelled outcome distribution, not
 * best/worst cases, and satisfy `floor <= mean <= ceiling`.
 */
export interface Projection {
  competitorId: string;
  period: Period;
  position: string;
  mean: number;
  floor: number;
  ceiling: number;
  contributions: Contribution[];
  /** Identifies the model version that produced this, for reproducibility. */
  modelVersion: string;
}

/** Confidence in a projection, driven by how much history backs it. */
export type ProjectionConfidence = "high" | "medium" | "low";

export function confidenceFromSampleSize(games: number): ProjectionConfidence {
  if (games >= 6) return "high";
  if (games >= 3) return "medium";
  return "low";
}
