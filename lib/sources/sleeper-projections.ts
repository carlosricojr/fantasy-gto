import { type ProviderResult, failed, ok } from "../core/providers";
import type { SleeperProjectionPlayer, SleeperProjectionSnapshot } from "../nfl/sleeper-projections";
import type { Position } from "../nfl/scoring/types";
import { normalizeTeam } from "../nfl/teams";

/** Observed, undocumented endpoints. No public/commercial ingest is enabled here. */
export function sleeperProjectionsUrl(season: number, week?: number): string {
  if (!Number.isInteger(season) || season < 2009 || season > 2100 ||
    (week !== undefined && (!Number.isInteger(week) || week < 1 || week > 18))) {
    throw new Error("Invalid Sleeper projection season/week.");
  }
  return `https://api.sleeper.com/projections/nfl/${season}${week === undefined ? "" : `/${week}`}?season_type=regular`;
}

export type SleeperAdpFormat = "standard" | "half_ppr" | "ppr" | "two_qb" | "dynasty_half_ppr" | "dynasty_ppr" | "dynasty_standard" | "dynasty_two_qb";
const ADP_FIELDS: Record<SleeperAdpFormat, string> = {
  standard: "adp_std", half_ppr: "adp_half_ppr", ppr: "adp_ppr", two_qb: "adp_2qb",
  dynasty_half_ppr: "adp_dynasty_half_ppr", dynasty_ppr: "adp_dynasty_ppr",
  dynasty_standard: "adp_dynasty_std", dynasty_two_qb: "adp_dynasty_2qb",
};

export interface SleeperAdpSnapshot {
  source: "sleeper";
  company: "rotowire";
  season: number;
  format: SleeperAdpFormat;
  sourceField: string;
  sourceUrl: string;
  retrievedAt: number;
  /** Endpoint publishes no league-size parameter, dispersion, or sample count. */
  sourceTeams: null;
  players: { playerId: string; position: Position; adp: number | null; stdev: null; timesDrafted: null; providerUpdatedAt: number | null }[];
}

export function parseSleeperProjections(raw: unknown, season: number, week: number, retrievedAt: number): ProviderResult<SleeperProjectionSnapshot> {
  let sourceUrl: string;
  try { sourceUrl = sleeperProjectionsUrl(season, week); }
  catch (cause) { return failed("Invalid Sleeper projection season/week.", cause); }
  const parsed = projectionRows(raw, season, week, retrievedAt);
  if (!parsed.ok) return parsed;
  const players: SleeperProjectionPlayer[] = [];
  for (const row of parsed.data) {
    const stats = record(row.stats)!;
    // Thousands of rows are ADP-only placeholders. A projection requires an explicit
    // expected appearance and at least one provider point total, including a real zero.
    if (finite(stats.gp) === null || (stats.gp as number) <= 0 ||
      [stats.pts_std, stats.pts_half_ppr, stats.pts_ppr].every(value => finite(value) === null)) continue;
    players.push({
      playerId: string(row.player_id)!, position: position(row)!,
      team: normalizeTeam(string(row.team)), opponent: normalizeTeam(string(row.opponent)),
      gameId: string(row.game_id), providerUpdatedAt: updatedAt(row), stats,
      reportedPoints: { standard: finite(stats.pts_std), half_ppr: finite(stats.pts_half_ppr), ppr: finite(stats.pts_ppr) },
    });
  }
  if (!players.length) return failed("Sleeper returned no projected player-weeks.");
  const dates = players.map(player => player.providerUpdatedAt);
  return ok({ season, week, source: "sleeper", company: "rotowire", sourceUrl, retrievedAt,
    providerUpdatedAt: dates.some(date => date === null) ? null : Math.min(...dates as number[]),
    players, excludedRows: (raw as unknown[]).length - players.length });
}

export function parseSleeperAdp(raw: unknown, season: number, format: SleeperAdpFormat, retrievedAt: number): ProviderResult<SleeperAdpSnapshot> {
  if (!Object.hasOwn(ADP_FIELDS, format)) return failed("Unsupported Sleeper ADP format.");
  let sourceUrl: string;
  try { sourceUrl = sleeperProjectionsUrl(season); }
  catch (cause) { return failed("Invalid Sleeper ADP season.", cause); }
  const parsed = projectionRows(raw, season, null, retrievedAt);
  if (!parsed.ok) return parsed;
  const sourceField = ADP_FIELDS[format];
  const players = parsed.data.map(row => {
    const published = finite(record(row.stats)![sourceField]);
    return { playerId: string(row.player_id)!, position: position(row)!,
      // Observed 999 is an unpriced sentinel, not pick 999. Never substitute search_rank.
      adp: published !== null && published > 0 && published < 999 ? published : null,
      stdev: null, timesDrafted: null, providerUpdatedAt: updatedAt(row) };
  });
  if (!players.some(player => player.adp !== null)) return failed(`Sleeper returned no ${format} ADP values.`);
  return ok({ source: "sleeper", company: "rotowire", season, format, sourceField, sourceUrl,
    retrievedAt, sourceTeams: null, players });
}

function projectionRows(raw: unknown, season: number, week: number | null, retrievedAt: number): ProviderResult<Record<string, unknown>[]> {
  if (!Number.isFinite(retrievedAt) || retrievedAt <= 0) return failed("Projection retrieval time is invalid.");
  if (!Array.isArray(raw) || !raw.length) return failed("Sleeper projection response is empty or not an array.");
  const rows: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  for (const value of raw) {
    const row = record(value);
    if (!row || row.category !== "proj" || row.season_type !== "regular" || row.sport !== "nfl" ||
      Number(row.season) !== season || row.week !== week || row.company !== "rotowire") {
      return failed("Sleeper projection response has an unexpected season, week, sport, category, or company.");
    }
    const playerId = string(row.player_id);
    if (!playerId || !record(row.stats) || !record(row.player)) return failed("Sleeper projection row is missing identity or statistics.");
    if (ids.has(playerId)) return failed(`Sleeper projection response has duplicate player ${playerId}.`);
    ids.add(playerId);
    if (position(row) !== null) rows.push(row);
  }
  return ok(rows);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function updatedAt(row: Record<string, unknown>): number | null {
  // Keep the older revision time when both exist; transport Date is never a revision.
  const dates = [row.updated_at, row.last_modified].map(finite).filter((date): date is number => date !== null && date > 0);
  return dates.length ? Math.min(...dates) : null;
}
function position(row: Record<string, unknown>): Position | null {
  const raw = record(row.player)?.position;
  if (raw === "DEF") return "DST";
  if (raw === "FB") return "RB";
  return ["QB", "RB", "WR", "TE", "K"].includes(raw as string) ? raw as Position : null;
}
