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
  tieBreakKey,
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

  it("prefers consistency when the roster is already the favorite", () => {
    // The mirror image, and why a single "variance is good" rule would be wrong. A
    // dominant roster is trying to protect a lead, so noise can only cost it.
    const field = Array.from({ length: 7 }, (_, i) => roster(`f${i}`, 10));
    const fieldScores = field.map((r, i) => sampleTeamWeeklyScores(r, CONFIG, 200 + i));

    // Both rosters carry the tag "t", for the reason the test above states: `playerStream`
    // keys each player's random stream on his *id*, so a shared seed alone does not pair
    // two samples — only a shared id does. With different tags these were independent
    // draws and the volatility was being measured against that independent noise rather
    // than against itself.
    const steady = sampleTeamWeeklyScores(
      roster("t", 20, { p10: 0.85, p90: 1.15 }),
      CONFIG,
      60,
    );
    const volatile = sampleTeamWeeklyScores(
      roster("t", 20, { p10: 0.15, p90: 2.4 }),
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
    // playoff field, and asserting it does *not* throw locked in behavior that is now
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
    // The clamp inside the bracket math reinterpreted this as "everyone qualifies", so a
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

/**
 * The bracket, played out rather than assumed.
 *
 * A mutation run found seventeen high-severity survivors in this file, and almost all of
 * them share a shape: the bracket silently stops being played. Returning the top seed
 * immediately, reading a regular-season week instead of a playoff week, giving byes to a
 * field that is also playing, halving the games — none of it throws. Championship
 * probability just quietly becomes "probability of finishing first in the regular season",
 * which is a different product.
 *
 * These fixtures are fully deterministic: one scenario, constant weekly scores, so every
 * assertion is an exact outcome rather than a rate. That is the only way to tell a bracket
 * that was played from one that was skipped.
 */
describe("the playoff bracket is actually played", () => {
  const REG = 14;

  /** Scores for one team: a constant regular season, then explicit playoff weeks. */
  const line = (regular: number, playoffs: readonly number[]) => [
    [...Array.from({ length: REG }, () => regular), ...playoffs],
  ];

  it("crowns the team that wins the final, not the top seed", () => {
    // Four qualifiers. Seeding is by record, so team i is seed i. Round one pairs 1v4 and
    // 2v3; both favorites win. In the final the top seed scores nothing.
    //
    // Every "skip the bracket" mutant returns team 0 here — that is the point of the
    // fixture. So does reading the wrong week, since week 16 is where team 0 scores zero.
    const config: LeagueConfig = { ...CONFIG, playoffTeams: 4, scenarios: 1 };
    const scores = [
      line(100, [100, 0]), // seed 1: wins round one, loses the final
      line(99, [100, 50]), // seed 2: wins round one, wins the final
      line(98, [50, 0]),
      line(97, [50, 0]),
      line(96, [0, 0]),
      line(95, [0, 0]),
      line(94, [0, 0]),
      line(93, [0, 0]),
    ];
    const outcomes = simulateLeague(scores, config);

    expect(outcomes[1].championshipProbability).toBe(1);
    expect(outcomes[0].championshipProbability).toBe(0);
    // And the four best records are the ones that made it.
    expect(outcomes.slice(0, 4).map((o) => o.playoffProbability)).toEqual([1, 1, 1, 1]);
    expect(outcomes.slice(4).map((o) => o.playoffProbability)).toEqual([0, 0, 0, 0]);
  });

  it("gives a six-team field its byes to the top two seeds only", () => {
    // Six qualifiers is a real option and the only field shape that catches several of the
    // bye-slice mutants: seeds 1 and 2 sit out round one while 3v6 and 4v5 play. A wrong
    // slice either byes four teams or drops seeds 3 and 4 from the bracket entirely.
    //
    // The bottom seed wins all three playoff weeks, so only a bracket that actually played
    // him can crown him.
    const config: LeagueConfig = {
      ...CONFIG,
      playoffTeams: 6,
      playoffWeeks: [15, 16, 17],
      scenarios: 1,
    };
    const scores = [
      line(100, [10, 10, 10]),
      line(99, [10, 10, 10]),
      line(98, [10, 10, 10]),
      line(97, [10, 10, 10]),
      line(96, [10, 10, 10]),
      line(95, [1000, 1000, 1000]), // seed 6, beats everyone he meets
      line(94, [0, 0, 0]),
      line(93, [0, 0, 0]),
    ];
    expect(simulateLeague(scores, config)[5].championshipProbability).toBe(1);
  });

  it("keeps a middle seed in a six-team bracket rather than dropping him", () => {
    // Seed 3 plays in round one and must be able to win it all. A mis-sliced bye set
    // leaves only seeds 5 and 6 playing while 3 and 4 appear in neither list — eliminated
    // without playing a game, which no other fixture shape notices.
    const config: LeagueConfig = {
      ...CONFIG,
      playoffTeams: 6,
      playoffWeeks: [15, 16, 17],
      scenarios: 1,
    };
    const scores = [
      line(100, [10, 10, 10]),
      line(99, [10, 10, 10]),
      line(98, [1000, 1000, 1000]), // seed 3
      line(97, [10, 10, 10]),
      line(96, [10, 10, 10]),
      line(95, [10, 10, 10]),
      line(94, [0, 0, 0]),
      line(93, [0, 0, 0]),
    ];
    expect(simulateLeague(scores, config)[2].championshipProbability).toBe(1);
  });

  it("re-seeds after an upset, so round two pairs by seed and not by survival order", () => {
    // Six teams. Round one: seed 6 beats seed 3 and seed 4 beats seed 5, so the survivors
    // arrive out of order. Re-seeding pairs 1v6 and 2v4 in round two; leaving them in
    // survival order pairs 1v4 and 2v6 instead, and the scores below are chosen so those
    // two pairings crown different champions.
    //
    // An always-positive comparator is inconsistent, so V8 leaves the array untouched —
    // invisible unless a first-round upset has actually disturbed the order.
    const config: LeagueConfig = {
      ...CONFIG,
      playoffTeams: 6,
      playoffWeeks: [15, 16, 17],
      scenarios: 1,
    };
    const scores = [
      line(100, [0, 50, 100]),
      line(99, [0, 40, 0]),
      line(98, [10, 0, 0]),
      line(97, [90, 45, 100]),
      line(96, [10, 0, 0]),
      line(95, [90, 60, 0]),
      line(10, [0, 0, 0]),
      line(9, [0, 0, 0]),
    ];

    const outcomes = simulateLeague(scores, config);
    expect(outcomes[3].championshipProbability).toBe(1);
    expect(outcomes[0].championshipProbability).toBe(0);
  });
});

describe("season totals and seeding", () => {
  it("accumulates points for every team, including the first", () => {
    // Starting the accumulation loop at index 1 leaves team 0 on zero — and team 0 is
    // always the advised team, because `championshipProbability` puts it first and reads
    // `outcomes[0]`. An absolute value, so a scaling error in `round2` fails here too.
    const config: LeagueConfig = { ...CONFIG, scenarios: 1 };
    const flat = Array.from({ length: 8 }, () => [
      Array.from({ length: 16 }, () => 10),
    ]);
    const outcomes = simulateLeague(flat, config);
    for (const outcome of outcomes) {
      expect(outcome.expectedPoints).toBe(140);
    }
  });

  it("separates teams tied on record by points scored", () => {
    // This fixture had to be rebuilt: the previous one did not contain the situation the
    // test is named for. Its two highest scorers tied on record *and* on points, so the
    // hash decided between them and the points clause was never consulted, and the team
    // that actually took the second place did so on the best record in the league. The
    // assertion — that the two top scorers' playoff probabilities sum above zero — passed
    // on one of them qualifying, which is what it did.
    //
    // Teams 1 and 2 are constructed to finish level on record and apart on points. They
    // draw with each other every time they meet, both lose to team 0, and both beat team 3
    // — except once, where team 3 is given a single big week so that team 2 drops one game
    // and the two records converge on 6.5. Team 1's extra ten points a week fall only in
    // the weeks it plays team 0, where it loses either way, so they change the total and
    // no result. Measured: 6.5 wins each, 1450 points against 1400.
    const config: LeagueConfig = { ...CONFIG, playoffTeams: 2, scenarios: 1 };
    const line = (f: (week: number) => number) => [
      [...Array.from({ length: 14 }, (_, w) => f(w)), 10, 10],
    ];
    const outcomes = simulateLeague(
      [
        line(() => 1000),
        line((w) => (w % 3 === 1 ? 110 : 100)),
        line(() => 100),
        line((w) => (w === 1 ? 500 : 0)),
      ],
      config,
    );

    // The premise, asserted rather than assumed: level on record, apart on points.
    expect(outcomes[1].expectedWins).toBe(outcomes[2].expectedWins);
    expect(outcomes[1].expectedPoints).toBeGreaterThan(outcomes[2].expectedPoints);

    // So the points clause is the only thing that can decide the second place, and it does.
    expect(outcomes[0].playoffProbability).toBe(1);
    expect(outcomes[1].playoffProbability).toBe(1);
    expect(outcomes[2].playoffProbability).toBe(0);
  });
});

describe("roundRobinSchedule", () => {
  it("rotates the sit-out so every team in an odd league plays", () => {
    // `teamCount - 1` for an odd league drops the last team from the rotation entirely:
    // teams 0-9 play every week and team 10 plays none, all season.
    const schedule = roundRobinSchedule(11, 11);
    const games = new Array<number>(11).fill(0);
    for (const week of schedule) {
      for (const [home, away] of week) {
        games[home] += 1;
        games[away] += 1;
      }
    }
    for (const played of games) expect(played).toBeGreaterThan(0);
    expect(Math.max(...games) - Math.min(...games)).toBeLessThanOrEqual(1);
  });
});

/**
 * The rotation, and what decides a seed.
 *
 * `roundRobinSchedule` is the fixture list every simulated season is played over, and the
 * seeding comparator decides who reaches the bracket. Both had mutants that produce a
 * complete, plausible season that is simply the wrong one.
 */
describe("roundRobinSchedule rotates properly", () => {
  it("plays a different fixture list every week of the cycle", () => {
    // `size - 1` is the cycle length. Off by one and the rotation overruns, so
    // `rotation.slice(n)` comes back empty and several weeks silently repeat an earlier
    // one — two of fourteen, in a twelve-team league.
    const schedule = roundRobinSchedule(12, 14);
    const fingerprints = schedule.map((week) =>
      week
        .map(([h, a]) => `${Math.min(h, a)}v${Math.max(h, a)}`)
        .sort()
        .join(","),
    );
    // Eleven distinct rounds in a twelve-team cycle, then it repeats from the top.
    expect(new Set(fingerprints.slice(0, 11)).size).toBe(11);
    // Week 11 restarts the cycle, so it matches week 0 and not week 10.
    expect(fingerprints[11]).toBe(fingerprints[0]);
    expect(fingerprints[11]).not.toBe(fingerprints[10]);
    expect(fingerprints[12]).toBe(fingerprints[1]);
  });

  it("gives every team a game every week in an even league", () => {
    for (const week of roundRobinSchedule(12, 14)) {
      const playing = week.flat();
      expect(playing.length).toBe(12);
      expect(new Set(playing).size).toBe(12);
    }
  });
});

describe("seeding reads records first, then points", () => {
  it("seeds a worse record below a better one however many points it scored", () => {
    // `wins || points || tiebreak` becomes `(wins && points) || tiebreak` by precedence,
    // which drops the record entirely and seeds on points alone.
    //
    // High points and a poor record have to actually diverge for that to be visible, and
    // scoring hugely every week does not do it — it wins. Team 1 blows two weeks out and
    // loses the other twelve narrowly, so it leads the league on points and trails it on
    // record. Team 0 wins almost everything by a small margin.
    const config: LeagueConfig = { ...CONFIG, playoffTeams: 2, scenarios: 1 };
    const pad = Array.from({ length: config.playoffWeeks.length }, () => 0);
    const week = (regular: number[]) => [[...regular, ...pad]];

    const blowouts = [0, 1];
    const scores = [
      week(Array.from({ length: 14 }, () => 60)),
      week(Array.from({ length: 14 }, (_, w) => (blowouts.includes(w) ? 900 : 10))),
      week(Array.from({ length: 14 }, () => 40)),
      week(Array.from({ length: 14 }, () => 40)),
    ];

    const outcomes = simulateLeague(scores, config);

    // Team 1 leads on points by a wide margin and trails on record — the fixture is only
    // meaningful if both are true, so both are asserted.
    const totals = outcomes.map((o) => o.expectedPoints);
    expect(Math.max(...totals)).toBe(totals[1]);
    expect(outcomes[1].expectedWins).toBeLessThan(outcomes[0].expectedWins);

    // Record decides the bracket, so the points leader does not qualify.
    expect(outcomes[0].playoffProbability).toBe(1);
    expect(outcomes[1].playoffProbability).toBe(0);
  });

  it("shares the places fairly when records and points are both identical", () => {
    // Every game a tie and every total equal, so neither the record nor the points clause
    // can separate anyone and the scenario-dependent shuffle key is all that is left. That
    // key exists because seeding by array index handed our team — always index 0 — every
    // tie, and our title probability came out at exactly 1.0.
    //
    // Over many scenarios the two places must therefore be shared, not owned. A comparator
    // turned into a sum is positive for every pair, which is inconsistent: the sort leaves
    // the array alone and the first two indices take every place in every scenario.
    const config: LeagueConfig = { ...CONFIG, playoffTeams: 2, scenarios: 200 };
    const weeks = config.weeks.length + config.playoffWeeks.length;
    const one = Array.from({ length: weeks }, (_, w) => 10 + w);
    const scores = Array.from({ length: 4 }, () =>
      Array.from({ length: config.scenarios }, () => [...one]),
    );

    const outcomes = simulateLeague(scores, config);

    // The fixture is only meaningful if nothing else can separate them.
    expect(new Set(outcomes.map((o) => o.expectedWins)).size).toBe(1);
    expect(new Set(outcomes.map((o) => o.expectedPoints)).size).toBe(1);

    // Two places, shared rather than owned.
    const total = outcomes.reduce((n, o) => n + o.playoffProbability, 0);
    expect(total).toBeCloseTo(2, 6);
    for (const outcome of outcomes) {
      expect(outcome.playoffProbability).toBeGreaterThan(0.2);
      expect(outcome.playoffProbability).toBeLessThan(0.8);
    }
  });
});

/**
 * The edges of the schedule and the bracket.
 *
 * Everything above exercises a normal league — eight to twelve teams, four to six
 * qualifiers, a bracket two or three rounds deep. These are the sizes either side of that,
 * and the guards that decide which sizes are allowed at all. Each one below was a surviving
 * mutant: a boundary that could be moved by one without a single assertion changing.
 */
describe("league sizes at the boundary", () => {
  const weeks = Array.from({ length: 14 }, (_, i) => i + 1);
  const cfg: LeagueConfig = {
    slots: SLOTS,
    weeks,
    playoffWeeks: [15, 16],
    playoffTeams: 4,
    scenarios: 1,
    meanAbsenceWeeks: 3,
  };
  /** `n` teams, every one of them scoring `points` in every week of every scenario. */
  const flat = (n: number, points: (team: number) => number, extraWeeks = 2) =>
    Array.from({ length: n }, (_, t) => [
      [...weeks, ...Array.from({ length: extraWeeks }, (_, i) => 15 + i)].map(() =>
        points(t),
      ),
    ]);

  it("plays a two-team league rather than treating it as too small to schedule", () => {
    // The guard reads `teamCount < 2`, and two is the smallest number of teams that can
    // play each other. Moved by one it returns a season of empty weeks: nobody plays,
    // every record is 0-0, and the standings are decided entirely by the tiebreak key.
    const schedule = roundRobinSchedule(2, 3);
    expect(schedule).toEqual([
      [[0, 1]],
      [[0, 1]],
      [[0, 1]],
    ]);
  });

  it("returns empty weeks below two teams instead of pairing somebody with nobody", () => {
    for (const teamCount of [0, 1]) {
      expect(roundRobinSchedule(teamCount, 3)).toEqual([[], [], []]);
    }
  });

  it("builds exactly the number of weeks asked for", () => {
    // Nothing asserted the length, so the loop bound could produce a fifteenth week of a
    // fourteen-week season. The simulation reads `schedule[w]` for `w < weeks.length`, so
    // the extra week is invisible there — but `roundRobinSchedule` is exported and the
    // count is the one thing a caller passes in.
    expect(roundRobinSchedule(12, 14)).toHaveLength(14);
    expect(roundRobinSchedule(12, 1)).toHaveLength(1);
    expect(roundRobinSchedule(12, 0)).toHaveLength(0);
  });

  it("allows a one-team playoff field, and crowns that team", () => {
    // `playoffTeams < 1` rejects zero and below. One is coherent — the regular season
    // decides everything and the leader is champion with no games played — and moving the
    // guard by one turns a valid league into an error.
    const outcomes = simulateLeague(
      flat(8, (t) => 100 - t),
      { ...cfg, playoffTeams: 1 },
    );
    expect(outcomes[0].playoffProbability).toBe(1);
    expect(outcomes[0].championshipProbability).toBe(1);
    expect(outcomes.slice(1).every((o) => o.playoffProbability === 0)).toBe(true);
  });

  it("plays the final of a two-team bracket instead of handing it to the top seed", () => {
    // A field of exactly two is the one bracket size where "return the top seed" and "play
    // the round" agree on the number of survivors, so only the identity of the champion
    // separates them. Team 0 wins the regular season and is seed 1; team 1 wins the final.
    const scores = Array.from({ length: 8 }, (_, t) => [
      [...weeks.map(() => 100 - t), t === 1 ? 200 : 1],
    ]);
    const outcomes = simulateLeague(scores, {
      ...cfg,
      playoffTeams: 2,
      playoffWeeks: [15],
    });
    expect(outcomes[0].playoffProbability).toBe(1);
    expect(outcomes[1].playoffProbability).toBe(1);
    expect(outcomes[1].championshipProbability).toBe(1);
    expect(outcomes[0].championshipProbability).toBe(0);
  });

  it("counts the playoff weeks a score array has to cover", () => {
    // `weeksNeeded` is the regular season plus the bracket. Subtracting instead of adding
    // makes it twelve for a fourteen-week season, so a team carrying no playoff scores at
    // all passes the check and the bracket then reads `undefined` — which compares false
    // against everything, so the lower seed wins every playoff game it is in.
    const short = Array.from({ length: 8 }, () => [weeks.map(() => 10)]);
    expect(() => simulateLeague(short, cfg)).toThrow(/season needs 16/);

    const exact = flat(8, () => 10);
    expect(() => simulateLeague(exact, cfg)).not.toThrow();
  });

  it("refuses a fractional or zero scenario count", () => {
    // Both halves of `!isInteger(n) || n < 1` matter and neither was pinned. With `&&`, a
    // fractional count reaches the per-team check and fails there with a message about the
    // wrong thing; with the bound at zero, a count of zero runs no scenarios at all and
    // every rate comes back 0/0.
    const scores = flat(8, () => 10);
    expect(() => simulateLeague(scores, { ...cfg, scenarios: 2.5 })).toThrow(
      /division by zero/,
    );
    // Teams supplying zero scenarios each, so the per-team dimension check agrees and only
    // the scenario guard is left to catch it.
    const none = Array.from({ length: 8 }, () => []);
    expect(() => simulateLeague(none, { ...cfg, scenarios: 0 })).toThrow(
      /division by zero/,
    );
  });
});

describe("the tiebreak key is a fixed function, not just any function", () => {
  it("seeds a fully tied league the same way every run", () => {
    // `tieBreakKey` decides the whole table when nothing else can separate the teams, and
    // its three constants are the sort of thing that can be retyped without any test
    // noticing: the distribution stays uniform, so every statistical assertion above still
    // passes. What changes is *which* teams qualify — silently, between releases, for a
    // league whose scores are identical.
    //
    // These are golden values, measured from the current implementation. They are not
    // derived from anything and there is nothing to check them against; the point is that
    // they cannot change without this test saying so.
    const weeks = Array.from({ length: 14 }, (_, i) => i + 1);
    const tied = Array.from({ length: 8 }, () => [[...weeks, 15, 16].map(() => 0)]);
    const outcomes = simulateLeague(tied, {
      slots: SLOTS,
      weeks,
      playoffWeeks: [15, 16],
      playoffTeams: 4,
      scenarios: 1,
      meanAbsenceWeeks: 3,
    });

    expect(outcomes.map((o) => o.playoffProbability)).toEqual([0, 1, 1, 1, 1, 0, 0, 0]);
    expect(outcomes.map((o) => o.championshipProbability)).toEqual([
      0, 0, 0, 0, 1, 0, 0, 0,
    ]);
  });

  it("returns the same numbers it returned when these were written down", () => {
    // The seeding assertion above catches two of the three constants and both of the
    // shifts by one bit — but not the last shift, which changes only the low sixteen bits
    // of the key. Two teams' keys have to agree in their top sixteen bits before that can
    // reorder anything, which is about one pair in 65536; a fixture big enough to hit it
    // reliably would be a fixture nobody could read.
    //
    // So the values themselves are pinned. Measured from the implementation, not derived:
    // if a constant is retyped these change, and that is the whole point.
    expect([
      [0, 0],
      [0, 1],
      [0, 7],
      [1, 0],
      [5, 3],
      [399, 11],
    ].map(([s, t]) => tieBreakKey(s, t))).toEqual([
      3111652103, 1747885168, 2327151746, 247943768, 3965910931, 3655643294,
    ]);
  });

  it("stays inside the unsigned 32-bit range the sort assumes", () => {
    // The comparator subtracts two keys. A negative key would still sort, but the values
    // are documented as unsigned and the final `>>> 0` is what makes that true.
    for (let s = 0; s < 50; s += 1) {
      for (let t = 0; t < 12; t += 1) {
        const key = tieBreakKey(s, t);
        expect(Number.isInteger(key)).toBe(true);
        expect(key).toBeGreaterThanOrEqual(0);
        expect(key).toBeLessThanOrEqual(0xffffffff);
      }
    }
  });
});

/**
 * Identities the simulation cannot violate without being wrong.
 *
 * Every one of these is a conservation law over the whole league rather than a property of
 * any team, which is what makes them worth pinning: a bug in seeding, in the bracket, or in
 * how ties are awarded shows up here as a total that does not add up, whatever it does to the
 * individual numbers. They were never asserted, and each of the three has a plausible way to
 * break silently.
 */
describe("league-wide conservation", () => {
  const teamsOf = (count: number, config: LeagueConfig) =>
    Array.from({ length: count }, (_, t) =>
      sampleTeamWeeklyScores(
        Array.from({ length: 9 }, (_, i) =>
          player(`t${t}p${i}`, ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "TE"][i], 15 - i - t * 0.3),
        ),
        config,
        100 + t,
      ),
    );

  for (const count of [6, 8, 10, 12]) {
    it(`adds up across ${count} teams`, () => {
      const config: LeagueConfig = {
        slots: SLOTS,
        weeks: Array.from({ length: 14 }, (_, i) => i + 1),
        playoffWeeks: [15, 16, 17],
        playoffTeams: 4,
        scenarios: 200,
        meanAbsenceWeeks: 3,
      };
      const outcomes = simulateLeague(teamsOf(count, config), config);

      // Exactly one champion per scenario. Below one would mean a bracket that sometimes
      // crowns nobody — the failure `bracketRoundsRequired` guards — and above one is
      // impossible without double-counting a scenario.
      expect(
        outcomes.reduce((sum, o) => sum + o.championshipProbability, 0),
      ).toBeCloseTo(1, 10);

      // Exactly `playoffTeams` qualifiers per scenario. A seeding tiebreak that favoured a
      // position would move the individual probabilities and leave this untouched, which is
      // why it is the *count* that is asserted and not any team's share.
      expect(
        outcomes.reduce((sum, o) => sum + o.playoffProbability, 0),
      ).toBeCloseTo(config.playoffTeams, 10);

      // One win awarded per game, whether it is split or not. Ties used to go entirely to
      // the home side, which conserves this total exactly — so it does not catch that bug,
      // and it does catch the ones that award a win twice or not at all.
      expect(outcomes.reduce((sum, o) => sum + o.expectedWins, 0)).toBeCloseTo(
        config.weeks.length * Math.floor(count / 2),
        10,
      );
    });
  }

  it("still crowns exactly one champion when every team is identical", () => {
    // The degenerate case the tiebreak was wrong for: our team is always index 0, and
    // breaking ties by position gave it a championship probability of exactly 1.
    const config: LeagueConfig = {
      slots: SLOTS,
      weeks: Array.from({ length: 14 }, (_, i) => i + 1),
      playoffWeeks: [15, 16, 17],
      playoffTeams: 4,
      scenarios: 200,
      meanAbsenceWeeks: 3,
    };
    const one = sampleTeamWeeklyScores(
      [player("a", "QB", 15), player("b", "RB", 12), player("c", "WR", 11)],
      config,
      7,
    );
    const outcomes = simulateLeague([one, one, one, one, one, one], config);
    expect(outcomes.reduce((sum, o) => sum + o.championshipProbability, 0)).toBeCloseTo(1, 10);
    expect(outcomes[0].championshipProbability).toBeLessThan(0.9);
  });
});
