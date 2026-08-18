import { describe, expect, it } from "vitest";

import type { RosterSlot } from "./optimizer";
import { createRng } from "./rng";
import {
  type PlayerRisk,
  type UtilityConfig,
  fitLognormal,
  marginalUtility,
  rosterUtility,
  simulateAvailability,
} from "./roster-utility";

/**
 * Roster utility.
 *
 * These tests exist to show the objective captures what the previous one could not. Each
 * asserts a behavior that summing season points and discounting the bench by a constant
 * gets provably wrong.
 */

const SLOTS: RosterSlot[] = [
  { id: "rb1", label: "RB", eligiblePositions: ["RB"] },
  { id: "rb2", label: "RB", eligiblePositions: ["RB"] },
  { id: "wr1", label: "WR", eligiblePositions: ["WR"] },
];

const WEEKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const CONFIG: UtilityConfig = {
  weeks: WEEKS,
  scenarios: 400,
  meanAbsenceWeeks: 3,
};

/**
 * A known bye outside every span these tests simulate.
 *
 * This is the "no bye in the simulated season" control. It used to be `null`, but null
 * now means *unknown* and is charged an assumed week — reading it as "plays every week"
 * was the #89.D subsidy — while a known bye in a week nobody simulates genuinely costs
 * nothing and consumes no randomness, exactly as null used to.
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

describe("the no-bye control", () => {
  it("lies outside every span this file simulates", () => {
    // Week 18 is a real NFL week that `PlayerRisk.byeWeek` legitimately carries, so the
    // control is only sound while no fixture here simulates it. The longest span in this
    // file is the seventeen-week SEASON of the availability tests; if a league ending in
    // week 18 ever appears in these tests, this is the assertion that says the default
    // bye silently moved in-season and every golden value below it moved too.
    expect(WEEKS).not.toContain(BYE_OUTSIDE_SEASON);
    expect(BYE_OUTSIDE_SEASON).toBeGreaterThan(17);
  });
});

describe("fitLognormal", () => {
  it("reproduces the quantiles it was fitted to", () => {
    const { mu, sigma } = fitLognormal(0.269, 1.901);
    // exp(mu ± z90·sigma) must return the inputs.
    expect(Math.exp(mu - 1.2815515655446004 * sigma)).toBeCloseTo(0.269, 6);
    expect(Math.exp(mu + 1.2815515655446004 * sigma)).toBeCloseTo(1.901, 6);
  });

  it("is degenerate but finite when the quantiles coincide", () => {
    const { sigma } = fitLognormal(1, 1);
    expect(Number.isFinite(sigma)).toBe(true);
    expect(sigma).toBeGreaterThanOrEqual(0);
  });
});

describe("rosterUtility", () => {
  it("is deterministic for a given seed", () => {
    const roster = [player("a", "RB", 15), player("b", "WR", 12)];
    const first = rosterUtility(roster, SLOTS, CONFIG, 7);
    const second = rosterUtility(roster, SLOTS, CONFIG, 7);
    expect(first.expectedPoints).toBe(second.expectedPoints);
  });

  it("recovers the mean when nobody is ever unavailable", () => {
    // One receiver, one slot, no bye, always fit: the season is just 14 × his mean, and
    // the estimate should land within a few standard errors of it.
    const roster = [player("wr", "WR", 12)];
    const utility = rosterUtility(roster, SLOTS, CONFIG, 1);
    const expected = 12 * WEEKS.length;
    expect(Math.abs(utility.expectedPoints - expected)).toBeLessThan(
      4 * utility.standardError + 1,
    );
  });

  it("charges for a bye week", () => {
    // A lone receiver with a bye forfeits that week entirely. Season-point sums cannot
    // express this; the weekly matching leaves the slot empty and scores zero.
    const withoutBye = rosterUtility([player("wr", "WR", 12)], SLOTS, CONFIG, 3);
    const withBye = rosterUtility(
      [player("wr", "WR", 12, { byeWeek: 7 })],
      SLOTS,
      CONFIG,
      3,
    );
    expect(withoutBye.expectedPoints - withBye.expectedPoints).toBeGreaterThan(8);
    // And the hole is visible in the week it happens, not smeared across the season.
    const byeIndex = WEEKS.indexOf(7);
    expect(withBye.expectedByWeek[byeIndex]).toBeLessThan(1);
  });

  it("prices a backup by the bye he covers, with no bench constant anywhere", () => {
    // Two backs sharing a bye leave a slot empty that week. A third back on a different
    // bye fills it. His worth is derived from that, not from a weight.
    const shared = [
      player("rb1", "RB", 14, { byeWeek: 7 }),
      player("rb2", "RB", 13, { byeWeek: 7 }),
    ];
    // The same id on purpose. `playerStream` keys each player's random stream on his id, so
    // two candidates named differently are two independent draws and the bye effect is
    // being measured against that noise rather than isolated from it. Sharing the id pairs
    // the draws and leaves `byeWeek` as the only difference — the rule the volatility test
    // above documents, applied here too.
    const cover = player("rb3", "RB", 8, { byeWeek: 11 });
    const clash = player("rb3", "RB", 8, { byeWeek: 7 });

    const coverGain = marginalUtility(shared, cover, SLOTS, CONFIG, 11);
    const clashGain = marginalUtility(shared, clash, SLOTS, CONFIG, 11);

    // Same projected points, different bye: the one who covers the hole is worth more.
    expect(coverGain).toBeGreaterThan(clashGain);
  });

  it("prices depth by injury risk, which a points sum cannot see", () => {
    // Both running back slots are already filled, so the third back is a genuine backup
    // rather than a starter — he only scores when someone ahead of him cannot. His worth
    // is therefore the chance of that happening times what he saves, and it should be far
    // higher behind a fragile starter than behind a durable one.
    const durable = [
      player("rb1", "RB", 14),
      player("rb2", "RB", 13),
      player("wr1", "WR", 12),
    ];
    const fragile = [
      player("rb1", "RB", 14, { availability: 0.6 }),
      player("rb2", "RB", 13),
      player("wr1", "WR", 12),
    ];
    const backup = player("rb3", "RB", 7);

    const behindDurable = marginalUtility(durable, backup, SLOTS, CONFIG, 5);
    const behindFragile = marginalUtility(fragile, backup, SLOTS, CONFIG, 5);

    expect(behindFragile).toBeGreaterThan(behindDurable);

    // The same player filling an empty slot is worth nearly his whole season.
    const emptySlot = [player("rb1", "RB", 14), player("wr1", "WR", 12)];
    const asStarter = marginalUtility(emptySlot, backup, SLOTS, CONFIG, 5);
    const rawSeason = 7 * WEEKS.length;
    expect(asStarter).toBeGreaterThan(0.9 * rawSeason);

    // And every one of those three answers is derived rather than assumed. A fixed bench
    // weight has to give one number for all three; the measured spread here runs from
    // roughly a third of his season to nearly all of it, so any single constant is wrong
    // by a factor of three in one direction or the other.
    expect(behindDurable).toBeLessThan(0.5 * asStarter);
    expect(behindDurable).toBeGreaterThan(0.2 * rawSeason);
  });

  it("reports empty starting slots rather than hiding them", () => {
    // One player, three slots: two are empty every week, and the number says so.
    const utility = rosterUtility([player("wr", "WR", 12)], SLOTS, CONFIG, 2);
    expect(utility.expectedEmptySlots).toBeCloseTo(2 * WEEKS.length, 0);
  });

  it("values a volatile player above his mean when there is depth behind him", () => {
    // Jensen's inequality, which the old objective was blind to by construction. With a
    // replacement available, a high-variance starter's bad weeks are truncated by the
    // bench while his good weeks are kept, so the pair is worth more than the sum of their
    // means suggests.
    //
    // The roster needs a real bench for that to bite: three backs for two slots, so the
    // worst of the three sits each week. An earlier version of this test used two backs
    // for two slots, where both always start and no truncation is possible — it passed
    // only on sampling noise, and stopped passing the moment common random numbers
    // started working.
    const filler = player("f", "RB", 12, { p10: 0.8, p90: 1.2 });
    const bench = player("b", "RB", 11, { p10: 0.85, p90: 1.15 });
    // `steady` and `volatile` share the id "t" deliberately. `playerStream` derives each
    // player's stream from his id, so they draw identical uniforms and the only difference
    // between the two rosters is the spread being tested. Renaming either one silently
    // unpairs them and the comparison becomes two independent samples.
    const steady = player("t", "RB", 12, { p10: 0.85, p90: 1.15 });
    const volatile = player("t", "RB", 12, { p10: 0.15, p90: 2.4 });

    const withSteady = rosterUtility([steady, filler, bench], SLOTS, CONFIG, 9);
    const withVolatile = rosterUtility([volatile, filler, bench], SLOTS, CONFIG, 9);
    expect(withVolatile.expectedPoints).toBeGreaterThan(withSteady.expectedPoints);
  });

  it("handles an empty roster without throwing", () => {
    const utility = rosterUtility([], SLOTS, CONFIG, 1);
    expect(utility.expectedPoints).toBe(0);
    expect(utility.expectedEmptySlots).toBe(SLOTS.length * WEEKS.length);
  });
});

describe("marginalUtility", () => {
  it("gives a worthless player a marginal value of exactly zero, at every seed", () => {
    // The sharpest test of whether common random numbers actually work. A player who
    // scores nothing changes nothing, so under properly paired sampling his marginal value
    // is zero exactly — not zero on average.
    //
    // It was not. Random draws were consumed from one stream shared across the roster, so
    // how much randomness a player consumed depended on how many players preceded him and
    // on whether they happened to be fit. Adding anyone shifted everyone else's numbers,
    // and this player measured anywhere from -8.4 to +12.7 depending only on the seed.
    const roster = [
      player("a", "RB", 14, { availability: 0.85 }),
      player("b", "RB", 13, { availability: 0.85 }),
      player("c", "WR", 12, { availability: 0.85 }),
    ];
    const worthless = player("z", "RB", 0.0001, { availability: 0.85 });
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(marginalUtility(roster, worthless, SLOTS, CONFIG, seed)).toBeCloseTo(0, 2);
    }
  });

  it("draws the same numbers for a player however he is reached", () => {
    // A player's season must not depend on who else is on the roster, which is the
    // property that makes two candidate rosters comparable.
    const shared = player("shared", "WR", 12, { availability: 0.8 });
    const alone = rosterUtility([shared], SLOTS, CONFIG, 5);
    const crowded = rosterUtility(
      [player("x", "RB", 20), player("y", "RB", 19), shared],
      SLOTS,
      CONFIG,
      5,
    );
    // The slots are rb1, rb2 and wr1, so the two backs fill the RB slots and the receiver
    // fills his own in both rosters. The crowded total therefore decomposes exactly into
    // the backs plus the same receiver — but only if the receiver drew identical numbers
    // in both, which is the property being tested.
    //
    // The previous version of this assertion computed
    // `crowded[i] - (crowded[i] - alone[i])`, which is `alone[i]` by construction, and
    // then checked that array against itself. It passed whether or not common random
    // numbers worked.
    const backsOnly = rosterUtility(
      [player("x", "RB", 20), player("y", "RB", 19)],
      SLOTS,
      CONFIG,
      5,
    );
    expect(alone.expectedPoints).toBeGreaterThan(0);
    for (let i = 0; i < alone.expectedByWeek.length; i += 1) {
      // Three separately rounded terms, each carrying up to 0.005, so the worst case is
      // 0.015 rather than 0.01. The tolerance is that bound and nothing more: a receiver
      // drawing different numbers in the two rosters misses by whole points, so 0.016
      // still fails loudly on a real regression while not failing on arithmetic.
      expect(
        Math.abs(
          crowded.expectedByWeek[i] - backsOnly.expectedByWeek[i] - alone.expectedByWeek[i],
        ),
      ).toBeLessThanOrEqual(0.016);
    }
  });

  it("uses common random numbers, so the difference is not swamped by noise", () => {
    // The point of shared scenarios: adding a clearly useful player must register as
    // positive every time, not just on average. Independent estimates would flip sign.
    const roster = [player("rb1", "RB", 14)];
    const addition = player("rb2", "RB", 13);
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(
        marginalUtility(roster, addition, SLOTS, CONFIG, seed),
      ).toBeGreaterThan(0);
    }
  });

  it("gives a fourth back at a three-slot roster far less than the second", () => {
    // Diminishing returns fall out of the matching rather than being imposed.
    const one = [player("rb1", "RB", 14)];
    const many = [
      player("rb1", "RB", 14),
      player("rb2", "RB", 13),
      player("rb3", "RB", 12),
    ];
    const candidate = player("x", "RB", 11);
    const early = marginalUtility(one, candidate, SLOTS, CONFIG, 4);
    const late = marginalUtility(many, candidate, SLOTS, CONFIG, 4);
    expect(early).toBeGreaterThan(late * 2);
  });
});

/**
 * The availability chain.
 *
 * `q` and `r` are solved so the chain's long-run fit rate equals the player's own
 * availability. That is the module's central claim about this function and nothing was
 * checking it — a mutation run flipped the clamp on `q`, both chain transitions, and the
 * two boundary branches without a single test objecting. A realized-rate test kills all of
 * them at once, because every one of those changes moves the rate away from its target.
 */
