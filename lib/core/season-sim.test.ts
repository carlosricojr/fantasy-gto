import { describe, expect, it } from "vitest";

import type { RosterSlot } from "./optimizer";
import { createRng } from "./rng";
import type { PlayerRisk } from "./roster-utility";
import {
  type LeagueConfig,
  championshipProbability,
  roundRobinSchedule,
  sampleTeamWeeklyScores,
  simulateLeague,
} from "./season-sim";

/**
 * League simulation.
 *
 * The tests that matter here are the ones showing championship probability is a different
 * objective from expected points, because that difference is the entire reason this module
 * exists.
 */

const SLOTS: RosterSlot[] = [
  { id: "rb1", label: "RB", eligiblePositions: ["RB"] },
  { id: "rb2", label: "RB", eligiblePositions: ["RB"] },
  { id: "wr1", label: "WR", eligiblePositions: ["WR"] },
];

const CONFIG: LeagueConfig = {
  slots: SLOTS,
  weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  playoffWeeks: [15, 16],
  playoffTeams: 4,
  scenarios: 400,
  meanAbsenceWeeks: 3,
};

function player(
  id: string,
  position: string,
  weeklyMean: number,
  overrides: Partial<PlayerRisk> = {},
): PlayerRisk {
  return {
    id,
    name: id,
    position,
    weeklyMean,
    p10: 0.269,
    p90: 1.901,
    byeWeek: null,
    availability: 1,
    ...overrides,
  };
}

/** A roster of a given strength, with an optional volatility override. */
function roster(tag: string, strength: number, spread?: { p10: number; p90: number }) {
  return [
    player(`${tag}-rb1`, "RB", strength, spread),
    player(`${tag}-rb2`, "RB", strength * 0.9, spread),
    player(`${tag}-wr1`, "WR", strength * 0.85, spread),
  ];
}

describe("roundRobinSchedule", () => {
  it("pairs every team exactly once each week", () => {
    const schedule = roundRobinSchedule(12, 14);
    for (const week of schedule) {
      const played = week.flat();
      expect(played).toHaveLength(12);
      expect(new Set(played).size).toBe(12);
    }
  });

  it("never matches a team against itself", () => {
    for (const week of roundRobinSchedule(10, 13)) {
      for (const [home, away] of week) expect(home).not.toBe(away);
    }
  });

  it("covers every opponent before repeating", () => {
    // Eleven distinct opponents in an twelve-team league, so the first eleven weeks
    // should contain no repeat for a given team.
    const schedule = roundRobinSchedule(12, 11);
    const opponents = new Set<number>();
    for (const week of schedule) {
      for (const [home, away] of week) {
        if (home === 0) opponents.add(away);
        if (away === 0) opponents.add(home);
      }
    }
    expect(opponents.size).toBe(11);
  });

  it("handles an odd league by sitting one team out", () => {
    for (const week of roundRobinSchedule(11, 5)) {
      expect(week.length).toBe(5);
      expect(new Set(week.flat()).size).toBe(10);
    }
  });
});

