import type { WeeklyLineupSnapshot } from "./weekly-lineup";

export const MANUAL_ESTIMATE_MAX_AGE = 24 * 60 * 60 * 1000;
export const WEEKLY_MANUAL_STORAGE_KEY = "fantasygto.weekly-manual.v1";
interface ManualRow { id: string; points: number | null; enteredAt: number; team: string | null; gameId: string | null; kickoffAt: number | null }
export interface SavedWeeklyManual { version: 1; context: string; source: string; publication: string; rows: ManualRow[] }

export function weeklyManualContext(snapshot: WeeklyLineupSnapshot): string {
  return JSON.stringify([snapshot.leagueId, snapshot.ownerId, snapshot.season, snapshot.week, snapshot.scoringId]);
}

/** Only user entries are stored. No roster, injury clearance, projection or consent is restored. */
export function saveWeeklyManual(snapshot: WeeklyLineupSnapshot, source: string, publication: string, now: number): SavedWeeklyManual {
  return { version: 1, context: weeklyManualContext(snapshot), source: source.slice(0, 200), publication,
    rows: snapshot.players.filter((p) => p.projectionOrigin === "manual" && p.projectionEnteredAt !== undefined && Number.isFinite(p.projectionEnteredAt) && p.projectionEnteredAt <= now && now - p.projectionEnteredAt <= MANUAL_ESTIMATE_MAX_AGE && (p.projectedPoints === null || Number.isFinite(p.projectedPoints))).slice(0, 32).map((p) => ({ id: p.id, points: p.projectedPoints, enteredAt: p.projectionEnteredAt!, team: p.team ?? null, gameId: p.gameId ?? null, kickoffAt: p.kickoffAt })) };
}

export function parseWeeklyManual(raw: string | null): SavedWeeklyManual[] {
  if (raw === null || raw.length > 150_000) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > 8) return [];
    return parsed.filter((x): x is SavedWeeklyManual => x !== null && typeof x === "object" && x.version === 1 && typeof x.context === "string" && x.context.length <= 15_000 && typeof x.source === "string" && x.source.length <= 200 && typeof x.publication === "string" && x.publication.length <= 40 && Array.isArray(x.rows) && x.rows.length <= 32 && new Set(x.rows.map((r: ManualRow) => r?.id)).size === x.rows.length && x.rows.every((r: ManualRow) => r && typeof r.id === "string" && r.id.length <= 40 && (r.points === null || Number.isFinite(r.points)) && Number.isFinite(r.enteredAt) && (r.team === null || typeof r.team === "string") && (r.gameId === null || typeof r.gameId === "string") && (r.kickoffAt === null || Number.isFinite(r.kickoffAt))));
  } catch { return []; }
}

export function updateWeeklyManualStore(existing: readonly SavedWeeklyManual[], entry: SavedWeeklyManual): SavedWeeklyManual[] {
  return [entry, ...existing.filter((p) => p.context !== entry.context)].slice(0, 8);
}

/** Requires a freshly imported matching context; changed or expired entries are discarded. */
export function restoreWeeklyManual(snapshot: WeeklyLineupSnapshot, saved: readonly SavedWeeklyManual[], now: number): { snapshot: WeeklyLineupSnapshot; source?: string; publication?: string; restored: number; discarded: number } {
  const entry = saved.find((s) => s.context === weeklyManualContext(snapshot));
  if (!entry) return { snapshot, restored: 0, discarded: 0 };
  let restored = 0;
  let discarded = 0;
  const rows = new Map(entry.rows.map((r) => [r.id, r]));
  const players = snapshot.players.map((p) => {
    const row = rows.get(p.id);
    if (!row) return p;
    if (row.enteredAt > now || now - row.enteredAt > MANUAL_ESTIMATE_MAX_AGE || row.team !== (p.team ?? null) || row.gameId !== (p.gameId ?? null) || row.kickoffAt !== p.kickoffAt) { discarded++; return p; }
    restored++;
    return { ...p, projectedPoints: row.points, projectionEnteredAt: row.enteredAt, projectionOrigin: "manual" as const, projectionMissingReason: null };
  });
  discarded += entry.rows.filter((r) => !snapshot.players.some((p) => p.id === r.id)).length;
  return { snapshot: { ...snapshot, players }, source: entry.source, publication: entry.publication, restored, discarded };
}
