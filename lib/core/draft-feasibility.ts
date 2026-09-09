import { solveLineup, type RosterSlot } from "./optimizer";
import type { PlayerRisk } from "./roster-utility";

/** Structural coverage: no projections, waiver stand-ins, byes or sampled outcomes. */
export function filledStarterCount(roster: readonly PlayerRisk[], slots: readonly RosterSlot[]): number {
  // Same-position players are interchangeable for this cardinality-only solve.
  // Cap the broad available pool at the number that could ever start there.
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  const relevant = roster.filter((player) => {
    if (seen.has(player.id)) return false;
    seen.add(player.id);
    const count = counts.get(player.position) ?? 0;
    if (count >= slots.filter((slot) => slot.eligiblePositions.includes(player.position)).length) return false;
    counts.set(player.position, count + 1);
    return true;
  });
  return solveLineup(slots, relevant.map((player) => ({
    id: player.id, name: player.name, position: player.position,
    projectedPoints: 1, availability: "active" as const,
  }))).assignments.filter((assignment) => assignment.competitorId !== null).length;
}

export interface DraftCompletionGuard {
  candidates: PlayerRisk[];
  missingStarters: number;
  /** Feasible now, assuming remaining valued players are not taken by opponents. */
  canComplete: boolean;
  reason: "unrestricted" | "starter-deadline" | "last-position-supply";
}

/**
 * A valuation heuristic may prefer bench depth to a fully streamable empty slot.
 * That is not permission to finish a draft without its required starter.
 *
 * With only as many selections as missing starters, each pick must increase the
 * maximum-cardinality matching. Single-position players make that condition exact:
 * each acquisition can add at most one match. FLEX and SUPERFLEX need matching, not
 * independent position counts. Impossible inputs stay impossible, explicitly reported;
 * no unavailable player or hypothetical waiver signing is fabricated.
 *
 * Before intervening opponents, also prioritize a position whose entire remaining
 * supply is needed by this roster. This is a conservative scarcity guard, not a
 * guarantee against arbitrary opponents consuming several required positions at once.
 */
export function guardDraftCompletion(
  roster: readonly PlayerRisk[],
  available: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
  picksRemaining: number,
  opponentsBeforeNext = 0,
): DraftCompletionGuard {
  const held = new Set(roster.map((player) => player.id));
  const pool = available.filter((player) => !held.has(player.id));
  const filled = filledStarterCount(roster, slots);
  const missingStarters = slots.length - filled;
  const canComplete = missingStarters === 0 || (missingStarters <= picksRemaining &&
    filledStarterCount([...roster, ...pool], slots) === slots.length);
  const result = (candidates: PlayerRisk[], reason: DraftCompletionGuard["reason"]): DraftCompletionGuard => ({
    candidates, missingStarters, canComplete, reason,
  });
  if (picksRemaining <= 0) return result([], "starter-deadline");
  if (missingStarters === 0) return result(pool, "unrestricted");

  // Eligibility depends only on position; solve once per distinct position.
  const representatives = new Map(pool.map((player) => [player.position, player]));
  const improves = new Set([...representatives].filter(([, player]) =>
    filledStarterCount([...roster, player], slots) > filled,
  ).map(([position]) => position));
  const needed = pool.filter((player) => improves.has(player.position));
  if (opponentsBeforeNext > 0 && canComplete) {
    const critical = new Set<string>();
    for (const position of improves) {
      const atPosition = pool.filter((player) => player.position === position).length;
      const withoutPosition = filledStarterCount([
        ...roster, ...pool.filter((player) => player.position !== position),
      ], slots);
      const required = slots.length - withoutPosition;
      if (required > 0 && atPosition === required) critical.add(position);
    }
    if (critical.size > 0) return result(pool.filter((player) => critical.has(player.position)), "last-position-supply");
  }
  if (picksRemaining <= missingStarters) {
    // If no starter can be acquired, retain real bench options but report infeasibility.
    return result(needed.length > 0 ? needed : pool, "starter-deadline");
  }
  return result(pool, "unrestricted");
}