describe("simulateLeague", () => {
  const scoresFor = (teams: PlayerRisk[][], seed: number) =>
    teams.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, createRng(seed + i)));

  it("awards exactly one championship per scenario", () => {
    const teams = Array.from({ length: 8 }, (_, i) => roster(`t${i}`, 12 + i));
    const outcomes = simulateLeague(scoresFor(teams, 1), { ...CONFIG, playoffTeams: 4 });
    const total = outcomes.reduce((s, o) => s + o.championshipProbability, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it("fills exactly the available playoff berths", () => {
    const teams = Array.from({ length: 8 }, (_, i) => roster(`t${i}`, 12 + i));
    const outcomes = simulateLeague(scoresFor(teams, 2), { ...CONFIG, playoffTeams: 4 });
    const berths = outcomes.reduce((s, o) => s + o.playoffProbability, 0);
    expect(berths).toBeCloseTo(4, 6);
  });

  it("gives every team the same record on average when they are identical", () => {
    const teams = Array.from({ length: 8 }, (_, i) => roster(`t${i}`, 14));
    const outcomes = simulateLeague(scoresFor(teams, 3), CONFIG);
    const wins = outcomes.map((o) => o.expectedWins);
    // Fourteen weeks, so seven wins each; sampling noise keeps this loose.
    for (const w of wins) expect(Math.abs(w - 7)).toBeLessThan(1.2);
  });

  it("ranks a stronger roster higher", () => {
    const teams = [roster("strong", 20), ...Array.from({ length: 7 }, (_, i) => roster(`t${i}`, 12))];
    const outcomes = simulateLeague(scoresFor(teams, 4), CONFIG);
    expect(outcomes[0].championshipProbability).toBeGreaterThan(
      outcomes[1].championshipProbability,
    );
  });
});

describe("championship probability is not expected points", () => {
  it("costs an underdog wins to be volatile, despite identical expected points", () => {
    // Counter-intuitive, and the reason this is simulated rather than reasoned about.
    // "Underdogs should want variance" is true in a single winner-take-all shot; a
    // fourteen-week head-to-head season is the opposite regime. A weekly matchup is won by
    // out-scoring one opponent, so what pays is the *median* week, and right-skewed
    // variance at a fixed mean lowers the median — the same points arrive in fewer, larger
    // spikes that are wasted on weeks already won.
    //
    // Measured at 2,000 scenarios: identical expected points, weekly median falling 32.9
    // to 25.4, expected wins falling with it. Boom-or-bust players are therefore worth
    // less than their projection suggests in head-to-head, which is an actionable result
    // no points-based valuation can produce.
    const field = Array.from({ length: 7 }, (_, i) => roster(`f${i}`, 18));
    const fieldScores = field.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, createRng(100 + i)));

    const steady = sampleTeamWeeklyScores(
      roster("steady", 12, { p10: 0.85, p90: 1.15 }),
      CONFIG,
      createRng(50),
    );
    const volatile = sampleTeamWeeklyScores(
      roster("volatile", 12, { p10: 0.15, p90: 2.4 }),
      CONFIG,
      createRng(50),
    );

    const steadyOutcome = championshipProbability(steady, fieldScores, CONFIG);
    const volatileOutcome = championshipProbability(volatile, fieldScores, CONFIG);

    // Same points, fewer wins.
    expect(volatileOutcome.expectedPoints).toBeCloseTo(steadyOutcome.expectedPoints, -1);
    expect(volatileOutcome.expectedWins).toBeLessThan(steadyOutcome.expectedWins);
  });

  it("prefers consistency when the roster is already the favourite", () => {
    // The mirror image, and why a single "variance is good" rule would be wrong. A
    // dominant roster is trying to protect a lead, so noise can only cost it.
    const field = Array.from({ length: 7 }, (_, i) => roster(`f${i}`, 10));
    const fieldScores = field.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, createRng(200 + i)));

    const steady = sampleTeamWeeklyScores(
      roster("steady", 20, { p10: 0.85, p90: 1.15 }),
      CONFIG,
      createRng(60),
    );
    const volatile = sampleTeamWeeklyScores(
      roster("volatile", 20, { p10: 0.15, p90: 2.4 }),
      CONFIG,
      createRng(60),
    );

    const steadyOutcome = championshipProbability(steady, fieldScores, CONFIG);
    const volatileOutcome = championshipProbability(volatile, fieldScores, CONFIG);

    expect(steadyOutcome.championshipProbability).toBeGreaterThan(
      volatileOutcome.championshipProbability,
    );
  });

  it("is decided by the opponents you face, not by your points alone", () => {
    // The same roster, two different leagues. Expected points are identical; championship
    // odds are not. No valuation that ignores opponents can express this.
    const mine = sampleTeamWeeklyScores(roster("mine", 15), CONFIG, createRng(70));

    const weak = Array.from({ length: 7 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`w${i}`, 10), CONFIG, createRng(300 + i)),
    );
    const strong = Array.from({ length: 7 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`s${i}`, 20), CONFIG, createRng(400 + i)),
    );

    const inWeak = championshipProbability(mine, weak, CONFIG);
    const inStrong = championshipProbability(mine, strong, CONFIG);

    expect(inWeak.expectedPoints).toBeCloseTo(inStrong.expectedPoints, 6);
    expect(inWeak.championshipProbability).toBeGreaterThan(
      inStrong.championshipProbability * 3,
    );
  });
});