describe("simulateAvailability", () => {
  const SEASON = Array.from({ length: 17 }, (_, i) => i + 1);

  /** Fraction of weeks actually played, pooled over many independent seasons. */
  function realizedRate(
    availability: number,
    byeWeek: number | null = BYE_OUTSIDE_SEASON,
  ): number {
    let played = 0;
    let total = 0;
    for (let scenario = 0; scenario < 400; scenario += 1) {
      const weeks = simulateAvailability(
        player("p", "RB", 10, { availability, byeWeek }),
        SEASON,
        3,
        createRng(scenario + 1),
      );
      for (const ok of weeks) {
        total += 1;
        if (ok) played += 1;
      }
    }
    return played / total;
  }

  it("realizes the availability it was given", () => {
    // Measured error across these is under 0.009; the tolerance is a safety margin, not a
    // shrug. Anything that breaks the solve for `q` misses by far more than this.
    for (const availability of [0.31, 0.5, 0.7, 0.85, 0.95]) {
      expect(realizedRate(availability)).toBeCloseTo(availability, 1);
      expect(Math.abs(realizedRate(availability) - availability)).toBeLessThan(0.03);
    }
  });

  it("never plays a player who is never available", () => {
    const weeks = simulateAvailability(
      player("p", "RB", 10, { availability: 0 }),
      SEASON,
      3,
      createRng(1),
    );
    expect(weeks).toEqual(SEASON.map(() => false));
  });

  it("always plays an ironman, except on his bye", () => {
    const weeks = simulateAvailability(
      player("p", "RB", 10, { availability: 1, byeWeek: 6 }),
      SEASON,
      3,
      createRng(1),
    );
    expect(weeks.filter((ok) => !ok)).toHaveLength(1);
    expect(weeks[5]).toBe(false);
  });

  it("clamps an availability outside [0, 1] rather than trusting it", () => {
    // This is a public function and the entitlement of a caller to pass nonsense is not
    // hypothetical — `shrunkAvailability` is one arithmetic slip from producing it.
    expect(
      simulateAvailability(
        player("p", "RB", 10, { availability: 1.5 }),
        SEASON,
        3,
        createRng(1),
      ),
    ).toEqual(SEASON.map(() => true));
    expect(
      simulateAvailability(
        player("p", "RB", 10, { availability: -0.5 }),
        SEASON,
        3,
        createRng(1),
      ),
    ).toEqual(SEASON.map(() => false));
  });

  it("takes the bye out of the weeks a fragile player would otherwise have played", () => {
    // The bye is not part of the chain — it is subtracted from whatever the chain says.
    const rate = realizedRate(0.8, 9);
    expect(rate).toBeLessThan(0.8);
    expect(rate).toBeCloseTo(0.8 * (16 / 17), 1);
  });

  it("charges an unknown bye as exactly one assumed week", () => {
    // The #89.D subsidy, closed at the boundary: `byeWeek: null` used to mean "plays all
    // seventeen weeks", which paid a free week to exactly the players whose data was
    // worst. An ironman with an unknown bye now sits out one week per scenario — the
    // same cost as a known bye, without pretending to know the week.
    for (let scenario = 0; scenario < 50; scenario += 1) {
      const weeks = simulateAvailability(
        player("p", "RB", 10, { availability: 1, byeWeek: null }),
        SEASON,
        3,
        createRng(scenario + 1),
      );
      expect(weeks.filter((ok) => !ok)).toHaveLength(1);
    }
  });

  it("spreads the assumed week across scenarios instead of electing one", () => {
    // The whole point of a *probabilistic* absence: the week is unknown, so no single
    // week may be charged systematically — that would misprice bench cover against
    // players whose real bye is elsewhere. Over enough scenarios every week of the
    // season is the assumed one at least once.
    const missedWeek = (seed: number): number => {
      const weeks = simulateAvailability(
        player("p", "RB", 10, { availability: 1, byeWeek: null }),
        SEASON,
        3,
        createRng(seed),
      );
      return SEASON[weeks.indexOf(false)];
    };
    const counts = new Map<number, number>();
    for (let seed = 1; seed <= 400; seed += 1) {
      const week = missedWeek(seed);
      counts.set(week, (counts.get(week) ?? 0) + 1);
    }
    // Every week drawn, and none starved: uniform over 17 weeks puts ~23.5 draws on each,
    // and the measured minimum at these seeds is 17. A draw that merely *touched* every
    // week while concentrating on one would pass a support check and still charge one
    // week systematically — the floor is what rules that out.
    expect(counts.size).toBe(SEASON.length);
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(10);
  });

  it("draws the assumed week from the candidate list, falling back to the span only when empty", () => {
    // The candidate list is where a bye can legally fall (the season sim passes its
    // regular-season weeks so the bracket is never charged); an empty list falls back to
    // the whole span rather than yielding no bye — which would quietly resurrect the
    // subsidy for a degenerate caller.
    const ironman = player("p", "RB", 10, { availability: 1, byeWeek: null });
    for (let seed = 1; seed <= 30; seed += 1) {
      const constrained = simulateAvailability(ironman, [1, 2, 3], 3, createRng(seed), [2]);
      expect(constrained).toEqual([true, false, true]);
      const fallback = simulateAvailability(ironman, [1, 2, 3], 3, createRng(seed), []);
      expect(fallback.filter((ok) => !ok)).toHaveLength(1);
      // A list with no week in the span is the same degenerate case wearing numbers: an
      // assumed bye at week 99 masks nothing, so it must fall back too, not charge zero.
      const disjoint = simulateAvailability(ironman, [1, 2, 3], 3, createRng(seed), [99]);
      expect(disjoint.filter((ok) => !ok)).toHaveLength(1);
    }
  });

  it("charges the assumed week on top of the injury chain too", () => {
    // The fragile-player mirror of the known-bye subtraction above: an unknown bye costs
    // a fragile player the same expected week a known one does. The bounds are chosen to
    // discriminate: the target is 0.7529 (measured 0.7478 at these seeds), the unfixed
    // rate is 0.8 with an estimator error under 0.009, and a `toBeCloseTo(…, 1)` band of
    // ±0.05 would have accepted both.
    const rate = realizedRate(0.8, null);
    expect(rate).toBeLessThan(0.78);
    expect(rate).toBeGreaterThan(0.72);
  });
});

