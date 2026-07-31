import { describe, expect, it } from "vitest";

import type { RosterSlot } from "./optimizer";
import { createRng } from "./rng";
import {
  type PlayerRisk,
  type UtilityConfig,
  fitLognormal,
  marginalUtility,
  rosterUtility,
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
    const first = rosterUtility(roster, SLOTS, CONFIG, createRng(7));
    const second = rosterUtility(roster, SLOTS, CONFIG, createRng(7));
    expect(first.expectedPoints).toBe(second.expectedPoints);
  });

  it("recovers the mean when nobody is ever unavailable", () => {
    // One receiver, one slot, no bye, always fit: the season is just 14 × his mean, and
    // the estimate should land within a few standard errors of it.
    const roster = [player("wr", "WR", 12)];
    const utility = rosterUtility(roster, SLOTS, CONFIG, createRng(1));
    const expected = 12 * WEEKS.length;
    expect(Math.abs(utility.expectedPoints - expected)).toBeLessThan(
      4 * utility.standardError + 1,
    );
  });

  it("charges for a bye week", () => {
    // A lone receiver with a bye forfeits that week entirely. Season-point sums cannot
    // express this; the weekly matching leaves the slot empty and scores zero.
    const withoutBye = rosterUtility([player("wr", "WR", 12)], SLOTS, CONFIG, createRng(3));
    const withBye = rosterUtility(
      [player("wr", "WR", 12, { byeWeek: 7 })],
      SLOTS,
      CONFIG,
      createRng(3),
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

    const coverGain = marginalUtility(shared, cover, SLOTS, CONFIG, 11, createRng);
    const clashGain = marginalUtility(shared, clash, SLOTS, CONFIG, 11, createRng);

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

    const behindDurable = marginalUtility(durable, backup, SLOTS, CONFIG, 5, createRng);
    const behindFragile = marginalUtility(fragile, backup, SLOTS, CONFIG, 5, createRng);

    expect(behindFragile).toBeGreaterThan(behindDurable);

    // The same player filling an empty slot is worth nearly his whole season.
    const emptySlot = [player("rb1", "RB", 14), player("wr1", "WR", 12)];
    const asStarter = marginalUtility(emptySlot, backup, SLOTS, CONFIG, 5, createRng);
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
    const utility = rosterUtility([player("wr", "WR", 12)], SLOTS, CONFIG, createRng(2));
    expect(utility.expectedEmptySlots).toBeCloseTo(2 * WEEKS.length, 0);
  });

  it("values a volatile player above his mean when there is depth behind him", () => {
    // Jensen's inequality, which the old objective was blind to by construction. With a
    // replacement available, a high-variance starter's bad weeks are truncated by the
    // bench while his good weeks are kept, so the pair is worth more than the sum of
    // their means suggests.
    const steady = player("s", "RB", 12, { p10: 0.8, p90: 1.2 });
    const volatile = player("v", "RB", 12, { p10: 0.2, p90: 2.2 });
    const bench = player("b", "RB", 11, { p10: 0.8, p90: 1.2 });

    const withSteady = rosterUtility([steady, bench], SLOTS, CONFIG, createRng(9));
    const withVolatile = rosterUtility([volatile, bench], SLOTS, CONFIG, createRng(9));
    expect(withVolatile.expectedPoints).toBeGreaterThan(withSteady.expectedPoints);
  });

  it("handles an empty roster without throwing", () => {
    const utility = rosterUtility([], SLOTS, CONFIG, createRng(1));
    expect(utility.expectedPoints).toBe(0);
    expect(utility.expectedEmptySlots).toBe(SLOTS.length * WEEKS.length);
  });
});

describe("marginalUtility", () => {
  it("uses common random numbers, so the difference is not swamped by noise", () => {
    // The point of shared scenarios: adding a clearly useful player must register as
    // positive every time, not just on average. Independent estimates would flip sign.
    const roster = [player("rb1", "RB", 14)];
    const addition = player("rb2", "RB", 13);
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(
        marginalUtility(roster, addition, SLOTS, CONFIG, seed, createRng),
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
    const early = marginalUtility(one, candidate, SLOTS, CONFIG, 4, createRng);
    const late = marginalUtility(many, candidate, SLOTS, CONFIG, 4, createRng);
    expect(early).toBeGreaterThan(late * 2);
  });
});
