import { fantasySeasonWeeks } from "@/lib/core/season-sim";
import { DEFAULT_CHAMPIONSHIP_WEEK } from "@/lib/nfl/league-rules";
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { seasonSummary } from "../draft/season-label";

/** The complete rules every new manual league writes beside its denormalized roster shape. */
export interface DashboardLeagueRules {
  teams: number;
  scoringId: string;
  playoffTeams: number;
  championshipWeek: number;
}

export const DEFAULT_DASHBOARD_LEAGUE_RULES: DashboardLeagueRules = {
  teams: 12,
  scoringId: SCORING_PRESETS[0].id,
  playoffTeams: 6,
  championshipWeek: DEFAULT_CHAMPIONSHIP_WEEK,
};

/** The rules payload sent to `leagues.create`; explicit so a new field cannot be dropped. */
export function persistedLeagueRules({
  teams,
  scoringId,
  playoffTeams,
  championshipWeek,
}: DashboardLeagueRules): DashboardLeagueRules {
  return { teams, scoringId, playoffTeams, championshipWeek };
}

/** The displayed season is derived from the exact pair persisted with the league. */
export function dashboardSeasonSummary({
  playoffTeams,
  championshipWeek,
}: DashboardLeagueRules): string {
  return seasonSummary(fantasySeasonWeeks(championshipWeek, playoffTeams));
}