/**
 * The shape of an absence, not just how often one happens.
 *
 * `simulateAvailability` solves a two-state chain so that absences *cluster* — a player who
 * misses this week is likely to miss the next. That clustering is the entire reason it is a
 * chain rather than an independent coin flip per week, because a roster is hurt far more by
 * one four-week absence than by four scattered ones.
 *
 * The realized-rate test cannot see it. Setting `r` to zero makes the chain absorbing —
 * a player is fit all season or out all season — and the long-run rate still lands on
 * target, so every existing assertion passes while the variance of a season's score rises
 * by roughly half and the recommended pick changes.
 */
describe("simulateAvailability absence structure", () => {
  const SEASON = Array.from({ length: 17 }, (_, i) => i + 1);

  /** Absence spells and total missed weeks over many independent seasons. */
  function spells(availability: number, scenarios = 400) {
    let missed = 0;
    let runs = 0;
    let seasonsEntirelyMissed = 0;
    for (let scenario = 0; scenario < scenarios; scenario += 1) {
      const weeks = simulateAvailability(
        player("p", "RB", 10, { availability }),
        SEASON,
        3,
        createRng(scenario + 1),
      );
      let previousOut = false;
      let missedThisSeason = 0;
      for (const fit of weeks) {
        if (!fit) {
          missed += 1;
          missedThisSeason += 1;
          if (!previousOut) runs += 1;
        }
        previousOut = !fit;
      }
      if (missedThisSeason === weeks.length) seasonsEntirelyMissed += 1;
    }
    return { missed, runs, seasonsEntirelyMissed, scenarios };
  }

  it("produces absences of about the length it was asked for", () => {
    // `meanAbsenceWeeks` is 3 here, and a spell averages ~2.7 weeks. Absorbing the chain
    // sends this to 17 — the whole season — while leaving the rate untouched.
    const { missed, runs } = spells(0.85);
    expect(runs).toBeGreaterThan(0);
    const meanSpell = missed / runs;
    expect(meanSpell).toBeGreaterThan(1.5);
    expect(meanSpell).toBeLessThan(5);
  });

  it("almost never loses a player for a whole season at ordinary availability", () => {
    // Measured at 0.03% on the real chain and 14.6% with the chain absorbing. A tool that
    // wipes out one starter in seven whole seasons is not modeling injury, it is modeling
    // a coin flip on the draft itself.
    const { seasonsEntirelyMissed, scenarios } = spells(0.85);
    expect(seasonsEntirelyMissed / scenarios).toBeLessThan(0.02);
  });
});

