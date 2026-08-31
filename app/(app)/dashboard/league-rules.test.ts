import { describe, expect, it } from "vitest";

import {
  dashboardSeasonSummary,
  DEFAULT_DASHBOARD_LEAGUE_RULES,
  persistedLeagueRules,
} from "./league-rules";

describe("dashboard league rules", () => {
  it("persists every league and season rule selected in the creation form", () => {
    expect(
      persistedLeagueRules({
        teams: 10,
        scoringId: "standard",
        playoffTeams: 4,
        championshipWeek: 15,
      }),
    ).toEqual({
      teams: 10,
      scoringId: "standard",
      playoffTeams: 4,
      championshipWeek: 15,
    });
  });

  it("derives the displayed season from the selected playoff field and final week", () => {
    expect(
      dashboardSeasonSummary({
        ...DEFAULT_DASHBOARD_LEAGUE_RULES,
        playoffTeams: 6,
        championshipWeek: 16,
      }),
    ).toBe("Weeks 1–13 · playoffs 14–16");
  });
});
