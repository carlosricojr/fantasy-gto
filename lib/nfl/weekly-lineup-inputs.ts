import type { WeeklyLineupSnapshot } from "./weekly-lineup";

/** Re-imports refresh automatic values without replacing a manager's explicit edits. */
export function mergeWeeklyRefresh(prior: WeeklyLineupSnapshot | null, incoming: WeeklyLineupSnapshot): { sameContext: boolean; snapshot: WeeklyLineupSnapshot } {
  const sameContext = prior !== null && prior.leagueId === incoming.leagueId && prior.ownerId === incoming.ownerId && prior.season === incoming.season && prior.week === incoming.week && prior.scoringId === incoming.scoringId;
  if (!sameContext) return { sameContext, snapshot: incoming };
  const overrides = new Map(prior.players.filter((p) => p.projectionOrigin === "manual").map((p) => [p.id, p]));
  return { sameContext, snapshot: { ...incoming, players: incoming.players.map((p) => {
    const override = overrides.get(p.id);
    return override === undefined ? p : { ...p, projectedPoints: override.projectedPoints, projectionOrigin: "manual", projectionMissingReason: null, projectionEnteredAt: override.projectionEnteredAt };
  }) } };
}
