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
 * asserts a behaviour that summing season points and discounting the bench by a constant
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
    const cover = player("rb3", "RB", 8, { byeWeek: 11 });
    const clash = player("rb4", "RB", 8, { byeWeek: 7 });

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
      // Each weekly figure is rounded to two decimals before it is returned, so a
      // difference of two of them can sit up to 0.01 away from the rounded difference.
      // The tolerance is that rounding and nothing more — a receiver drawing different
      // numbers in the two rosters misses by whole points, not by hundredths.
      expect(
        Math.abs(
          crowded.expectedByWeek[i] - backsOnly.expectedByWeek[i] - alone.expectedByWeek[i],
        ),
      ).toBeLessThanOrEqual(0.011);
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
 * two boundary branches without a single test objecting. A realised-rate test kills all of
 * them at once, because every one of those changes moves the rate away from its target.
 */
describe("simulateAvailability", () => {
  const SEASON = Array.from({ length: 17 }, (_, i) => i + 1);

  /** Fraction of weeks actually played, pooled over many independent seasons. */
  function realisedRate(availability: number, byeWeek: number | null = null): number {
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

  it("realises the availability it was given", () => {
    // Measured error across these is under 0.009; the tolerance is a safety margin, not a
    // shrug. Anything that breaks the solve for `q` misses by far more than this.
    for (const availability of [0.31, 0.5, 0.7, 0.85, 0.95]) {
      expect(realisedRate(availability)).toBeCloseTo(availability, 1);
      expect(Math.abs(realisedRate(availability) - availability)).toBeLessThan(0.03);
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
    const rate = realisedRate(0.8, 9);
    expect(rate).toBeLessThan(0.8);
    expect(rate).toBeCloseTo(0.8 * (16 / 17), 1);
  });
});