/**
 * Reproducibility, pinned to actual numbers.
 *
 * Most of what survived a mutation run here lives in `playerStream`'s hash constants, and
 * it is tempting to call those equivalent: change one and the stream is different but just
 * as random, so no distributional assertion can tell. That reasoning is wrong. They are not
 * equivalent — they change every number the simulation produces — they are merely invisible
 * to any test that only checks a distribution.
 *
 * And determinism for a seed is load-bearing rather than incidental. Common random numbers
 * depend on it, so does the memo cache, so does the speculative cache, and so does every
 * figure in `docs/draft-validation.md`. An accidental change to the generator silently
 * moves all of them.
 *
 * So these are golden values, in the same spirit as `published-draft-metrics.json`: they
 * are what this code produces today. They are *meant* to fail if the generator changes.
 * When that happens deliberately, re-run and update them in the same commit — and expect
 * to re-run the backtest too, because the same change moves those figures.
 */
describe("the simulation is reproducible", () => {
  const roster = [
    player("rb1", "RB", 14),
    player("rb2", "RB", 13, { availability: 0.8, byeWeek: 7 }),
    player("wr1", "WR", 12),
  ];

  it("returns the same numbers for the same seed", () => {
    const utility = rosterUtility(roster, SLOTS, CONFIG, 5);
    expect(utility.expectedPoints).toBe(498.39);
    expect(utility.standardError).toBe(4.04);
    expect(utility.expectedEmptySlots).toBe(3.7);
    expect(utility.expectedByWeek.slice(0, 3)).toEqual([37.01, 36.15, 36.06]);
  });

  it("returns the same marginal value for the same seed", () => {
    expect(marginalUtility(roster, player("rb3", "RB", 7), SLOTS, CONFIG, 5)).toBe(48.48);
  });

  it("gives a different answer for a different seed, so the seed is real", () => {
    // Guards the pair above from passing because the seed is ignored entirely.
    expect(rosterUtility(roster, SLOTS, CONFIG, 6).expectedPoints).not.toBe(498.39);
  });
});

