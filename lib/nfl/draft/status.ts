import type { RosterStatus } from "../weekly-roster";

/** Status should be much fresher than a valuation board during a live draft. */
export const DRAFT_STATUS_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Null is the migration/degraded state: no catalog snapshot has ever published.
 * Existing valued boards remain usable, while the global freshness notice says that the
 * status safety layer is unavailable. A real unknown upstream code is the string
 * `unknown` and is deliberately excluded from advice.
 */
export function isRecommendationEligible(status: RosterStatus | null): boolean {
  return status === null || status === "active";
}

export function rosterStatusLabel(
  status: RosterStatus | null,
  code: string | null,
): string | null {
  if (status === null || status === "active") return null;
  const suffix = code === null || code === "" ? "" : ` (${code})`;
  switch (status) {
    case "reserve":
      return `Reserve${suffix}`;
    case "practice-squad":
      return `Practice squad${suffix}`;
    case "inactive":
      return `Inactive${suffix}`;
    case "cut":
      return `Released${suffix}`;
    case "retired":
      return `Retired${suffix}`;
    case "traded":
      return `Transaction pending${suffix}`;
    case "unknown":
      return `Status needs review${suffix}`;
  }
}

export type DraftStatusHealth =
  | "fresh"
  | "stale"
  | "last-refresh-failed"
  | "refreshing"
  | "never-built"
  | "unknown-designation";

export interface DraftStatusHealthInput {
  now: number;
  publishedAt: number | null;
  lastAttemptFailed: boolean;
  refreshing: boolean;
  unknownStatusCount: number;
}

export function draftStatusHealth(input: DraftStatusHealthInput): DraftStatusHealth {
  if (input.refreshing) return "refreshing";
  if (input.publishedAt === null) return "never-built";
  if (input.lastAttemptFailed) return "last-refresh-failed";
  if (input.now - input.publishedAt > DRAFT_STATUS_STALE_AFTER_MS) return "stale";
  if (input.unknownStatusCount > 0) return "unknown-designation";
  return "fresh";
}

export function describeDraftStatusHealth(
  health: DraftStatusHealth,
  input: Pick<DraftStatusHealthInput, "now" | "publishedAt" | "unknownStatusCount">,
): string {
  const minutes =
    input.publishedAt === null
      ? null
      : Math.max(0, Math.floor((input.now - input.publishedAt) / 60_000));
  switch (health) {
    case "fresh":
      return `Player status updated ${minutes} minute(s) ago.`;
    case "refreshing":
      return "Player status is refreshing now; the last complete snapshot remains in use.";
    case "never-built":
      return "Current player status is unavailable. The board still works, but verify injuries and roster designations before taking a player.";
    case "last-refresh-failed":
      return `The latest player-status refresh failed. The snapshot in use is ${minutes} minute(s) old.`;
    case "stale":
      return `Player status is ${minutes} minute(s) old. Verify roster news before trusting a recommendation.`;
    case "unknown-designation":
      return `${input.unknownStatusCount} player(s) have a missing or new roster designation; the app will not recommend them until it is reviewed.`;
  }
}
