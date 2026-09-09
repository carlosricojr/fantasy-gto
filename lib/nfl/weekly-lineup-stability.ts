import type { WeeklyLineupPlan, WeeklyLineupSnapshot } from "./weekly-lineup";

export const WEEKLY_STRESS_POINTS = [1, 2, 5] as const;
export type WeeklyStressPoints = typeof WEEKLY_STRESS_POINTS[number];
export type WeeklyLineupStability =
  | { status: "unavailable" | "no-starter-change"; reason: string }
  | {
    status: "compared";
    includedGain: number;
    variablePlayerIds: string[];
    stressPoints: WeeklyStressPoints;
    adverseMargin: number;
    /** Smallest whole-cent radius that can erase the advantage; rounded UP. */
    eraseAdvantagePoints: number;
  };

const unavailable = (reason: string): WeeklyLineupStability => ({ status: "unavailable", reason });
const zeroStatus = new Set(["out", "inactive", "bye", "reserve"]);
const cents = (points: number) => Math.round(points * 100);

/**
 * Sensitivity ONLY versus the imported current starters, not all alternative
 * lineups. Call with the current plan from the SAME snapshot and safety options.
 * No optimization, sampling, availability inference or extra solver invocation.
 *
 * Let D be the valued, non-fixed symmetric difference of the starter sets.
 * Common players, excluded values and known-unavailable zeros cancel. Allow
 * every D estimate independently to move by ±r points, including below zero.
 * Adverse margin = included gain - r * |D|, attained by lowering proposed-only
 * players and raising current-only players. This is a stress assumption, not an
 * empirical error interval. The two assignments and all safety gates stay fixed.
 * Runs in O(players + slots), within the planner's 32-player/12-slot bounds.
 */
export function analyzeWeeklyLineupStability(
  snapshot: WeeklyLineupSnapshot | null,
  plan: WeeklyLineupPlan | null,
  stressPoints: WeeklyStressPoints = 1,
): WeeklyLineupStability {
  if (!snapshot || !plan || plan.status === "blocked" || plan.gain === null || plan.currentProjectedPoints === null || plan.projectedPoints === null) {
    return unavailable("A current, non-blocked comparison with your current starters is required.");
  }
  if (!WEEKLY_STRESS_POINTS.includes(stressPoints) || snapshot.players.length > 32 || snapshot.slots.length > 12) return unavailable("Unsupported stress setting or roster size.");
  const players = new Map(snapshot.players.map((p) => [p.id, p]));
  const slots = new Set(snapshot.slots.map((s) => s.id));
  const excludedSlots = new Set(plan.excludedSlotIds);
  const excludedPlayers = new Set(plan.excludedPlayerIds);
  if (players.size !== snapshot.players.length || slots.size !== snapshot.slots.length || plan.assignments.length !== slots.size || new Set(plan.assignments.map((a) => a.slotId)).size !== slots.size) return unavailable("The comparison does not match this roster.");
  const current = snapshot.players.filter((p) => p.currentSlotId !== null && !excludedSlots.has(p.currentSlotId));
  if (current.length === 0) return unavailable("There are no included current starters to compare.");
  const currentIds = new Set(current.map((p) => p.id));
  const proposedIds = new Set<string>();
  const fixedIds = new Set<string>();
  let proposedCents = 0;
  for (const assignment of plan.assignments) {
    if (!slots.has(assignment.slotId)) return unavailable("The comparison does not match this roster.");
    const player = assignment.playerId === null ? null : players.get(assignment.playerId);
    if (player === undefined || (player && proposedIds.has(player.id))) return unavailable("The comparison does not match this roster.");
    if (assignment.fixed && player) {
      if (player.currentSlotId !== assignment.slotId) return unavailable("A fixed assignment differs from your current starters.");
      fixedIds.add(player.id);
    }
    if (excludedSlots.has(assignment.slotId)) continue;
    if (player) proposedIds.add(player.id);
    const expected = player ? zeroStatus.has(player.availability) ? 0 : player.projectedPoints : 0;
    if (expected === null || !Number.isFinite(expected) || assignment.points === null || cents(expected) !== cents(assignment.points)) return unavailable("The included estimates no longer match this comparison.");
    proposedCents += cents(expected);
  }
  let currentCents = 0;
  for (const player of current) {
    const value = zeroStatus.has(player.availability) ? 0 : player.projectedPoints;
    if (!slots.has(player.currentSlotId!) || value === null || !Number.isFinite(value)) return unavailable("Your current starters lack a comparable included total.");
    currentCents += cents(value);
  }
  const gainCents = proposedCents - currentCents;
  if (gainCents < 0 || !Number.isSafeInteger(gainCents) || gainCents !== cents(plan.gain) || currentCents !== cents(plan.currentProjectedPoints) || proposedCents !== cents(plan.projectedPoints)) return unavailable("The included totals no longer match this comparison.");
  const changed = snapshot.players.filter((p) => currentIds.has(p.id) !== proposedIds.has(p.id));
  if (changed.length === 0) return { status: "no-starter-change", reason: "The same players start; slot moves do not change the included total versus your current starters." };
  const variablePlayerIds = changed.filter((p) => !fixedIds.has(p.id) && !excludedPlayers.has(p.id) && !zeroStatus.has(p.availability) && p.projectedPoints !== null).map((p) => p.id).sort();
  if (variablePlayerIds.length === 0) return unavailable("No changed, variable included estimates can be stressed versus your current starters.");
  return {
    status: "compared", includedGain: gainCents / 100, variablePlayerIds, stressPoints,
    adverseMargin: (gainCents - cents(stressPoints) * variablePlayerIds.length) / 100,
    eraseAdvantagePoints: Math.ceil(gainCents / variablePlayerIds.length) / 100,
  };
}