/**
 * The arithmetic of the accumulation, on a roster with nothing random in it.
 *
 * Every other test here runs hundreds of scenarios of a stochastic simulation and asserts
 * an inequality, which is the right shape for the questions they ask and a poor one for
 * arithmetic: a running total that starts at one instead of zero moves a 400-scenario mean
 * by 0.0025 and nothing notices. These fixtures remove the randomness — an ironman with no
 * bye and identical quantiles — so every number is exactly predictable.
 */
describe("the totals are accumulated from zero", () => {
  const CERTAIN: Partial<PlayerRisk> = {
    p10: 1,
    p90: 1,
    availability: 1,
    byeWeek: BYE_OUTSIDE_SEASON,
  };
  const flatConfig: UtilityConfig = { weeks: [1, 2, 3], scenarios: 4, meanAbsenceWeeks: 3 };

  it("totals exactly what a deterministic roster scores", () => {
    // p10 = p90 = 1 is as close to no spread as `fitLognormal` allows: it nudges the
    // ninetieth percentile up by a millionth so the fit stays well defined, leaving a
    // sigma of 3.9e-7. That is not zero, and the equality below does not rest on it being
    // zero — `solveLineup` quantizes each week's total to two decimals, which is 500 times
    // coarser than the largest deviation the nudge can produce. Measured over 10,000
    // weekly draws: not one differs from 24 at all.
    //
    // Two backs and a receiver fill all three slots: 10 + 8 + 6 a week, three weeks, 72
    // points, in every scenario.
    const roster = [
      player("rb1", "RB", 10, CERTAIN),
      player("rb2", "RB", 8, CERTAIN),
      player("wr1", "WR", 6, CERTAIN),
    ];
    const utility = rosterUtility(roster, SLOTS, flatConfig, 1);
    expect(utility.expectedPoints).toBe(72);
    expect(utility.rawExpectedPoints).toBeCloseTo(72, 10);
    expect(utility.expectedByWeek).toEqual([24, 24, 24]);
    expect(utility.expectedEmptySlots).toBe(0);
  });

  it("reports no standard error when there is nothing to be uncertain about", () => {
    // Every scenario returns the same total, so the variance is zero. It is computed as
    // `E[x²] − E[x]²` and floored at zero, which is there for floating-point noise — a
    // floor of one instead reports a standard error of half a point on a roster that
    // cannot vary.
    const roster = [
      player("rb1", "RB", 10, CERTAIN),
      player("rb2", "RB", 8, CERTAIN),
      player("wr1", "WR", 6, CERTAIN),
    ];
    expect(rosterUtility(roster, SLOTS, flatConfig, 1).standardError).toBe(0);
  });

  it("counts the slots a short roster leaves empty, and no more", () => {
    // One back for two back slots and no receiver: one empty slot a week from the second
    // back slot, one from the receiver slot, three weeks.
    const utility = rosterUtility(
      [player("rb1", "RB", 10, CERTAIN)],
      SLOTS,
      flatConfig,
      1,
    );
    expect(utility.expectedEmptySlots).toBe(6);
    expect(utility.expectedPoints).toBe(30);
  });

  it("reports zeros for an empty roster, not near-zeros", () => {
    const utility = rosterUtility([], SLOTS, flatConfig, 1);
    expect(utility.expectedPoints).toBe(0);
    expect(utility.rawExpectedPoints).toBe(0);
    expect(utility.standardError).toBe(0);
    expect(utility.expectedByWeek).toEqual([0, 0, 0]);
    expect(utility.expectedEmptySlots).toBe(SLOTS.length * flatConfig.weeks.length);
  });
});

