import { CHAMPIONSHIP_WEEKS, PLAYOFF_FIELDS } from "../league-rules";

export interface SleeperSeasonRules {
  playoffTeams: number;
  championshipWeek: number;
  extraMedianMatchup: boolean;
}

/** League settings, never inferred from draft-room metadata or a local default. */
export function parseSleeperSeasonRules(raw: unknown):
  | { ok: true; rules: SleeperSeasonRules }
  | { ok: false; unsupported: string[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, unsupported: ["league settings missing"] };
  }
  const row = raw as Record<string, unknown>;
  const unsupported: string[] = [];
  const playoffTeams = row.playoff_teams;
  if (typeof playoffTeams !== "number" || !(PLAYOFF_FIELDS as readonly number[]).includes(playoffTeams)) unsupported.push("league.playoff_teams: only four or six supported");
  const start = row.playoff_week_start;
  const championshipWeek = typeof start === "number" && typeof playoffTeams === "number" ? start + (playoffTeams === 6 ? 2 : 1) : NaN;
  if (!(CHAMPIONSHIP_WEEKS as readonly number[]).includes(championshipWeek)) unsupported.push("league.playoff_week_start: unsupported championship week");
  for (const key of ["best_ball", "playoff_type", "playoff_round_type", "playoff_seed_type", "max_subs"]) {
    if (row[key] !== 0) unsupported.push(`league.${key}: ${String(row[key])} is not modeled`);
  }
  if (row.start_week !== 1) unsupported.push("league.start_week: only week one supported");
  if (row.league_average_match !== 0 && row.league_average_match !== 1) unsupported.push("league.league_average_match: missing or invalid");
  return unsupported.length > 0 ? { ok: false, unsupported } : {
    ok: true,
    rules: { playoffTeams: playoffTeams as number, championshipWeek, extraMedianMatchup: row.league_average_match === 1 },
  };
}
