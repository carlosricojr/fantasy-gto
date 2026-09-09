import { describe, expect, it } from "vitest";
import live from "../../tests/fixtures/sleeper-pick16-continuation.json";
import historical from "../../tests/fixtures/draft-evaluation-2024.json";
import { evaluateRecordedDraft, evaluateSimulatedDraft, replayDraftStrategy, type EvaluationOpponent } from "./draft-evaluation";
import { completeDraft, recommendByChampionship, type DraftPolicyState } from "./draft-policy";
import { filledStarterCount } from "./draft-feasibility";
import type { PlayerRisk } from "./roster-utility";
import type { LeagueConfig } from "./season-sim";

const hydrate = (player: PlayerRisk) => ({ ...player, weeklyOutcomeRatios: (live.distributions as Record<string, number[]>)[player.position] });
const state: DraftPolicyState = { ...live.state, available: live.state.available.map(hydrate), teams: live.state.teams.map((team) => ({ ...team, roster: team.roster.map(hydrate) })) };
const config: LeagueConfig = { ...live.config, scenarios: 4, wireCover: new Map(live.config.wireCover as [string, number][]), unprojectedPositions: new Set(live.config.unprojectedPositions) };

describe("paired draft evaluation", () => {
  it.each<EvaluationOpponent>(["strict-adp", "needs-adp", "noisy-adp"])("finishes the formerly QB-less live continuation against %s", (opponent) => {
    const before = structuredClone(state);
    for (const strategy of ["adp", "roster-needs", "greedy"] as const) {
      const result = replayDraftStrategy(state, config, strategy, opponent, 123, 456);
      expect(result.missingStarters[0]).toBe(0);
      expect(result.rosters[0]).toHaveLength(16);
      expect(result.rosters.map((roster) => roster.length)).toEqual(state.teams.map((team) => Math.min(team.draftRosterSize!, 16)));
      expect(new Set(result.rosters.flat().map((player) => player.id)).size).toBe(result.rosters.flat().length);
      if (opponent !== "strict-adp") expect(result.missingStarters).toEqual(Array(10).fill(0));
    }
    expect(state).toEqual(before);
  });

  it.each<EvaluationOpponent>(["strict-adp", "needs-adp", "noisy-adp"])("fills required starters after either exact pick-16 choice against %s", (opponent) => {
    for (const name of ["Drake London", "Garrett Wilson"]) {
      const choice = state.available.find((player) => player.name === name)!;
      const afterPick: DraftPolicyState = {
        ...state, available: state.available.filter((player) => player.id !== choice.id),
        teams: state.teams.map((team, index) => index !== state.myTeamIndex ? team : {
          ...team, roster: [...team.roster, choice], remainingPicks: team.remainingPicks.filter((pick) => pick !== 16),
        }),
      };
      const result = replayDraftStrategy(afterPick, config, "greedy", opponent, 123, 456);
      expect(result.missingStarters[0]).toBe(0);
      expect(result.rosters[0].filter((player) => player.position === "QB").length).toBeGreaterThan(0);
      expect(result.rosters[0].some((player) => player.id === choice.id)).toBe(true);
      expect(new Set(result.rosters.flat().map((player) => player.id)).size).toBe(result.rosters.flat().length);
    }
  });

  it("has complete historical identity coverage without selecting on 2024 outcomes", () => {
    expect(historical.provenance.unresolved).toEqual([]);
    expect(historical.rows).toHaveLength(178);
    expect(new Set(historical.rows.map((row) => row.player.id)).size).toBe(178);
    expect(historical.provenance.trainingSeasons).toEqual([2022, 2023]);
    expect(Object.keys(historical.provenance.sources).some((key) => key.includes("2025"))).toBe(false);
    expect(historical.rows.some((row) => row.modelPoints === null)).toBe(true); // rookies stay in
    expect(historical.rows.every((row) => row.actual !== null)).toBe(true);
  });

  it("uses archived opening teams and schedule rather than mutable historical ADP metadata", () => {
    expect(historical.provenance.missingOpeningTeams).toEqual([]);
    expect(historical.provenance.replacedAdpByes).toBe(160);
    expect(historical.rows.find((row) => row.player.name === "Josh Allen")?.player.byeWeek).toBe(12);
    const adams = historical.rows.find((row) => row.player.name === "Davante Adams");
    expect(adams?.openingTeam).toBe("LV");
    expect(adams?.player.byeWeek).toBe(10);
    expect(historical.rows.every((row) => row.player.byeWeek !== null)).toBe(true);
    expect(Object.keys(historical.provenance.sources)).toContain("games.csv");
    expect(Object.keys(historical.provenance.sources).some((key) => key.includes("roster_weekly_2024.csv"))).toBe(true);
  });

  it("does not turn unavailable starter supply into a normal title estimate", () => {
    const impossible = { ...state, available: state.available.filter((player) => player.position !== "QB") };
    expect(() => recommendByChampionship(impossible, config, 7)).toThrow(/No legal draft completion/);
  });

  it("does not inflate a legal candidate's edge against an illegal default continuation", () => {
    const make = (id: string, position: string, weeklyMean: number): PlayerRisk => ({ id, name: id, position, weeklyMean, availability: 1, byeWeek: 18, p10: 1, p90: 1 });
    const input: DraftPolicyState = { myTeamIndex: 0, rosterSize: 2,
      available: [make("qb1", "QB", 2), make("qb2", "QB", 1), make("rb1", "RB", 20), make("rb2", "RB", 19)],
      teams: [
        { id: "0", name: "0", roster: [], remainingPicks: [1, 4] },
        { id: "1", name: "1", roster: [make("held1", "RB", 100)], remainingPicks: [2] },
        { id: "2", name: "2", roster: [make("held2", "RB", 100)], remainingPicks: [3] },
      ],
    };
    const simple: LeagueConfig = { ...config, slots: ["QB", "RB"].map((position) => ({ id: position, label: position, eligiblePositions: [position] })),
      weeks: [1], playoffWeeks: [2, 3], playoffTeams: 2, wireCover: new Map() };
    // Two opponents consume both QBs: the single-position last-supply guard is
    // deliberately not a general adversarial-lookahead proof of future availability.
    expect(filledStarterCount(completeDraft(input, simple, null)[0], simple.slots)).toBe(1);
    expect(filledStarterCount(completeDraft(input, simple, input.available[0])[0], simple.slots)).toBe(2);
    expect(() => recommendByChampionship(input, simple, 7)).toThrow(/No legal default-policy continuation/);
  });

  it("discloses incomplete opponents instead of preventing our own legal draft", () => {
    const input: DraftPolicyState = {
      ...state, teams: state.teams.map((team, index) => index === 1 ? { ...team, remainingPicks: [] } : team),
    };
    const advice = recommendByChampionship(input, config, 7, 1);
    expect(advice.length).toBeGreaterThan(0);
    expect(advice.every((entry) => (entry.incompleteOpponentTeams ?? 0) >= 1)).toBe(true);
    expect(advice.every((entry) => (entry.incompleteBaselineOpponentTeams ?? 0) >= 1)).toBe(true);
  });

  it("external scoring sets the lineup before reading actual outcomes, including negative starts", () => {
    const make = (id: string, weeklyMean: number): PlayerRisk => ({ id, name: id, position: "WR", weeklyMean, availability: 1, byeWeek: 18, p10: 1, p90: 1 });
    const rosters = [[make("start", 10), make("bench", 9)], [make("opponent", 5)]];
    const simple: LeagueConfig = { ...config, slots: [{ id: "WR", label: "WR", eligiblePositions: ["WR"] }], weeks: [1], playoffWeeks: [2], playoffTeams: 2 };
    const actual = new Map([
      ["start", new Map([[1, -5], [2, -5]])], ["bench", new Map([[1, 100], [2, 100]])], ["opponent", new Map([[1, 5], [2, 5]])],
    ]);
    const result = evaluateRecordedDraft(rosters, simple, actual);
    expect(result.outcomes[0].expectedPoints).toBe(-5);
    expect(result.championByScenario).toEqual([1]);
    expect(() => evaluateRecordedDraft(rosters, simple, new Map())).toThrow(/Unresolved external outcomes/);
    const sampled = evaluateSimulatedDraft(rosters, { ...simple, scenarios: 3 }, 777);
    expect(sampled).toEqual(evaluateSimulatedDraft(rosters, { ...simple, scenarios: 3 }, 777));
  });

  it("the structural feasibility assertion is independent of the valuation sign", () => {
    const roster = state.available.slice(0, 16).map((player) => ({ ...player, weeklyMean: -100 }));
    expect(filledStarterCount(roster, config.slots)).toBe(filledStarterCount(roster.map((player) => ({ ...player, weeklyMean: 100 })), config.slots));
  });
});
