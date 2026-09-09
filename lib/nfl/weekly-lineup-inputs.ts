import type { WeeklyAvailability, WeeklyConditionalEstimate, WeeklyLineupSnapshot, WeeklyModelEvidence } from "./weekly-lineup";
import type { WeeklyRosterEntry } from "./weekly-roster";
import { normalizeTeam } from "./teams";
import { validWeeklyExperimentalEstimate, type WeeklyExperimentalEstimate } from "./weekly-experimental";

/** Team identity for kickoff locks comes from this week's roster, not a cached directory. */
export function resolveWeeklyRosterTeam(playerId: string, positions: readonly string[], season: number, week: number, identities: readonly { sleeperId: string | null; gsisId: string | null }[], weeklyRoster: readonly WeeklyRosterEntry[]): string | null {
  if (positions.includes("DST")) return normalizeTeam(playerId);
  const ids = new Set(identities.filter((p) => p.sleeperId === playerId && p.gsisId !== null).map((p) => p.gsisId));
  if (ids.size !== 1) return null;
  const rows = weeklyRoster.filter((p) => p.playerId === [...ids][0] && p.season === season && p.week === week);
  const active = rows.filter((p) => p.status === "active");
  const candidates = active.length > 0 ? active : rows;
  if (candidates.length === 0 || new Set(candidates.map((p) => JSON.stringify([p.team, p.position, p.status]))).size !== 1) return null;
  return candidates[0].team;
}

export interface WeeklyModelResponse extends WeeklyModelEvidence {
  season: number;
  week: number;
  scoringId: string;
  players: readonly { playerId: string; points: number | null; reason: string | null; availability?: WeeklyAvailability; injuryCoverage?: "available" | "unavailable"; conditionalEstimate?: WeeklyConditionalEstimate; experimentalEstimate?: WeeklyExperimentalEstimate; team?: string | null; gameId?: string | null; kickoffAt?: number | null }[];
}

/** Absence of an injury row does not clear a designation another source reported. */
export function reconcileWeeklyAvailability(current: WeeklyAvailability, modeled?: WeeklyAvailability): WeeklyAvailability {
  if (modeled === undefined || current === "bye" || current === "reserve") return current;
  const statuses = [current, modeled];
  for (const status of ["out", "inactive", "unknown", "doubtful", "questionable"] as const) if (statuses.includes(status)) return status;
  return "active";
}

/** Model results retain their own source evidence and may only fill the requested context. */
export function applyWeeklyModel(snapshot: WeeklyLineupSnapshot, model: WeeklyModelResponse): WeeklyLineupSnapshot {
  if (snapshot.season !== model.season || snapshot.week !== model.week || snapshot.scoringId !== model.scoringId) throw new Error("Model response does not match the imported season, week and scoring.");
  const estimates = new Map(model.players.map((p) => [p.playerId, p]));
  if (estimates.size !== snapshot.players.length || estimates.size !== model.players.length || snapshot.players.some((p) => !estimates.has(p.id))) throw new Error("Model response does not match the imported roster.");
  if (model.players.some((p) => p.points !== null && !Number.isFinite(p.points))) throw new Error("Model response contains invalid expected points.");
  if (model.players.some((p) => p.conditionalEstimate !== undefined && (!Number.isFinite(p.conditionalEstimate.points) || p.conditionalEstimate.condition !== "active-at-kickoff" || p.conditionalEstimate.missingEvidence !== "team-injury-report" || p.injuryCoverage !== "unavailable" || p.points !== null))) throw new Error("Model response contains invalid conditional forecast evidence.");
  if (model.players.some((p) => p.experimentalEstimate !== undefined && (p.points !== null || p.conditionalEstimate !== undefined
    || !validWeeklyExperimentalEstimate(p.experimentalEstimate, model.season, model.week, snapshot.players.find(player => player.id === p.playerId)!.positions)))) throw new Error("Model response contains invalid experimental baseline evidence.");
  const evidence: WeeklyModelEvidence = { source: model.source, computedAt: model.computedAt, providerUpdatedAt: model.providerUpdatedAt, excludedRules: [...model.excludedRules], warnings: [...model.warnings], coverage: { requested: model.players.length, projected: model.players.filter((p) => p.points !== null).length } };
  return { ...snapshot, source: model.source, retrievedAt: model.computedAt, model: evidence, players: snapshot.players.map((p) => {
    const estimate = estimates.get(p.id)!;
    const gameContextConflict = (estimate.team !== undefined && p.team !== undefined && estimate.team !== p.team)
      || (estimate.gameId !== undefined && p.gameId !== undefined && estimate.gameId !== p.gameId)
      || (estimate.kickoffAt !== undefined && estimate.kickoffAt !== p.kickoffAt);
    const modelGameContextChecked = estimate.team !== undefined && estimate.gameId !== undefined && estimate.kickoffAt !== undefined;
    return { ...p, projectedPoints: estimate.points, projectionOrigin: "model", conditionalEstimate: estimate.conditionalEstimate, experimentalEstimate: estimate.experimentalEstimate, projectionMissingReason: estimate.reason, availability: reconcileWeeklyAvailability(p.availability, estimate.availability), nflverseAvailability: estimate.availability, injuryCoverage: estimate.injuryCoverage, gameContextConflict, modelGameContextChecked };
  }) };
}

