import type { RosterSlot } from "../core/optimizer";
import { validWeeklyExperimentalEstimate, type WeeklyExperimentalEstimate } from "./weekly-experimental";

export type WeeklyAvailability = "active" | "questionable" | "doubtful" | "out" | "inactive" | "bye" | "reserve" | "unknown";

export interface WeeklyConditionalEstimate {
  points: number;
  condition: "active-at-kickoff";
  missingEvidence: "team-injury-report";
}

export interface WeeklyPlayer {
  id: string;
  name: string;
  positions: readonly string[];
  availability: WeeklyAvailability;
  /** null means the kickoff is unknown, never that the player has not started. */
  kickoffAt: number | null;
  currentSlotId: string | null;
  /** Supplied objective value; model/provisional omissions remain explicit. Absent is not zero. */
  projectedPoints: number | null;
  projectionOrigin?: "model" | "model-conditional" | "experimental" | "manual";
  conditionalEstimate?: WeeklyConditionalEstimate;
  experimentalEstimate?: WeeklyExperimentalEstimate;
  projectionMissingReason?: string | null;
  projectionEnteredAt?: number;
  team?: string | null;
  gameId?: string | null;
  gameContextConflict?: boolean;
  /** Per-player evidence survives roster-only refreshes even when no model values do. */
  nflverseAvailability?: WeeklyAvailability;
  injuryCoverage?: "available" | "unavailable";
  modelGameContextChecked?: boolean;
}

export interface WeeklyModelEvidence {
  source: string;
  computedAt: number;
  providerUpdatedAt: number | null;
  excludedRules: readonly string[];
  warnings: readonly string[];
  coverage: { requested: number; projected: number };
}

export interface WeeklyLineupSnapshot {
  leagueId: string;
  ownerId: string;
  season: number;
  week: number;
  scoringId: string;
  leagueName: string;
  slots: readonly RosterSlot[];
  players: readonly WeeklyPlayer[];
  source: string;
  retrievedAt: number;
  /** Provider publication time, distinct from when this app fetched the response. */
  projectionUpdatedAt: number | null;
  rosterRetrievedAt: number;
  /** Source limitations travel with imported estimates and cannot be cleared by entry. */
  warnings?: readonly string[];
  model?: WeeklyModelEvidence;
  refreshFailed?: boolean;
}

export interface WeeklyAssignment {
  slotId: string;
  playerId: string | null;
  points: number | null;
  fixed: boolean;
}

export interface WeeklyLineupPlan {
  status: "blocked" | "conditional" | "ready";
  problems: string[];
  warnings: string[];
  assignments: WeeklyAssignment[];
  /** Scoped total excludes fixed unpriced players. Never a full-team total in scoped mode. */
  projectedPoints: number | null;
  currentProjectedPoints: number | null;
  gain: number | null;
  excludedSlotIds: string[];
  excludedPlayerIds: string[];
  benchIds: string[];
}

const UNAVAILABLE = new Set<WeeklyAvailability>(["out", "inactive", "bye", "reserve"]);
const STATUSES = new Set<WeeklyAvailability>(["active", "questionable", "doubtful", "out", "inactive", "bye", "reserve", "unknown"]);
const eligible = (slot: RosterSlot, player: WeeklyPlayer) => player.positions.some((p) => slot.eligiblePositions.includes(p));
const cents = (points: number) => Math.round(points * 100);

/**
 * Exact subset DP, bounded to ordinary fantasy rosters. Primary objective is total
 * expected points in cents. Only equal-point alternatives prefer later kickoffs in
 * broader slots, leaving those slots usable longer. No realized-outcome claim follows.
 * Unknown K/DST values may be explicitly held fixed; they never become zero estimates.
 */
