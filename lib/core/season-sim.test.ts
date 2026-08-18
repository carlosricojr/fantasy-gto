import { describe, expect, it } from "vitest";

import type { RosterSlot } from "./optimizer";
import type { PlayerRisk } from "./roster-utility";
import {
  type LeagueConfig,
  bracketRoundsRequired,
  championshipProbability,
  fantasySeasonWeeks,
  roundRobinSchedule,
  sampleTeamWeeklyScores,
  simulateLeague,
  simulateLeagueScenarios,
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

/**
 * A known bye past every final these tests configure (the latest is week 17).
 *
 * This is the "no bye in the simulated season" control. It used to be `null`, but null
 * means *unknown* and `simulateAvailability` charges it as an assumed absent week — while
 * a known bye past the final provably costs nothing, which is exactly what the fixtures
 * here need from their default.
 */
const BYE_OUTSIDE_SEASON = 18;

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
    byeWeek: BYE_OUTSIDE_SEASON,
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

describe("the no-bye control", () => {
  it("lies outside every span this file simulates", () => {
    // The latest final any league here plays is week 17 (`fantasySeasonWeeks(17, …)`),
    // so a default bye of 18 provably never lands in-season. This is what keeps every
    // fixture built from `player()` bye-free in fact and not merely by intent.
    expect([...CONFIG.weeks, ...CONFIG.playoffWeeks]).not.toContain(BYE_OUTSIDE_SEASON);
    expect(BYE_OUTSIDE_SEASON).toBeGreaterThan(17);
  });
});

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

describe("fantasySeasonWeeks", () => {
  it("lays out the season every mainstream platform defaults to", () => {
    expect(fantasySeasonWeeks(17, 6)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      playoffWeeks: [15, 16, 17],
    });
  });

  it("moves the whole bracket when a league ends early", () => {
    // The setting this exists for. A six-team field ending in week 16 opens its bracket in
    // week 14 — an NFL week with byes in it — and one ending in week 15 opens in 13, which
    // puts its *semi*-final on week 14 instead. Both are weeks the old literals treated as
    // ordinary regular-season football.
    expect(fantasySeasonWeeks(16, 6)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      playoffWeeks: [14, 15, 16],
    });
    expect(fantasySeasonWeeks(15, 6)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      playoffWeeks: [13, 14, 15],
    });
  });

  it("gives a four-team field two rounds, not three", () => {
    // What the literals it replaces got wrong, and it is worth being exact about which week
    // moved. `playBracket` consumes the bracket from the front and stops once one team is
    // left, so a four-team field over weeks 15-17 played rounds in 15 and 16 and never
    // reached 17. Two things were wrong at once: week 15 was spent as a playoff round when
    // it should have been the last week of the regular season, and week 17 — the week the
    // league had named as its final — was not played at all.
    expect(fantasySeasonWeeks(17, 4)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      playoffWeeks: [16, 17],
    });
    expect(fantasySeasonWeeks(16, 4)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      playoffWeeks: [15, 16],
    });
  });

  it("covers every week up to the final exactly once", () => {
    // The property the simulation depends on and no individual expectation above states:
    // `sampleTeamWeeklyScores` concatenates the two lists and the bracket indexes into the
    // result by position, so a gap or an overlap would silently score the wrong week.
    for (const championshipWeek of [15, 16, 17]) {
      for (const playoffTeams of [1, 2, 4, 6, 8]) {
        const { weeks, playoffWeeks } = fantasySeasonWeeks(championshipWeek, playoffTeams);
        expect([...weeks, ...playoffWeeks]).toEqual(
          Array.from({ length: championshipWeek }, (_, i) => i + 1),
        );
        // And enough rounds to actually crown someone, which `simulateLeague` refuses
        // without.
        expect(playoffWeeks.length).toBe(bracketRoundsRequired(playoffTeams));
        expect(weeks.length).toBeGreaterThan(0);
      }
    }
  });

  it("runs the whole season as a regular season when there is no bracket to play", () => {
    expect(fantasySeasonWeeks(17, 1)).toEqual({
      weeks: Array.from({ length: 17 }, (_, i) => i + 1),
      playoffWeeks: [],
    });
  });

  it("accepts the smallest season there is, and refuses the one below it", () => {
    // Where the boundary actually sits. One regular week and no bracket is coherent — the
    // guard rejects a *non-positive* final, not a short one — and asserting only the
    // rejection leaves the guard free to slide a week without any test objecting.
    expect(fantasySeasonWeeks(1, 1)).toEqual({ weeks: [1], playoffWeeks: [] });
    expect(() => fantasySeasonWeeks(0, 1)).toThrow(/whole, positive week/);
  });

  it("never asks for a negative number of rounds", () => {
    // A bracket cannot need fewer than no rounds. `Math.ceil(Math.log2(x))` goes negative
    // below a field of one half — not merely below one, which is worth stating precisely:
    // on `(0.5, 1)` it rounds up to `-0`, and `-0 >= 0` is true, so a value picked from
    // there would pass this test while killing nothing. The whole mutation value sits in
    // `0.25` and `0.5`, which is why they are here.
    //
    // What the guard buys is a total function, and nothing pinned it, because every
    // sensible field size is an integer and the callers all validate before reaching here.
    // A mutation run moving that guard produced -1 rounds and no test objected.
    for (const playoffTeams of [-4, -1, -0.5, 0, 0.25, 0.5, 1, 1.5, 2, 3, 12]) {
      expect(bracketRoundsRequired(playoffTeams)).toBeGreaterThanOrEqual(0);
    }
    expect(bracketRoundsRequired(0.5)).toBe(0);
    expect(bracketRoundsRequired(0)).toBe(0);
  });

  it("refuses a season it cannot lay out rather than returning a broken one", () => {
    expect(() => fantasySeasonWeeks(16.5, 6)).toThrow(/whole, positive week/);
    expect(() => fantasySeasonWeeks(0, 6)).toThrow(/whole, positive week/);
    expect(() => fantasySeasonWeeks(17, 0)).toThrow(/positive integer/);
    expect(() => fantasySeasonWeeks(17, 2.5)).toThrow(/positive integer/);
    // Three rounds ending in week 3 would leave no regular season at all, so every team
    // would enter the bracket on an identical record and the tiebreak hash alone would
    // decide the seeding.
    expect(() => fantasySeasonWeeks(3, 6)).toThrow(/still playing a regular season/);
  });
});

