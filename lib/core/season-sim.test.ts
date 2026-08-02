import { describe, expect, it } from "vitest";

import type { RosterSlot } from "./optimizer";
import type { PlayerRisk } from "./roster-utility";
import {
  type LeagueConfig,
  bracketRoundsRequired,
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
    teams.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, seed + i));

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
    const fieldScores = field.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, 100 + i));

    // Both rosters carry the tag "t" on purpose. `playerStream` keys each player's random
    // stream on his *id*, so a shared seed alone does not pair two samples — only a shared
    // id does. With different tags these were independent draws, and the ±5 tolerance below
    // is about the size of the volatile estimate's own standard error, so the equality it
    // asserts was luck rather than common random numbers.
    const steady = sampleTeamWeeklyScores(
      roster("t", 12, { p10: 0.85, p90: 1.15 }),
      CONFIG,
      50,
    );
    const volatile = sampleTeamWeeklyScores(
      roster("t", 12, { p10: 0.15, p90: 2.4 }),
      CONFIG,
      50,
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
    const fieldScores = field.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, 200 + i));

    const steady = sampleTeamWeeklyScores(
      roster("steady", 20, { p10: 0.85, p90: 1.15 }),
      CONFIG,
      60,
    );
    const volatile = sampleTeamWeeklyScores(
      roster("volatile", 20, { p10: 0.15, p90: 2.4 }),
      CONFIG,
      60,
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
    const mine = sampleTeamWeeklyScores(roster("mine", 15), CONFIG, 70);

    const weak = Array.from({ length: 7 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`w${i}`, 10), CONFIG, 300 + i),
    );
    const strong = Array.from({ length: 7 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`s${i}`, 20), CONFIG, 400 + i),
    );

    const inWeak = championshipProbability(mine, weak, CONFIG);
    const inStrong = championshipProbability(mine, strong, CONFIG);

    expect(inWeak.expectedPoints).toBeCloseTo(inStrong.expectedPoints, 6);
    expect(inWeak.championshipProbability).toBeGreaterThan(
      inStrong.championshipProbability * 3,
    );
  });
});