describe("fitLognormal's floors", () => {
  it("survives a zero or negative tenth percentile", () => {
    // `Math.max(p10, 1e-6)`. A published p10 of zero is real — it is what a player who
    // sometimes scores nothing looks like — and `log(0)` is `-Infinity`, which propagates
    // through every weekly draw as `NaN` and silently zeroes a season.
    for (const p10 of [0, -1]) {
      const { mu, sigma } = fitLognormal(p10, 1.9);
      expect(Number.isFinite(mu)).toBe(true);
      expect(Number.isFinite(sigma)).toBe(true);
      expect(sigma).toBeGreaterThan(0);
    }
  });

  it("keeps the ninetieth percentile above the tenth", () => {
    // `Math.max(p90, low * 1.000001)`. Equal or inverted quantiles arrive from a source
    // that publishes a single value for a position; dividing rather than multiplying puts
    // `high` below `low`, and `log(high / low)` is then negative — a negative sigma, which
    // reflects every draw about the median instead of spreading it.
    for (const [p10, p90] of [
      [1, 1],
      [1.9, 0.269],
      [0.5, 0.5],
    ]) {
      const { sigma } = fitLognormal(p10, p90);
      expect(sigma).toBeGreaterThan(0);
      expect(Number.isFinite(sigma)).toBe(true);
    }
    // The nudge is deliberately tiny: equal quantiles mean no spread, and this must not
    // invent one. A hundredth of a point of sigma on a 15-point projection is noise.
    expect(fitLognormal(1, 1).sigma).toBeLessThan(1e-5);
  });
});