/**
 * The laws a season obeys, over every shape rather than the handful drawn out above.
 *
 * The examples above pin what specific leagues look like, which catches a wrong answer and
 * not a wrong *rule*. These assert the identities the rest of the module is entitled to
 * assume: that the two week lists partition the season exactly, that the bracket is as long
 * as the field requires and no longer, and that moving the final moves the whole bracket
 * rigidly rather than resizing it.
 *
 * The space is walked exhaustively rather than sampled. It is small — a few hundred pairs —
 * and an exhaustive walk cannot be lucky, which a seeded sample can.
 */
describe("a season is a partition of its weeks, whatever shape it is", () => {
  /** Every pair `fantasySeasonWeeks` accepts, well beyond the three the product offers. */
  const shapes: Array<{ championshipWeek: number; playoffTeams: number }> = [];
  // From week 1, not week 2. A season ending in week 1 is the smallest `fantasySeasonWeeks`
  // accepts — one regular week, no bracket — and the guard it sits against is `< 1` rather
  // than `<= 1`. Starting the walk at 2 left that boundary untested, which a mutation run
  // found by moving the guard a week and watching nothing fail.
  for (let championshipWeek = 1; championshipWeek <= 20; championshipWeek += 1) {
    for (let playoffTeams = 1; playoffTeams <= 12; playoffTeams += 1) {
      if (championshipWeek > bracketRoundsRequired(playoffTeams)) {
        shapes.push({ championshipWeek, playoffTeams });
      }
    }
  }

  it("walks a space worth calling a space", () => {
    // A guard on the loops above. If a bound is edited to something degenerate, every
    // property below passes vacuously and reads as coverage.
    expect(shapes.length).toBeGreaterThan(200);
  });

  it("covers weeks 1 to the final exactly once, in order, across both halves", () => {
    // The identity `sampleTeamWeeklyScores` and `playBracket` both depend on. The scores
    // array is `[...weeks, ...playoffWeeks]` and the bracket indexes into it by *position*
    // (`regularWeeks + round`), so a gap, an overlap, a repeat or a wrong order would score
    // some other week and never say so.
    for (const { championshipWeek, playoffTeams } of shapes) {
      const { weeks, playoffWeeks } = fantasySeasonWeeks(championshipWeek, playoffTeams);
      const played = [...weeks, ...playoffWeeks];
      expect(played).toEqual(Array.from({ length: championshipWeek }, (_, i) => i + 1));
      expect(new Set(played).size).toBe(played.length);
    }
  });

  it("plays a regular season, and ends on the championship week", () => {
    for (const { championshipWeek, playoffTeams } of shapes) {
      const { weeks, playoffWeeks } = fantasySeasonWeeks(championshipWeek, playoffTeams);
      // A season with no regular season seeds its bracket from nothing, so every team
      // enters on an identical record and the tiebreak hash alone decides the seeding.
      expect(weeks.length).toBeGreaterThan(0);
      // The final is played in the week the caller named — the one property the whole
      // parameterization is *for*. Without it "championship week" names nothing.
      const last = playoffWeeks.length === 0 ? weeks : playoffWeeks;
      expect(last[last.length - 1]).toBe(championshipWeek);
      // And the two halves meet with no seam.
      if (playoffWeeks.length > 0) {
        expect(playoffWeeks[0]).toBe(weeks[weeks.length - 1] + 1);
      }
    }
  });

  it("gives the bracket exactly the rounds the field needs", () => {
    // Both directions matter, and they fail differently. Too few and `simulateLeague`
    // refuses outright. Too many is the quiet one: the bracket is consumed from the front
    // and `playBracket` stops as soon as the field is down to one, so a four-team field over
    // weeks 15-17 decided its title in week 16 and never reached 17 — the week the league
    // had named as its final went unplayed, and week 15 was spent as a playoff round instead
    // of closing the regular season.
    for (const { championshipWeek, playoffTeams } of shapes) {
      const { playoffWeeks } = fantasySeasonWeeks(championshipWeek, playoffTeams);
      expect(playoffWeeks.length).toBe(bracketRoundsRequired(playoffTeams));
    }
  });

  it("moves the bracket rigidly when the final moves, without resizing it", () => {
    // The identity behind "end your league a week early". A later final must not buy a
    // longer bracket or a differently shaped one — it buys exactly one more regular-season
    // week, and every playoff round slides by exactly one.
    for (const { championshipWeek, playoffTeams } of shapes) {
      if (championshipWeek + 1 > 20) continue;
      const before = fantasySeasonWeeks(championshipWeek, playoffTeams);
      const after = fantasySeasonWeeks(championshipWeek + 1, playoffTeams);
      expect(after.playoffWeeks).toEqual(before.playoffWeeks.map((week) => week + 1));
      expect(after.weeks).toEqual([...before.weeks, before.weeks.length + 1]);
    }
  });

  it("trades a regular-season week for a playoff round when the field grows", () => {
    // The other knob, and the reason the two cannot be set independently. A bigger field
    // needing another round takes that week from the regular season; a bigger field that
    // fits in the same number of rounds changes nothing at all.
    for (const { championshipWeek, playoffTeams } of shapes) {
      const smaller = fantasySeasonWeeks(championshipWeek, playoffTeams);
      if (championshipWeek <= bracketRoundsRequired(playoffTeams + 1)) continue;
      const larger = fantasySeasonWeeks(championshipWeek, playoffTeams + 1);
      const extraRounds = larger.playoffWeeks.length - smaller.playoffWeeks.length;
      expect(extraRounds).toBeGreaterThanOrEqual(0);
      expect(smaller.weeks.length - larger.weeks.length).toBe(extraRounds);
    }
  });
});

