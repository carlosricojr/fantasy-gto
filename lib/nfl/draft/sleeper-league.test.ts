import { describe, expect, it } from "vitest";
import { parseSleeperSeasonRules } from "./sleeper-league";

const actual = {
  playoff_teams: 6, playoff_week_start: 15, start_week: 1,
  league_average_match: 1, best_ball: 0, playoff_type: 0,
  playoff_round_type: 0, playoff_seed_type: 0, max_subs: 0,
};
describe("Sleeper authoritative season rules", () => {
  it("imports the actual six-team, week-17 final and median-game league", () => {
    expect(parseSleeperSeasonRules(actual)).toEqual({ ok: true, rules: {
      playoffTeams: 6, championshipWeek: 17, extraMedianMatchup: true,
    } });
  });
  it("derives four-team brackets without extending their season", () => {
    expect(parseSleeperSeasonRules({ ...actual, playoff_teams: 4, league_average_match: 0 })).toEqual({ ok: true, rules: {
      playoffTeams: 4, championshipWeek: 16, extraMedianMatchup: false,
    } });
  });
  it.each([
    { playoff_teams: 8 }, { playoff_week_start: 16 }, { start_week: 2 },
    { league_average_match: "1" }, { league_average_match: undefined },
    { best_ball: 1 }, { playoff_round_type: 1 }, { playoff_seed_type: 1 },
    { max_subs: 1 },
  ])("refuses unsupported or unknown rules %j", (patch) => {
    expect(parseSleeperSeasonRules({ ...actual, ...patch }).ok).toBe(false);
  });
});
