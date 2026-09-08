import { describe, expect, it } from "vitest";

import { parseSleeperSeasonStats, sleeperWeekStatsUrl } from "./sleeper-stats";

describe("Sleeper historical stats adapter", () => {
  it("keeps only regular completed player-weeks and rejects duplicate identities", () => {
    const parsed = parseSleeperSeasonStats([
      {
        category: "stat", season_type: "regular", season: "2024", week: 1,
        player_id: "10", team: "CHI", player: { position: "DEF" }, stats: { gp: 1 },
      },
      {
        category: "projection", season_type: "regular", season: 2024, week: 1,
        player_id: "ignored", player: { position: "QB" }, stats: { gp: 1 },
      },
      {
        category: "stat", season_type: "post", season: 2024, week: 19,
        player_id: "ignored", player: { position: "QB" }, stats: { gp: 1 },
      },
      {
        category: "stat", season_type: "regular", season: 2024, week: 2,
        player_id: "inactive", player: { position: "QB" }, stats: { gp: 0 },
      },
    ], 2024);
    expect(parsed).toMatchObject({
      ok: true,
      data: [{ playerId: "10", position: "DEF", team: "CHI", name: null, season: 2024, week: 1, stats: { gp: 1 } }],
    });

    const duplicate = parseSleeperSeasonStats([
      {
        category: "stat", season_type: "regular", season: 2024, week: 1,
        player_id: "10", player: { position: "QB" }, stats: { gp: 1 },
      },
      {
        category: "stat", season_type: "regular", season: 2024, week: 1,
        player_id: "10", player: { position: "QB" }, stats: { gp: 1 },
      },
    ], 2024);
    expect(duplicate).toMatchObject({ ok: false });
    expect(parseSleeperSeasonStats([
      {
        category: "stat", season_type: "regular", season: 2024, week: 2,
        player_id: "10", player: { position: "QB" }, stats: { gp: 1 },
      },
    ], 2024, 1)).toMatchObject({ ok: false });
    expect(sleeperWeekStatsUrl(2024, 1)).toBe(
      "https://api.sleeper.com/stats/nfl/2024/1?season_type=regular",
    );
  });
});