/**
 * What has to add up, for every season the product can be configured into.
 *
 * A season that ends early is not a special case to the simulation — it is a different pair
 * of week lists — and that is precisely why it could go wrong quietly. These are the
 * conservation laws: the quantities that must total the same thing however the weeks are
 * split, so a shape that silently drops a week, plays a bracket round twice, or crowns
 * nobody shows up as arithmetic that does not balance rather than as odds that look
 * plausible.
 */
describe("team zero winning is not the same as nobody winning", () => {
  it("records index 0 as a champion rather than as the absent-champion sentinel", () => {
    // `championByScenario` uses `-1` for "no champion" and `0` is a real team — our own,
    // always, since `championshipProbability` passes us first. So the two have to stay
    // distinguishable through a falsy value, and `??` rather than `||` is what does it:
    // `champion || -1` stores -1 whenever team 0 wins, and `championshipScenarios` reads
    // the result as `team === 0`, so every scenario we actually won would report as a loss.
    //
    // That mutant *is* killed — but by `draft-policy.test.ts`, two modules away, through
    // championship probabilities coming out wrong. Nothing here objected, which is a thin
    // place to leave a hazard whose whole nature is that zero is falsy. This pins it where
    // the sentinel lives.
    const config: LeagueConfig = {
      slots: SLOTS,
      ...fantasySeasonWeeks(16, 4),
      playoffTeams: 4,
      scenarios: 40,
      meanAbsenceWeeks: 3,
    };
    // Team 0 is far the strongest, so it wins every scenario outright.
    const teams = Array.from({ length: 8 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`z${i}`, i === 0 ? 40 : 8), config, 4200 + i),
    );
    const { championByScenario, outcomes } = simulateLeagueScenarios(teams, config);

    expect(championByScenario).toHaveLength(config.scenarios);
    // That team 0 is *recorded* when it wins, which is the whole point — not that it wins
    // every time. It does not: at these quantiles a single-elimination round is losable
    // even at five times the mean, and one scenario in forty goes the other way. Asserting
    // a clean sweep would have been a test about the lognormal tail rather than about the
    // sentinel, and would fail the day either changed.
    expect(championByScenario).toContain(0);
    expect(championByScenario).not.toContain(-1);
    // Stated separately, because `toContain(0)` would also pass on `-0`: it compares equal
    // to 0 and would hide the very confusion this test is about. `Object.is` tells them
    // apart.
    expect(championByScenario.some((team) => Object.is(team, -0))).toBe(false);
    // And every entry is a real team, so nothing else is standing in for a champion.
    for (const team of championByScenario) {
      expect(Number.isInteger(team)).toBe(true);
      expect(team).toBeGreaterThanOrEqual(0);
      expect(team).toBeLessThan(teams.length);
    }
    expect(outcomes[0].championshipProbability).toBeGreaterThan(0.9);
  });
});

