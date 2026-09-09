import { describe, expect, it } from "vitest";
import fixture from "../../tests/fixtures/sleeper-pick16-continuation.json";
import { completeDraft, recommendByChampionship, trimDraftRoster, type DraftPolicyState } from "./draft-policy";
import { survivalProbability } from "./draft";
import type { PlayerRisk } from "./roster-utility";
import { sampleTeamWeeklyScores, simulateLeague, type LeagueConfig } from "./season-sim";

const distributions: Record<string, number[]> = fixture.distributions;
const hydrate = (player: PlayerRisk): PlayerRisk => ({
  ...player,
  ...(distributions[player.position] === undefined ? {} : { weeklyOutcomeRatios: distributions[player.position] }),
});
const liveState: DraftPolicyState = {
  ...fixture.state,
  available: fixture.state.available.map(hydrate),
  teams: fixture.state.teams.map((team) => ({ ...team, roster: team.roster.map(hydrate) })),
};
const liveConfig: LeagueConfig = {
  ...fixture.config,
  wireCover: new Map(fixture.config.wireCover as [string, number][]),
  unprojectedPositions: new Set(fixture.config.unprojectedPositions),
};
const names = (roster: readonly PlayerRisk[]) => roster.map((player) => player.name);
const livePlayer = (name: string) => liveState.available.find((player) => player.name === name)!;

describe("the September 8 London/Wilson continuation", () => {
  it("retains the exact keeper state and spends pick 16 once", () => {
    expect(fixture.provenance.beforeOverall).toBe(16);
    expect(fixture.provenance.keeperCount).toBe(20);
    expect(liveState.teams.flatMap((team) => team.roster)).toHaveLength(31);
    expect(names(liveState.teams[0].roster)).toEqual(["Omarion Hampton", "Travis Etienne", "Michael Pittman"]);
    expect(liveState.teams[0].remainingPicks.slice(0, 3)).toEqual([16, 25, 36]);
    expect(liveState.teams[0].remainingPicks).not.toContain(76);
    expect(liveState.teams[0].remainingPicks).not.toContain(105);
    for (const choice of ["Drake London", "Garrett Wilson"]) {
      const rosters = completeDraft(liveState, liveConfig, livePlayer(choice));
      expect(names(rosters[0]).slice(0, 5)).toEqual([
        "Omarion Hampton", "Travis Etienne", "Michael Pittman", choice, "D'Andre Swift",
      ]);
      expect(rosters.map((roster) => roster.length)).toEqual(liveState.teams.map((team) => team.draftRosterSize));
      expect(new Set(rosters.flat().map((player) => player.id)).size).toBe(rosters.flat().length);
    }
  });

  it("lets opponents draft London after we take Wilson, instead of reserving him for 25", () => {
    const london = livePlayer("Drake London");
    expect(survivalProbability({ adp: london.adp ?? null, adpStdev: london.adpStdev ?? null }, 25, 184)).toBeLessThan(0.000001);
    const rosters = completeDraft(liveState, liveConfig, livePlayer("Garrett Wilson"));
    expect(names(rosters[0])).not.toContain("Drake London");
    // This team owns 20; London is its first remaining selection in the frozen state.
    expect(liveState.teams[1].remainingPicks[0]).toBe(20);
    expect(rosters[1][liveState.teams[1].roster.length].name).toBe("Drake London");
    expect(rosters.flat().filter((player) => player.id === london.id)).toHaveLength(1);
  });

  it("scores the complete responsive league for every recommendation", () => {
    const seed = 20260731;
    const advice = recommendByChampionship(liveState, liveConfig, seed);
    for (const choice of ["Drake London", "Garrett Wilson"]) {
      const rosters = completeDraft(liveState, liveConfig, livePlayer(choice));
      const scores = rosters.map((roster, index) => sampleTeamWeeklyScores(trimDraftRoster(roster, liveState.rosterSize, liveConfig.slots), liveConfig, index === 0 ? seed : seed + 999 + index));
      const expected = simulateLeague(scores, liveConfig)[0];
      const actual = advice.find((entry) => entry.player.name === choice)!;
      expect(actual).toBeDefined();
      expect(actual.championshipProbability).toBeCloseTo(expected.championshipProbability, 4);
      expect(actual.playoffProbability).toBe(expected.playoffProbability);
      expect(actual.expectedPoints).toBe(expected.expectedPoints);
    }
    // Fixed seed diagnostic, not calibrated odds: the old shortcut returned 13.33%.
    expect(advice.find((entry) => entry.player.name === "Garrett Wilson")!.championshipProbability).toBeLessThan(0.11);
  });
});