describe("ties and bracket sufficiency", () => {
  const weeks = Array.from({ length: 14 }, (_, i) => i + 1);
  const cfg: LeagueConfig = {
    slots: SLOTS,
    weeks,
    playoffWeeks: [15, 16],
    playoffTeams: 4,
    scenarios: 1,
    meanAbsenceWeeks: 3,
  };

  it("spreads titles evenly when every team is identical and tied", () => {
    // Our team is always index 0, and the seeding tiebreak used to be array position, so
    // in a fully tied league we took seed 1, won every bracket tie, and finished with a
    // championship probability of exactly 1.0.
    const tied = Array.from({ length: 8 }, () =>
      Array.from({ length: 400 }, () => [...weeks, 15, 16].map(() => 0)),
    );
    const outcomes = simulateLeague(tied, { ...cfg, scenarios: 400 });
    for (const outcome of outcomes) {
      expect(outcome.championshipProbability).toBeGreaterThan(0.05);
      expect(outcome.championshipProbability).toBeLessThan(0.25);
    }
  });

  it("gives the top seeds a first-round bye when the field is not a power of two", () => {
    // A six-team field previously played all six in round one, leaving three, and the bye
    // then fell in round two on whoever happened to survive — so seed 2 got one only if
    // seed 1 lost. Here seeds 1 and 2 score nothing in the first playoff week: with real
    // byes they are not playing, and should still win.
    const line = (reg: number, a: number, b: number, c: number) => [
      [...weeks.map(() => reg), a, b, c],
    ];
    const field = [
      line(100, 0, 100, 100),
      line(99, 0, 100, 100),
      line(98, 50, 50, 50),
      line(97, 50, 50, 50),
      line(96, 50, 50, 50),
      line(95, 50, 50, 50),
    ];
    const outcomes = simulateLeague(field, {
      ...cfg,
      scenarios: 1,
      playoffTeams: 6,
      playoffWeeks: [15, 16, 17],
    });
    expect(outcomes[0].championshipProbability).toBe(1);
  });

  it("rejects a non-positive or fractional playoff field", () => {
    const scores = Array.from({ length: 8 }, () => [[...weeks, 15, 16].map(() => 1)]);
    for (const playoffTeams of [0, -1, 1.5]) {
      expect(() => simulateLeague(scores, { ...cfg, playoffTeams })).toThrow(
        /positive integer/,
      );
    }
  });

  it("splits a tie instead of handing it to whoever is nominally at home", () => {
    // The circle method holds team 0 fixed, so it sat in the home position in all
    // fourteen weeks while everyone else got five to eight. Awarding ties to the home
    // side gave team 0 fourteen wins and everyone else six, from games that were all
    // 0-0. Ties are reachable: early in a draft two teams can both field nobody.
    const allTied = Array.from({ length: 8 }, () => [
      [...weeks, 15, 16].map(() => 0),
    ]);
    const outcomes = simulateLeague(allTied, cfg);
    for (const outcome of outcomes) {
      expect(outcome.expectedWins).toBeCloseTo(weeks.length / 2, 6);
    }
  });

  it("still awards a clean win when scores differ", () => {
    const scores = Array.from({ length: 8 }, (_, i) => [
      [...weeks, 15, 16].map(() => 100 - i),
    ]);
    const outcomes = simulateLeague(scores, cfg);
    // The strongest team wins every week it plays.
    expect(outcomes[0].expectedWins).toBeCloseTo(weeks.length, 6);
  });

  it("knows how many rounds a bracket needs", () => {
    expect(bracketRoundsRequired(1)).toBe(0);
    expect(bracketRoundsRequired(2)).toBe(1);
    expect(bracketRoundsRequired(4)).toBe(2);
    expect(bracketRoundsRequired(5)).toBe(3);
    expect(bracketRoundsRequired(6)).toBe(3);
    expect(bracketRoundsRequired(8)).toBe(3);
  });

  it("refuses a bracket that cannot finish rather than crowning a survivor", () => {
    // Six qualifiers over two weeks previously crowned a different team than the same six
    // over three, with nothing to indicate the final was never played.
    const scores = Array.from({ length: 12 }, (_, i) => [
      [...weeks, 15, 16].map(() => 100 - i),
    ]);
    expect(() =>
      simulateLeague(scores, { ...cfg, playoffTeams: 6, playoffWeeks: [15, 16] }),
    ).toThrow(/needs 3 playoff week/);
    expect(() =>
      simulateLeague(scores, { ...cfg, playoffTeams: 2, playoffWeeks: [] }),
    ).toThrow();
  });

  it("accepts a bracket with exactly enough rounds, and with spare ones", () => {
    const scores = Array.from({ length: 12 }, (_, i) => [
      [...weeks, 15, 16, 17].map(() => 100 - i),
    ]);
    expect(() =>
      simulateLeague(scores, { ...cfg, playoffTeams: 6, playoffWeeks: [15, 16, 17] }),
    ).not.toThrow();
    expect(() =>
      simulateLeague(scores, { ...cfg, playoffTeams: 4, playoffWeeks: [15, 16, 17] }),
    ).not.toThrow();
  });
});

describe("simulateLeague scenario validation", () => {
  it("refuses a team that supplies the wrong number of scenarios", () => {
    // The week dimension was guarded and the scenario dimension was not, so this used to
    // reach the simulation loop and die on an undefined index — an unreadable TypeError
    // from inside a Monte Carlo run. It is reachable through
    // `recommendByChampionship`, which samples opponents once and reuses that sample
    // across candidates, so a cached sample and a changed config disagree here.
    // Six teams, not two: with `playoffTeams: 4` a two-team league is an oversized
    // playoff field, and asserting it does *not* throw locked in behaviour that is now
    // rejected outright.
    const config = { ...CONFIG, scenarios: 3 };
    const weeks = config.weeks.length + config.playoffWeeks.length;
    const team = (scenarios: number) =>
      Array.from({ length: scenarios }, () => new Array(weeks).fill(10));
    const six = Array.from({ length: 6 }, () => team(3));

    expect(() => simulateLeague([...six.slice(0, 5), team(2)], config)).toThrow(
      /scenario/i,
    );
    expect(() => simulateLeague(six, config)).not.toThrow();
  });

  it("refuses a playoff field larger than the league", () => {
    // The clamp inside the bracket maths reinterpreted this as "everyone qualifies", so a
    // misconfigured league produced a full table of plausible-looking odds instead of an
    // error. A field *equal* to the league is left alone — unusual, but the regular season
    // still decides seeding and the first-round byes.
    const config = { ...CONFIG, scenarios: 2, playoffTeams: 6 };
    const weeks = config.weeks.length + config.playoffWeeks.length;
    const scores = Array.from({ length: 4 }, () =>
      Array.from({ length: 2 }, () => new Array(weeks).fill(10)),
    );
    expect(() => simulateLeague(scores, config)).toThrow(/not that many teams/i);
  });
});