describe("every league the product can express simulates coherently", () => {
  const TEAMS = 12;
  const SCENARIOS = 200;

  /** The championship weeks the interface offers, against both playoff fields. */
  const shapes = [15, 16, 17].flatMap((championshipWeek) =>
    [4, 6].map((playoffTeams) => ({ championshipWeek, playoffTeams })),
  );

  /**
   * Sampled and simulated once per shape, then shared.
   *
   * Every property below reads the same twelve rosters played out over the same season, so
   * recomputing them per assertion would be the same Monte Carlo run four times over — and
   * this suite already sits close enough to its timeout that the config file explains why
   * the timeout was raised. Memoized lazily rather than built in the describe body, because
   * work done during collection runs outside the per-test timeout that is supposed to bound
   * it.
   */
  const cache = new Map<
    string,
    { config: LeagueConfig; teams: number[][][]; outcomes: ReturnType<typeof simulateLeague> }
  >();

  function leagueOf(championshipWeek: number, playoffTeams: number) {
    const key = `${championshipWeek}/${playoffTeams}`;
    const held = cache.get(key);
    if (held !== undefined) return held;
    const config: LeagueConfig = {
      slots: SLOTS,
      ...fantasySeasonWeeks(championshipWeek, playoffTeams),
      playoffTeams,
      scenarios: SCENARIOS,
      meanAbsenceWeeks: 3,
    };
    const teams = Array.from({ length: TEAMS }, (_, i) =>
      sampleTeamWeeklyScores(roster(`t${i}`, 12 + i * 0.3), config, 900 + i),
    );
    const built = { config, teams, outcomes: simulateLeague(teams, config) };
    cache.set(key, built);
    return built;
  }

  it("samples exactly the weeks the season plays, for every shape", () => {
    // The length `simulateLeague` checks before it will run. A sampler and a simulation
    // that disagree by one week is the failure that guard exists for, and it can only be
    // introduced by a season shape neither of them was written against.
    for (const { championshipWeek, playoffTeams } of shapes) {
      const { teams, outcomes } = leagueOf(championshipWeek, playoffTeams);
      for (const scenarios of teams) {
        expect(scenarios).toHaveLength(SCENARIOS);
        for (const weekly of scenarios) expect(weekly).toHaveLength(championshipWeek);
      }
      // And no shape is refused by the very function it was built for. Reaching this line
      // is the proof: `leagueOf` simulates while it builds, so a shape `simulateLeague`
      // rejects throws out of the helper rather than reaching any assertion. Re-running it
      // inside `expect(...).not.toThrow()` would only pay for the same Monte Carlo twice.
      expect(outcomes).toHaveLength(TEAMS);
    }
  });

  it("crowns exactly one champion and seats exactly the playoff field", () => {
    for (const { championshipWeek, playoffTeams } of shapes) {
      const { outcomes } = leagueOf(championshipWeek, playoffTeams);

      // Somebody wins every season. A bracket too short for its field returns the highest
      // remaining seed without playing the deciding game, and a bracket that cannot finish
      // returns nobody — both of which show up here as a total below one.
      const titles = outcomes.reduce((sum, o) => sum + o.championshipProbability, 0);
      expect(titles).toBeCloseTo(1, 10);

      // And exactly `playoffTeams` teams qualify in every scenario, so the berths average
      // to the field size however the weeks are divided.
      const berths = outcomes.reduce((sum, o) => sum + o.playoffProbability, 0);
      expect(berths).toBeCloseTo(playoffTeams, 10);
    }
  });

  it("never gives a team a title it could not have qualified for", () => {
    // An ordering that is true by the rules of the game rather than by measurement: the
    // champion comes out of the qualifiers, so no team's title rate can exceed its berth
    // rate. Seeding read from the wrong weeks would break this without breaking anything
    // that merely sums to one.
    for (const { championshipWeek, playoffTeams } of shapes) {
      for (const outcome of leagueOf(championshipWeek, playoffTeams).outcomes) {
        expect(outcome.championshipProbability).toBeGreaterThanOrEqual(0);
        expect(outcome.championshipProbability).toBeLessThanOrEqual(
          outcome.playoffProbability,
        );
        expect(outcome.playoffProbability).toBeLessThanOrEqual(1);
      }
    }
  });

  it("awards exactly one win per game played, across the regular season it actually plays", () => {
    // The identity that catches a miscounted regular season in either direction. Every
    // matchup distributes exactly one win — a tie splits it in half rather than creating or
    // destroying one — so the league's total is the number of games its own schedule holds.
    // A season that lost a week to the bracket, or played one twice, lands here.
    for (const { championshipWeek, playoffTeams } of shapes) {
      const { config, outcomes } = leagueOf(championshipWeek, playoffTeams);
      const games = roundRobinSchedule(TEAMS, config.weeks.length).reduce(
        (sum, week) => sum + week.length,
        0,
      );
      const wins = outcomes.reduce((sum, o) => sum + o.expectedWins, 0);
      expect(wins).toBeCloseTo(games, 10);
      // Stated separately so a change to `roundRobinSchedule` cannot make both sides move
      // together and keep the test green.
      expect(games).toBe((config.weeks.length * TEAMS) / 2);
    }
  });

  it("seats everyone when the field is the whole league", () => {
    // The boundary `simulateLeague` deliberately allows: `playoffTeams > teamCount` throws
    // and `playoffTeams === teamCount` does not, which the source says the first-round-bye
    // test relies on. That test ("gives the top seeds a first-round bye…") already exercises
    // the equal case with a six-team field in a six-team league, so this is a second reading
    // of the same boundary — not the only one, which an earlier version of this comment
    // claimed. What it adds is the season shape: a twelve-team field needs four rounds, so
    // a final in week 15 puts the bracket in weeks 12-15, overlapping the range a
    // fourteen-week regular season used to own outright.
    //
    // Note what this does *not* pin, because the assertion looks like it does more than it
    // does. `playoffProbability` counts `seeded.slice(0, min(playoffTeams, teamCount))`,
    // which with a field the size of the league is every team in every scenario — so it is
    // blind to the bracket, the bye slice, the seeding and the scores. It says the boundary
    // is accepted and everyone qualifies, and nothing about how the bracket is then played.
    const config: LeagueConfig = {
      slots: SLOTS,
      ...fantasySeasonWeeks(15, TEAMS),
      playoffTeams: TEAMS,
      scenarios: SCENARIOS,
      meanAbsenceWeeks: 3,
    };
    const teams = Array.from({ length: TEAMS }, (_, i) =>
      sampleTeamWeeklyScores(roster(`all${i}`, 12), config, 700 + i),
    );
    for (const outcome of simulateLeague(teams, config)) {
      expect(outcome.playoffProbability).toBe(1);
    }
  });
});