const player = (id: string, weeklyMean: number): PlayerRisk => ({
  id, name: id, position: "WR", weeklyMean, availability: 1, byeWeek: 18,
  p10: 1, p90: 1, adp: weeklyMean, adpStdev: 2,
});
const config: LeagueConfig = {
  slots: [{ id: "wr", label: "WR", eligiblePositions: ["WR"] }],
  weeks: [1], playoffWeeks: [2], playoffTeams: 2, scenarios: 8, meanAbsenceWeeks: 3,
  wireCover: new Map(), unprojectedPositions: new Set(),
};

describe("chronological owned-square accounting", () => {
  const state = (): DraftPolicyState => ({
    myTeamIndex: 1, rosterSize: 2,
    available: [player("best", 30), player("second", 20), player("forced", 10), player("fourth", 5), player("last", 1)],
    teams: [
      { id: "other", name: "Other", roster: [], remainingPicks: [24, 17], draftRosterSize: 2 },
      { id: "us", name: "Us", roster: [player("keeper-at-76", 2)], remainingPicks: [25, 16], draftRosterSize: 4 },
    ],
  });

  it("consumes a forced pick at the correct nonzero team index with traded capacity", () => {
    const input = state();
    const before = structuredClone(input);
    const result = completeDraft(input, config, input.available[2]);
    expect(names(result[0])).toEqual(["best", "second"]);
    expect(names(result[1])).toEqual(["keeper-at-76", "forced", "fourth"]);
    // One keeper plus two owned selections, even though four draft roster seats exist.
    expect(result[1]).toHaveLength(3);
    expect(new Set(result.flat().map((entry) => entry.id)).size).toBe(5);
    expect(input).toEqual(before);
  });

  it("never steals a forced player from an earlier opponent pick", () => {
    const input = state();
    input.teams[0].remainingPicks = [15, 17];
    expect(() => completeDraft(input, config, input.available[0])).toThrow(/unavailable at owned pick 16/);
    const advice = recommendByChampionship(input, config, 1, 10);
    expect(advice.length).toBeGreaterThan(0);
    expect(advice.some((entry) => entry.player.id === "best")).toBe(false);
  });

  it("does not fabricate selections when picks or roster room run out", () => {
    for (const boundary of ["no-picks", "full"] as const) {
      const input = state();
      if (boundary === "no-picks") input.teams[1].remainingPicks = [];
      else input.teams[1].draftRosterSize = 1;
      expect(names(completeDraft(input, config, input.available[2])[1])).toEqual(["keeper-at-76"]);
      expect(recommendByChampionship(input, config, 1)).toEqual([]);
    }
  });

  it("rejects a forced identity outside the available pool", () => {
    expect(() => completeDraft(state(), config, player("not-on-board", 99))).toThrow(/unavailable/);
    expect(() => completeDraft(state(), config, player("keeper-at-76", 2))).toThrow(/unavailable/);
  });

  it("returns no off-turn advice if intervening picks exhaust the board", () => {
    const input = state();
    input.available = input.available.slice(0, 1);
    input.teams[0].remainingPicks = [15];
    expect(recommendByChampionship(input, config, 1)).toEqual([]);
  });
});