export function planWeeklyLineup(
  snapshot: WeeklyLineupSnapshot,
  options: { now: number; maxProjectionAgeMs: number; maxRosterAgeMs: number; holdUnpricedPositions?: readonly string[]; compareAvailableEstimates?: boolean; allowConditionalEstimates?: boolean; allowExperimentalEstimates?: boolean },
): WeeklyLineupPlan {
  const problems: string[] = [];
  const warnings: string[] = [...(snapshot.warnings ?? [])];
  const result: WeeklyLineupPlan = { status: "blocked", problems, warnings, assignments: [], projectedPoints: null, currentProjectedPoints: null, gain: null, excludedSlotIds: [], excludedPlayerIds: [], benchIds: [] };
  const { slots, players } = snapshot;
  if (snapshot.refreshFailed) problems.push("The latest roster refresh failed. Refresh successfully before using a lineup recommendation; entered values are retained.");
  if (!Number.isInteger(snapshot.season) || snapshot.season < 2000 || !Number.isInteger(snapshot.week) || snapshot.week < 1 || snapshot.week > 18) problems.push("Invalid season or regular-season week.");
  if (!snapshot.scoringId || !snapshot.source) problems.push("Exact scoring identity and projection source are required.");
  if (!Number.isFinite(options.now) || !Number.isFinite(options.maxProjectionAgeMs) || !Number.isFinite(options.maxRosterAgeMs) || options.maxProjectionAgeMs <= 0 || options.maxRosterAgeMs <= 0) problems.push("Invalid clock or freshness limits.");
  if (slots.length === 0 || slots.length > 12 || players.length > 32) problems.push("Supported scope is 1–12 starting slots and at most 32 rostered players.");
  if (new Set(slots.map((s) => s.id)).size !== slots.length || slots.some((s) => !s.id || s.eligiblePositions.length === 0)) problems.push("Starting slots must be unique and have eligibility.");
  if (new Set(players.map((p) => p.id)).size !== players.length) problems.push("A player appears more than once on the roster.");
  const checkTime = (value: number, age: number, label: string) => {
    if (!Number.isFinite(value) || value > options.now || options.now - value > age) problems.push(`${label} is missing, stale, or in the future. Refresh before setting a lineup.`);
  };
  checkTime(snapshot.rosterRetrievedAt, options.maxRosterAgeMs, "Roster snapshot");
  checkTime(snapshot.retrievedAt, options.maxProjectionAgeMs, "Projection retrieval");
  if (snapshot.projectionUpdatedAt === null) warnings.push("Projection publication time is unknown. Retrieval time does not establish freshness.");
  else checkTime(snapshot.projectionUpdatedAt, options.maxProjectionAgeMs, "Projection publication");
  const usesModel = players.some((p) => (p.projectionOrigin === "model" || p.projectionOrigin === "model-conditional" || p.projectionOrigin === "experimental") && p.projectedPoints !== null);
  if (usesModel) {
    if (!snapshot.model) problems.push("Model estimates have no provenance.");
    else {
      checkTime(snapshot.model.computedAt, options.maxProjectionAgeMs, "Model calculation");
      warnings.push(...snapshot.model.warnings);
      if (snapshot.model.providerUpdatedAt === null) warnings.push("The model's source publication time is unknown; a manual date cannot establish model freshness.");
      else checkTime(snapshot.model.providerUpdatedAt, options.maxProjectionAgeMs, "Model source publication");
      if (snapshot.model.excludedRules.length > 0) {
        warnings.push(`Model estimates omit these league scoring terms: ${snapshot.model.excludedRules.join(", ")}. Totals are incomplete expected points.`);
        if (!options.compareAvailableEstimates) problems.push("Choose the incomplete-estimates comparison explicitly, or replace all model estimates with full-scoring weekly values.");
      }
    }
  }

  const slotById = new Map(slots.map((s) => [s.id, s]));
  const occupant = new Map<string, WeeklyPlayer>();
  for (const player of players) {
    if (player.projectionOrigin !== undefined && !["model", "model-conditional", "experimental", "manual"].includes(player.projectionOrigin)) problems.push(`${player.name}: unknown projection origin.`);
    if (player.experimentalEstimate !== undefined && player.projectedPoints !== null && player.projectionOrigin !== "experimental" && player.projectionOrigin !== "manual") problems.push(`${player.name}: experimental evidence cannot be relabeled as ordinary model points.`);
    if (player.projectionOrigin === "experimental" && player.projectedPoints !== null) {
      if (!options.allowExperimentalEstimates || !options.compareAvailableEstimates) problems.push(`${player.name}: experimental baselines require both experimental-estimate and incomplete-comparison consent.`);
      if (!validWeeklyExperimentalEstimate(player.experimentalEstimate, snapshot.season, snapshot.week, player.positions)
        || player.experimentalEstimate.points !== player.projectedPoints || player.conditionalEstimate !== undefined
        || !["active", "questionable", "doubtful"].includes(player.availability)) problems.push(`${player.name}: experimental baseline evidence is invalid.`);
      warnings.push(`${player.name}: experimental ${player.experimentalEstimate?.method ?? "unknown"} assumes active at kickoff; this is not a validated or availability-adjusted full-scoring forecast. Omitted rules: ${player.experimentalEstimate?.excludedRules.join(", ") || "none in this scoring subset"}.`);
    }
    if (player.projectionOrigin === "model-conditional" && player.projectedPoints !== null) {
      if (!options.allowConditionalEstimates || !options.compareAvailableEstimates) problems.push(`${player.name}: active-at-kickoff forecasts require both provisional forecast and incomplete-comparison consent.`);
      if (player.conditionalEstimate?.condition !== "active-at-kickoff" || player.conditionalEstimate.missingEvidence !== "team-injury-report" || player.conditionalEstimate.points !== player.projectedPoints || player.injuryCoverage !== "unavailable") problems.push(`${player.name}: provisional forecast evidence is invalid.`);
      warnings.push(`${player.name}: forecast assumes active at kickoff; it is not availability-adjusted expected points. The team injury report is missing.`);
    }
    if (player.injuryCoverage === "unavailable") {
      warnings.push(`${player.name}: current team/week injury-report coverage is unavailable. A manual estimate is not injury clearance; verify the final active list.`);
      if (!options.compareAvailableEstimates) problems.push(`${player.name}: explicitly choose the incomplete-estimates comparison to proceed without verified injury-report coverage.`);
    }
    if (player.gameContextConflict) problems.push(`${player.name}: team or kickoff changed between sources. Refresh before moving this player.`);
    if (player.projectionOrigin === "manual" && player.projectedPoints !== null) checkTime(player.projectionEnteredAt ?? NaN, options.maxProjectionAgeMs, `${player.name}'s manual estimate`);
    if (!player.id || player.positions.length === 0 || !STATUSES.has(player.availability)) problems.push(`${player.name}: player identity, position, or status is invalid.`);
    if (player.projectedPoints !== null && (!Number.isFinite(player.projectedPoints) || Math.abs(player.projectedPoints) > 10000)) problems.push(`${player.name}: invalid projected points.`);
    if (player.availability === "unknown") problems.push(`${player.name}: availability is unknown.`);
    if (player.kickoffAt !== null && !Number.isFinite(player.kickoffAt)) problems.push(`${player.name}: invalid kickoff.`);
    if (player.kickoffAt === null && (!UNAVAILABLE.has(player.availability) || (player.currentSlotId !== null && player.availability !== "bye"))) problems.push(`${player.name}: kickoff is unknown.`);
    if (player.currentSlotId !== null) {
      const slot = slotById.get(player.currentSlotId);
      if (!slot || !eligible(slot, player) || occupant.has(player.currentSlotId)) problems.push(`${player.name}: current starter assignment is invalid.`);
      occupant.set(player.currentSlotId, player);
    }
    if (player.availability === "questionable" || player.availability === "doubtful") warnings.push(`${player.name} is ${player.availability}; check the final active list before kickoff.`);
  }
  if (problems.length > 0) return result;

  const heldPositions = new Set(options.holdUnpricedPositions ?? []);
  // Holding a position is safe only when every eligible slot accepts that position
  // exclusively. A fixed unpriced FLEX player could hide a beneficial tradeoff.
  const unpricedPositions = new Set(players.filter((p) => p.projectedPoints === null && !UNAVAILABLE.has(p.availability)).flatMap((p) => p.positions));
  const excludedSlots = slots.filter((s) => s.eligiblePositions.every((p) => heldPositions.has(p)) && s.eligiblePositions.some((p) => unpricedPositions.has(p)));
  const excluded = new Set(excludedSlots.map((s) => s.id));
  const heldUnpricedIds = new Set<string>();
  if (options.compareAvailableEstimates) {
    for (const player of players) {
      if (player.projectedPoints !== null || UNAVAILABLE.has(player.availability)) continue;
      heldUnpricedIds.add(player.id);
      if (player.currentSlotId !== null) excluded.add(player.currentSlotId);
    }
    if (heldUnpricedIds.size > 0) warnings.push(`No estimate: ${players.filter((p) => heldUnpricedIds.has(p.id)).map((p) => p.name).join(", ")}. These players stay in their current places and are excluded from the comparison; their unknown values could change the best full-roster lineup.`);
  }
  result.excludedSlotIds = [...excluded];
  result.excludedPlayerIds = [...heldUnpricedIds];
  if (excluded.size > 0) warnings.push("Unpriced positions are held in their current slots and excluded from all point totals and gains.");
  const fixed = new Map<string, WeeklyAssignment>();
  const candidates: WeeklyPlayer[] = [];
  for (const player of players) {
    const started = player.kickoffAt !== null && player.kickoffAt <= options.now;
    const held = player.currentSlotId !== null && excluded.has(player.currentSlotId);
    if (held || (started && player.currentSlotId !== null)) {
      if (!held && player.projectedPoints === null && !UNAVAILABLE.has(player.availability)) problems.push(`${player.name}: locked starter has no projection; a full total cannot be computed.`);
      fixed.set(player.currentSlotId!, { slotId: player.currentSlotId!, playerId: player.id, points: held ? null : UNAVAILABLE.has(player.availability) ? 0 : player.projectedPoints, fixed: true });
      continue;
    }
  }
  for (const slot of excludedSlots) if (!fixed.has(slot.id)) fixed.set(slot.id, { slotId: slot.id, playerId: null, points: null, fixed: true });
  const fixedIds = new Set([...fixed.values()].map((a) => a.playerId));
  // Only after every fixed slot is known can we decide whether a missing bench
  // projection affects an open slot. Input order cannot change that decision.
  for (const player of players) {
    const started = player.kickoffAt !== null && player.kickoffAt <= options.now;
    if (fixedIds.has(player.id) || started || UNAVAILABLE.has(player.availability) || heldUnpricedIds.has(player.id)) continue;
    const relevantSlots = slots.filter((s) => !fixed.has(s.id) && eligible(s, player));
    if (relevantSlots.length === 0) continue;
    if (player.projectedPoints === null) problems.push(`${player.name}: missing exact weekly projection.`);
    else candidates.push(player);
  }
  if (options.compareAvailableEstimates && candidates.length === 0 && ![...fixed.values()].some((a) => a.points !== null)) problems.push("No valued players remain in this comparison.");
  if (problems.length > 0) return result;

  const open = slots.filter((s) => !fixed.has(s.id));
  const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const kickoffs = [...new Set(ordered.map((p) => p.kickoffAt!))].sort((a, b) => a - b);
  type State = { score: number; flex: number; players: (string | null)[] };
  const states = new Map<number, State>([[0, { score: 0, flex: 0, players: open.map(() => null) }]]);
  for (const player of ordered) {
    for (const [mask, state] of [...states]) {
      for (let i = 0; i < open.length; i += 1) {
        if ((mask & (1 << i)) !== 0 || !eligible(open[i], player)) continue;
        const nextMask = mask | (1 << i);
        const score = state.score + cents(player.projectedPoints!);
        const flex = state.flex + kickoffs.indexOf(player.kickoffAt!) * (new Set(open[i].eligiblePositions).size - 1);
        const prior = states.get(nextMask);
        if (prior && (prior.score > score || (prior.score === score && prior.flex >= flex))) continue;
        const assigned = [...state.players]; assigned[i] = player.id;
        states.set(nextMask, { score, flex, players: assigned });
      }
    }
  }
  const best = [...states.values()].sort((a, b) => b.score - a.score || b.players.filter(Boolean).length - a.players.filter(Boolean).length || b.flex - a.flex)[0];
  const playerById = new Map(players.map((p) => [p.id, p]));
  for (let i = 0; i < open.length; i += 1) {
    const id = best.players[i];
    fixed.set(open[i].id, { slotId: open[i].id, playerId: id, points: id === null ? 0 : cents(playerById.get(id)!.projectedPoints!) / 100, fixed: false });
  }
  result.assignments = slots.map((s) => fixed.get(s.id)!);
  result.projectedPoints = result.assignments.reduce((n, a) => n + cents(a.points ?? 0), 0) / 100;
  const current = players.filter((p) => p.currentSlotId !== null && !excluded.has(p.currentSlotId));
  result.currentProjectedPoints = current.some((p) => p.projectedPoints === null && !UNAVAILABLE.has(p.availability)) ? null : current.reduce((n, p) => n + (UNAVAILABLE.has(p.availability) ? 0 : cents(p.projectedPoints!)), 0) / 100;
  result.gain = result.currentProjectedPoints === null ? null : (cents(result.projectedPoints) - cents(result.currentProjectedPoints)) / 100;
  const assignedIds = new Set(result.assignments.map((a) => a.playerId));
  result.benchIds = players.filter((p) => !assignedIds.has(p.id)).map((p) => p.id);
  if (result.assignments.some((a) => a.playerId === null && !excluded.has(a.slotId))) warnings.push("At least one starting slot is empty in the maximum-points arrangement.");
  if (options.compareAvailableEstimates) warnings.push("This comparison is optimal only for the included estimates and fixed assignments, not the full roster under complete league scoring.");
  result.status = warnings.length > 0 ? "conditional" : "ready";
  return result;
}
