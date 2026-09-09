import { str, type CsvRow } from "./csv";
import { normalizeTeam } from "./teams";
import { toRosterStatus } from "./weekly-roster";
import type { WeeklyPlayer } from "./weekly-lineup";

export interface WaiverRosterEvidence {
  season: number;
  week: number;
  reportRows: number;
  reportedTeams: string[];
  bySleeperId: Map<string, readonly CsvRow[]>;
}

/** Membership evidence only. ACT is not an injury report or final active-list clearance. */
export function parseWaiverRosterEvidence(rows: readonly CsvRow[], season: number, week: number): WaiverRosterEvidence {
  if (!Number.isInteger(season) || season < 2000 || !Number.isInteger(week) || week < 1 || week > 18 || rows.length > 100000) throw new Error("Unsupported weekly roster evidence scope.");
  const requested = rows.filter((row) => str(row, "season") === String(season) && str(row, "week") === String(week) && str(row, "game_type") === "REG");
  const teams = new Set<string>();
  const bySleeperId = new Map<string, CsvRow[]>();
  for (const row of requested) {
    const team = normalizeTeam(str(row, "team"));
    if (team !== null && toRosterStatus(str(row, "status")) === "active") teams.add(team);
    const id = str(row, "sleeper_id");
    if (/^[1-9]\d{0,29}$/.test(id)) bySleeperId.set(id, [...(bySleeperId.get(id) ?? []), row]);
  }
  if (requested.length === 0 || teams.size === 0 || bySleeperId.size === 0) throw new Error(`Current NFL roster evidence is unavailable for ${season}, week ${week}. No directory-only pool is substituted.`);
  return { season, week, reportRows: requested.length, reportedTeams: [...teams].sort(), bySleeperId };
}

export type WaiverEvidenceResult = { ok: true; team: string } | { ok: false; reason: "missing" | "inactive" | "conflicting" };

export function waiverRosterMembership(player: WeeklyPlayer, evidence: WaiverRosterEvidence): WaiverEvidenceResult {
  if (player.positions.includes("DST")) {
    const team = normalizeTeam(player.id);
    return team !== null && evidence.reportedTeams.includes(team) ? { ok: true, team } : { ok: false, reason: "missing" };
  }
  const rows = evidence.bySleeperId.get(player.id);
  if (rows === undefined) return { ok: false, reason: "missing" };
  // An active transaction destination can coexist with a traded/cut origin. Two active
  // teams or identities are ambiguous; file order must not select one as current.
  const active = rows.filter((row) => toRosterStatus(str(row, "status")) === "active");
  if (active.length === 0) return { ok: false, reason: rows.some((row) => toRosterStatus(str(row, "status")) === "unknown") ? "missing" : "inactive" };
  const identities = new Set(rows.map((row) => str(row, "gsis_id")).filter(Boolean));
  const teams = new Set(active.map((row) => normalizeTeam(str(row, "team"))));
  const positions = new Set(active.map((row) => str(row, "position") === "FB" ? "RB" : str(row, "position")));
  const team = [...teams][0];
  if (identities.size > 1 || teams.size !== 1 || team === null || positions.size !== 1 || !player.positions.some((position) => positions.has(position))) return { ok: false, reason: "conflicting" };
  return { ok: true, team };
}

/** A season-catalog bridge must not replace the direct weekly Sleeper identity. */
export function assertWaiverProjectionIdentity(player: WeeklyPlayer, projection: { gsisId: string | null; team?: string | null }, evidence: WaiverRosterEvidence, requireVerified = true): void {
  const rows = evidence.bySleeperId.get(player.id) ?? [];
  const identities = new Set(rows.map((row) => str(row, "gsis_id")).filter(Boolean));
  const active = rows.filter((row) => toRosterStatus(str(row, "status")) === "active");
  const teams: Set<string | null> = player.positions.includes("DST") ? new Set([normalizeTeam(player.id)]) : new Set((active.length > 0 ? active : rows).map((row) => normalizeTeam(str(row, "team"))));
  const identityConflict = requireVerified
    ? identities.size !== 1 || projection.gsisId === null || !identities.has(projection.gsisId)
    : identities.size > 0 && projection.gsisId !== null && (identities.size !== 1 || !identities.has(projection.gsisId));
  if ((!player.positions.includes("DST") && identityConflict)
    || (projection.team !== undefined && projection.team !== null && (teams.size !== 1 || !teams.has(projection.team)))
    || (player.team !== undefined && player.team !== null && (teams.size !== 1 || !teams.has(player.team)))) {
    throw new Error(`Current-week NFL identity evidence disagrees with the projection bridge for player ${player.id}. No comparison is returned; refresh or remove the conflicting candidate.`);
  }
}