/** A reversible view only: ordinary missing points and manual overrides stay intact. */
export function selectWeeklyConditionalEstimates(snapshot: WeeklyLineupSnapshot, enabled: boolean, now: number): WeeklyLineupSnapshot {
  if (!enabled) return snapshot;
  return { ...snapshot, players: snapshot.players.map((p) => {
    if (p.projectionOrigin === "manual" || p.projectedPoints !== null || p.conditionalEstimate === undefined
      || p.injuryCoverage !== "unavailable" || !["active", "questionable", "doubtful"].includes(p.availability)
      || p.kickoffAt === null || p.kickoffAt <= now || p.gameContextConflict) return p;
    return { ...p, projectedPoints: p.conditionalEstimate.points, projectionOrigin: "model-conditional", projectionMissingReason: null };
  }) };
}

/** Independent opt-in overlay, rebuilt from raw input on each render. Manual overrides win. */
export function selectWeeklyExperimentalEstimates(snapshot: WeeklyLineupSnapshot, enabled: boolean, now: number): WeeklyLineupSnapshot {
  if (!enabled) return snapshot;
  return { ...snapshot, players: snapshot.players.map(p => {
    if (p.projectionOrigin === "manual" || p.projectedPoints !== null || p.conditionalEstimate !== undefined
      || !validWeeklyExperimentalEstimate(p.experimentalEstimate, snapshot.season, snapshot.week, p.positions)
      || !["active", "questionable", "doubtful"].includes(p.availability) || p.gameContextConflict
      || p.kickoffAt === null || !Number.isFinite(p.kickoffAt) || !Number.isFinite(now) || p.kickoffAt <= now) return p;
    return { ...p, projectedPoints: p.experimentalEstimate.points, projectionOrigin: "experimental", projectionMissingReason: null };
  }) };
}

/** Re-imports refresh automatic values without replacing a manager's explicit edits. */
export function mergeWeeklyRefresh(prior: WeeklyLineupSnapshot | null, incoming: WeeklyLineupSnapshot): { sameContext: boolean; snapshot: WeeklyLineupSnapshot } {
  const sameContext = prior !== null && prior.leagueId === incoming.leagueId && prior.ownerId === incoming.ownerId && prior.season === incoming.season && prior.week === incoming.week && prior.scoringId === incoming.scoringId;
  if (!sameContext) return { sameContext, snapshot: incoming };
  const priorPlayers = new Map(prior.players.map((p) => [p.id, p]));
  const overrides = new Map(prior.players.filter((p) => p.projectionOrigin === "manual").map((p) => [p.id, p]));
  return { sameContext, snapshot: { ...incoming, players: incoming.players.map((p) => {
    // A roster-only refresh did not re-read the injury inputs that produced the
    // prior model's designation. It cannot clear that evidence to cached Active.
    const previous = priorPlayers.get(p.id);
    // Preserve a designation reported by either source. Prior nflverse Active
    // must not hide a reconciled Sleeper Out while injury coverage is missing.
    // Bye/reserve are roster-specific exclusions, not retained injury evidence.
    const priorDesignation = previous !== undefined && previous.availability !== "bye" && previous.availability !== "reserve" ? previous.availability : undefined;
    const previousAvailability = priorDesignation === undefined ? previous?.nflverseAvailability : reconcileWeeklyAvailability(priorDesignation, previous?.nflverseAvailability);
    const retainedAvailability = p.injuryCoverage !== "available" && previousAvailability !== undefined
      ? reconcileWeeklyAvailability(previousAvailability, p.nflverseAvailability)
      : p.nflverseAvailability ?? previousAvailability;
    const observed = { ...p, availability: reconcileWeeklyAvailability(p.availability, retainedAvailability), nflverseAvailability: retainedAvailability,
      injuryCoverage: p.injuryCoverage ?? previous?.injuryCoverage,
      gameContextConflict: p.gameContextConflict || (!p.modelGameContextChecked && previous?.gameContextConflict) };
    const override = overrides.get(p.id);
    if (override !== undefined && ((override.team !== undefined && p.team !== undefined && override.team !== p.team)
      || (override.gameId !== undefined && p.gameId !== undefined && override.gameId !== p.gameId)
      || override.kickoffAt !== p.kickoffAt)) {
      return { ...observed, projectedPoints: null, projectionOrigin: "manual", projectionMissingReason: "Matchup or kickoff changed; re-enter the weekly estimate.", projectionEnteredAt: undefined };
    }
    return override === undefined ? observed : { ...observed, projectedPoints: override.projectedPoints, projectionOrigin: "manual", projectionMissingReason: null, projectionEnteredAt: override.projectionEnteredAt };
  }) } };
}