/**
 * The weeks after the final are inert — exactly, not approximately.
 *
 * A fantasy season is a proper prefix of the NFL one: the final is played in week 15, 16 or
 * 17 and the rest is football nobody's league scores. So a bye that lands past the final has
 * to be worth *nothing*, and "nothing" here is provable rather than measurable — each
 * player's random stream is keyed on his own id and `simulateAvailability` consumes it
 * identically whichever *known* week his bye is, so an out-of-season bye cannot even perturb
 * the draw. (An `unknown` bye is the one exception, deliberately: null draws an assumed
 * week and costs it, which the last test here pins.) If the known-bye cases ever come
 * apart, a week nobody plays is being priced.
 */
describe("a bye after the final costs nothing at all", () => {
  const config: LeagueConfig = {
    slots: SLOTS,
    ...fantasySeasonWeeks(15, 6),
    playoffTeams: 6,
    scenarios: 300,
    meanAbsenceWeeks: 3,
  };

  const withBye = (byeWeek: number | null) => [
    player("star", "RB", 18, { byeWeek }),
    player("mid", "RB", 11),
    player("wr", "WR", 11),
  ];

  it("draws identical scores for a bye past the championship week", () => {
    // Week 16, 17 and 18 are real NFL weeks that this league does not play. Bit-identical,
    // asserted with `toEqual` on the whole sample rather than on a probability, because a
    // probability could agree by luck and a full scenario table cannot.
    // The baseline is itself a past-the-final bye, so the claim under test — inertness —
    // has to hold for it too; asserted the same way as for the weeks compared against it.
    expect(16).toBeGreaterThan(config.playoffWeeks[config.playoffWeeks.length - 1]);
    const baseline = sampleTeamWeeklyScores(withBye(16), config, 11);
    for (const byeWeek of [17, 18]) {
      expect(byeWeek).toBeGreaterThan(config.playoffWeeks[config.playoffWeeks.length - 1]);
      expect(sampleTeamWeeklyScores(withBye(byeWeek), config, 11)).toEqual(baseline);
    }
  });

  it("draws different scores for a bye the league does play", () => {
    // The complement, so the test above cannot pass by the bye being ignored everywhere.
    // Every week of this season, including the three bracket rounds, must register.
    const baseline = sampleTeamWeeklyScores(withBye(16), config, 11);
    for (const byeWeek of [...config.weeks, ...config.playoffWeeks]) {
      expect(sampleTeamWeeklyScores(withBye(byeWeek), config, 11)).not.toEqual(baseline);
    }
  });

  it("charges an unknown bye where a past-the-final one costs nothing", () => {
    // `null` is not a fourth inert week. The star's bye being *unknown* draws an assumed
    // absent week per scenario (see `simulateAvailability`), so the sample must move —
    // the frozen board carried 403 null byes and their old free-week reading is the
    // #89.D subsidy this pins shut.
    const baseline = sampleTeamWeeklyScores(withBye(16), config, 11);
    expect(sampleTeamWeeklyScores(withBye(null), config, 11)).not.toEqual(baseline);
  });

  it("never lands the assumed bye in a bracket round", () => {
    // A real bye cannot fall in the playoffs — the league schedules none there — so
    // `sampleTeamWeeklyScores` restricts the assumed-week draw to the regular season.
    // Pinned observationally because this is the property that once reverted without a
    // single test objecting: an ironman with no spread scores his mean in every week he
    // plays, so the one zero per scenario is the assumed bye, and its index must always
    // fall before the bracket starts.
    const ironman: PlayerRisk = {
      id: "iron",
      name: "iron",
      position: "RB",
      weeklyMean: 10,
      p10: 1,
      p90: 1,
      byeWeek: null,
      availability: 1,
    };
    const soloSlots: RosterSlot[] = [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }];
    const soloConfig: LeagueConfig = {
      slots: soloSlots,
      weeks: [1, 2, 3, 4, 5, 6, 7, 8],
      playoffWeeks: [9, 10],
      playoffTeams: 4,
      scenarios: 200,
      meanAbsenceWeeks: 3,
    };
    const scenarios = sampleTeamWeeklyScores([ironman], soloConfig, 7);
    for (const weekly of scenarios) {
      const zeroIndexes = weekly
        .map((points, index) => (points === 0 ? index : -1))
        .filter((index) => index !== -1);
      expect(zeroIndexes).toHaveLength(1);
      expect(zeroIndexes[0]).toBeLessThan(soloConfig.weeks.length);
    }
  });

  it("cannot make a roster score more in the standings by losing a week", () => {
    // Direction, which the inequality makes provable: the best legal lineup from a subset
    // of the players cannot beat the best from all of them, so a bye in a week that counts
    // towards this figure can only lower it.
    //
    // Which weeks count is the point. `TeamOutcome.expectedPoints` is the *seeding*
    // tiebreak, so it accumulates the regular season and not the bracket — a bye in a
    // playoff round leaves it untouched while changing who wins the title. Asserting all
    // three cases together is what stops that being read as the bye going unpriced.
    const opponents = Array.from({ length: 11 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`o${i}`, 12), config, 400 + i),
    );
    const points = (byeWeek: number | null) =>
      championshipProbability(
        sampleTeamWeeklyScores(withBye(byeWeek), config, 11),
        opponents,
        config,
      ).expectedPoints;

    const noBye = points(16);
    // A second week outside the season: identical, to the last bit.
    expect(points(17)).toBe(noBye);
    // A regular-season week: strictly fewer points in the standings.
    for (const byeWeek of config.weeks) expect(points(byeWeek)).toBeLessThan(noBye);
    // An unknown bye: also strictly fewer. Most scenarios place the assumed week in the
    // regular season, and no placement can add points.
    expect(points(null)).toBeLessThan(noBye);
    // A playoff round: the standings are already settled, so this figure does not move —
    // and the week is emphatically still played, which the sampled-score test above pins.
    for (const byeWeek of config.playoffWeeks) expect(points(byeWeek)).toBe(noBye);
  });
});