describe("the absence chain stays a probability", () => {
  it("still realizes the availability it was given when an absence is under a week", () => {
    // `r = 1 / max(meanAbsenceWeeks, 1)` is the chance of returning each week, so it has to
    // stay at or below one — `rng.next()` never reaches one, so any `r` above it means
    // "certain to return" and the chain no longer has the steady state `q` was solved for.
    //
    // The realized rate is what breaks, not the clustering, and only for short absences at
    // high availability: `q = r(1 - a)/a` cancels `r` out of `r / (q + r)` exactly, so the
    // rate self-corrects for any `r` the comparison can actually express. Measured over
    // 40 seasons of 200 weeks: 0.9005 with the floor, 0.6897 without it. A player asked to
    // play nine weeks in ten plays seven.
    const weeks = Array.from({ length: 200 }, (_, i) => i + 1);
    for (const [availability, meanAbsenceWeeks] of [
      [0.9, 0.25],
      [0.8, 0.5],
    ] as const) {
      let played = 0;
      for (let scenario = 0; scenario < 40; scenario += 1) {
        played += simulateAvailability(
          player("fragile", "RB", 10, { availability }),
          weeks,
          meanAbsenceWeeks,
          createRng(scenario),
        ).filter(Boolean).length;
      }
      expect(played / (40 * weeks.length)).toBeCloseTo(availability, 2);
    }
  });

  it("keeps a one-week mean absence to about one week", () => {
    // The other side of the same floor. Raising it to two leaves the realized rate alone —
    // `q` cancels `r` out of the steady state — and doubles how long each absence lasts,
    // which is the whole reason absences are modeled as a chain rather than a coin flip.
    const season = Array.from({ length: 17 }, (_, i) => i + 1);
    let missed = 0;
    let runs = 0;
    for (let scenario = 0; scenario < 400; scenario += 1) {
      let previousOut = false;
      for (const fit of simulateAvailability(
        player("p", "RB", 10, { availability: 0.85 }),
        season,
        1,
        createRng(scenario + 1),
      )) {
        if (!fit) {
          missed += 1;
          if (!previousOut) runs += 1;
        }
        previousOut = !fit;
      }
    }
    expect(runs).toBeGreaterThan(0);
    expect(missed / runs).toBeLessThan(1.5);
  });
});

describe("the simulation does not depend on how a roster was assembled", () => {
  it("returns the same numbers forwards, reversed and shuffled", () => {
    // `playerStream` keys each player's random stream on his id, so the order players sit
    // in an array cannot change what any of them draws. Two places said otherwise —
    // `canonicalizeState`'s docstring and `docs/draft-validation.md` — and both were
    // describing a version of this module that consumed one shared stream in roster order.
    //
    // Canonicalization is still needed, for the signature rather than for the result: two
    // ways of writing the same position have to produce one cache key. This test is what
    // keeps the corrected claim honest — if the streams ever stop being per-player, it
    // fails here rather than quietly making the documentation wrong again.
    // A bye they share and an availability under one, so weeks genuinely go unfilled —
    // an ironman roster with no byes matches trivially and would prove nothing.
    const risky = { byeWeek: 7, availability: 0.9 };
    const roster = [
      player("a", "RB", 18, risky),
      player("b", "RB", 14, risky),
      player("c", "WR", 12, risky),
      player("d", "WR", 9, risky),
    ];
    const config: UtilityConfig = { weeks: WEEKS, scenarios: 300, meanAbsenceWeeks: 3 };
    const forward = rosterUtility(roster, SLOTS, config, 5);
    const reversed = rosterUtility([...roster].reverse(), SLOTS, config, 5);
    const shuffled = rosterUtility(
      [roster[2], roster[0], roster[3], roster[1]],
      SLOTS,
      config,
      5,
    );

    for (const other of [reversed, shuffled]) {
      expect(other.rawExpectedPoints).toBe(forward.rawExpectedPoints);
      expect(other.expectedEmptySlots).toBe(forward.expectedEmptySlots);
      expect(other.expectedByWeek).toEqual(forward.expectedByWeek);
      expect(other.standardError).toBe(forward.standardError);
    }
    // The fixture is only meaningful if the roster is doing something: an empty or
    // fully-covered one would match trivially.
    expect(forward.expectedEmptySlots).toBeGreaterThan(0);
  });
});

describe("a scenario count that cannot be averaged over", () => {
  it("refuses zero, negative and fractional counts", () => {
    // Every figure this returns is a total divided by the scenario count, so a zero runs
    // the loop no times and comes back 0/0 — a table of `NaN` that renders as an empty cell
    // rather than as an error. `simulateLeague` already refused exactly this and is called
    // from the same places with the same config; this one did not.
    const roster = [player("rb1", "RB", 10)];
    for (const scenarios of [0, -1, 2.5, Number.NaN]) {
      expect(() =>
        rosterUtility(roster, SLOTS, { weeks: WEEKS, scenarios, meanAbsenceWeeks: 3 }, 1),
      ).toThrow(/division by zero/);
    }
  });

  it("refuses it for an empty roster too, rather than returning zeros", () => {
    // The empty-roster shortcut returns before the division, so it would have answered a
    // nonsense config with a confident table of zeros.
    expect(() =>
      rosterUtility([], SLOTS, { weeks: WEEKS, scenarios: 0, meanAbsenceWeeks: 3 }, 1),
    ).toThrow(/division by zero/);
  });

  it("accepts a single scenario, which is the smallest that can be averaged", () => {
    const utility = rosterUtility(
      [player("rb1", "RB", 10, { p10: 1, p90: 1, availability: 1 })],
      SLOTS,
      { weeks: [1, 2], scenarios: 1, meanAbsenceWeeks: 3 },
      1,
    );
    expect(utility.expectedPoints).toBe(20);
    expect(utility.standardError).toBe(0);
  });
});