describe("when the final is played changes what a bye is worth", () => {
  // Why the season's weeks are configuration and not constants, as a measurement rather
  // than an argument. Everything is held fixed but the week the star is idle — and because
  // each player's random stream is keyed on his own id, the two runs draw *identical*
  // numbers and differ only in which week is masked out. The comparison is paired by
  // construction, so a gap this size is not sampling noise.
  function titleOdds(cfg: LeagueConfig, byeWeek: number | null): number {
    const mine = [
      player("me-rb1", "RB", 18, { byeWeek }),
      player("me-rb2", "RB", 11),
      player("me-wr1", "WR", 11),
    ];
    const opponents = Array.from({ length: 11 }, (_, i) =>
      sampleTeamWeeklyScores(roster(`opp${i}`, 12), cfg, 500 + i),
    );
    return championshipProbability(
      sampleTeamWeeklyScores(mine, cfg, 7),
      opponents,
      cfg,
    ).championshipProbability;
  }

  const league = (championshipWeek: number, playoffTeams: number): LeagueConfig => ({
    slots: SLOTS,
    ...fantasySeasonWeeks(championshipWeek, playoffTeams),
    playoffTeams,
    scenarios: 1500,
    meanAbsenceWeeks: 3,
  });

  it("roughly halves a title when the bye lands in a round you have to play", () => {
    // A four-team league whose final is in week 15 plays its semi-final in week 14 — a
    // real NFL bye week, in a round every qualifier plays. The identical roster in a
    // league ending in week 17 never meets that: its bracket starts after the last bye.
    //
    // So this is not a rounding difference between two configurations. It is the same
    // player being worth about half as much to one league as to the other, and no amount
    // of care about the projection can recover it, because the projection is the same.
    const cfg = league(15, 4);
    expect(cfg.playoffWeeks).toContain(14);
    const regularSeasonBye = titleOdds(cfg, 7);
    const playoffBye = titleOdds(cfg, 14);
    expect(playoffBye).toBeLessThan(regularSeasonBye * 0.7);
    // And an ordinary bye is a real but modest cost against no bye at all — a bye past
    // the final, now that null means "unknown" and is charged — which is what makes the
    // number above a statement about the *week* rather than about byes.
    const noBye = titleOdds(cfg, 16);
    expect(regularSeasonBye).toBeLessThan(noBye);
    expect(regularSeasonBye).toBeGreaterThan(noBye * 0.8);
  });

  it("costs less in a round the top seeds sit out", () => {
    // A six-team field gives seeds one and two a first-round bye, so week 14 of a league
    // ending in week 16 is only played by the teams that finished third to sixth. The cost
    // is therefore real but far smaller than a semi-final's: a top seed is guaranteed not
    // to play week 14, and no seed is guaranteed to skip a later round. That is a
    // distinction the simulation gets for free by playing the bracket, and one no per-week
    // weighting could express.
    //
    // "A round every qualifier plays" would be wrong here and is worth not writing: in a
    // six-team, three-round bracket no round is played by all six. It fits the four-team
    // case in the test above and was carried across to this one, which is exactly the kind
    // of nearly-right sentence a reader would take at face value.
    const cfg = league(16, 6);
    // Named rather than assumed, because which round each week *is* carries the whole
    // claim: 14 is the quarter-final, 15 the semi-final, 16 the final.
    expect(cfg.playoffWeeks).toEqual([14, 15, 16]);
    const firstRoundBye = titleOdds(cfg, 14);
    // Both must-play rounds, not just the final. The documented claim is about the
    // semi-final, so the semi-final is the one that has to be measured.
    expect(titleOdds(cfg, 15)).toBeLessThan(firstRoundBye * 0.7);
    expect(titleOdds(cfg, 16)).toBeLessThan(firstRoundBye * 0.7);
    expect(firstRoundBye).toBeGreaterThan(titleOdds(cfg, 7) * 0.8);
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
