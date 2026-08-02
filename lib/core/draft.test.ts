import { describe, expect, it } from "vitest";

import {
  type MarketPlayer,
  normalCdf,
  normalizeLeagueSetup,
  pickOwnership,
  seatForTeamIndex,
  snakePicks,
  survivalProbability,
} from "./draft";

/**
 * Draft market model and snake geometry.
 *
 * Two claims, which are the two this module still makes. That ADP is read as a mean with
 * dispersion rather than as a deadline — a player with ADP 40 and a spread of 12 is still
 * there at pick 45 about a third of the time. And that the snake arithmetic attributes
 * every pick in the draft to exactly one seat, which is the invariant whose absence once
 * handed a manager's whole draft to somebody else.
 *
 * The recommendation engine that used to live here moved to `draft-policy.ts` and the
 * value-over-next-available version was deleted; the claims about solving value and
 * following scarcity are tested there, not here.
 */

describe("normalCdf", () => {
  it("matches known values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021, 5);
  });

  it("is symmetric", () => {
    for (const x of [0.3, 1.1, 2.4]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 6);
    }
  });
});

/** `survivalProbability` reads only the market fields, so that is all a fixture needs. */
function market(adp: number | null, adpStdev: number | null): MarketPlayer {
  return { adp, adpStdev };
}

describe("survivalProbability", () => {
  it("is a coin flip at a player's own ADP", () => {
    // The common misreading is that ADP is a deadline. It is a mean: at his own ADP a
    // player is equally likely to have gone or not.
    expect(survivalProbability(market(40, 12), 40, 300)).toBeCloseTo(
      0.5,
      6,
    );
  });

  it("falls as the pick gets later", () => {
    const p = market(40, 12);
    const early = survivalProbability(p, 30, 300);
    const at = survivalProbability(p, 40, 300);
    const late = survivalProbability(p, 55, 300);
    expect(early).toBeGreaterThan(at);
    expect(at).toBeGreaterThan(late);
  });

  it("keeps a wide-spread player alive well past his ADP", () => {
    // The reason dispersion is modelled at all: a spread of 12 leaves a real chance five
    // picks later, and a draft strategy that assumed otherwise would reach too early.
    expect(survivalProbability(market(40, 12), 45, 300)).toBeGreaterThan(
      0.3,
    );
    expect(survivalProbability(market(40, 1), 45, 300)).toBeLessThan(0.01);
  });

  it("treats an unranked player as going after everyone ranked", () => {
    // Not as pick zero, which would make every unranked player look like the first
    // overall pick.
    const unranked = market(null, null);
    expect(survivalProbability(unranked, 100, 300)).toBeGreaterThan(0.99);
  });
});




describe("snakePicks", () => {
  it("reverses every other round", () => {
    // Slot 3 of 12, six rounds: 3, 22, 27, 46, 51, 70.
    expect(snakePicks(3, 12, 6)).toEqual([3, 22, 27, 46, 51, 70]);
  });

  it("gives the turn manager back-to-back picks", () => {
    const last = snakePicks(12, 12, 4);
    expect(last).toEqual([12, 13, 36, 37]);
  });

  it("covers every pick exactly once across all slots", () => {
    const teams = 10;
    const rounds = 5;
    const all = Array.from({ length: teams }, (_, i) => snakePicks(i + 1, teams, rounds))
      .flat()
      .sort((a, b) => a - b);
    expect(all).toEqual(Array.from({ length: teams * rounds }, (_, i) => i + 1));
  });
});

describe("pick ownership", () => {
  // Worth being precise about what these do and do not prove. The map that used to be
  // inlined in the page computed the same seat mapping, so most of the invariants below
  // held for it as well — they guard a future bad extraction rather than catching the bug
  // that shipped. Only the out-of-range slot test exercises the defect itself, which was
  // that `slot > teams` produced another seat's pick numbers and that seat then overwrote
  // the user's. The commit that added these overstated them; this note is the correction.

  /** Every league shape the interface can produce, plus a few beyond it. */
  const shapes: Array<[number, number]> = [];
  for (const teams of [4, 6, 8, 10, 11, 12, 14, 16]) {
    for (let slot = 1; slot <= teams; slot += 1) shapes.push([teams, slot]);
  }

  it("gives every pick in the draft exactly one owner, for every shape", () => {
    // The invariant that matters. Three separate defects hid behind an ownership map that
    // rendered fine and was silently wrong: one seat overwrote another's picks, some picks
    // ended up owned by nobody, and a player recorded against an unowned pick was never
    // marked as taken and kept being recommended after he was gone.
    const rounds = 15;
    for (const [teams, slot] of shapes) {
      const owners = pickOwnership(teams, slot, rounds);
      expect(owners.size).toBe(teams * rounds);
      for (let pick = 1; pick <= teams * rounds; pick += 1) {
        expect(owners.get(pick)).toBeDefined();
      }
    }
  });

  it("gives every team the same number of picks", () => {
    const rounds = 12;
    for (const [teams, slot] of shapes) {
      const counts = new Array<number>(teams).fill(0);
      for (const team of pickOwnership(teams, slot, rounds).values()) counts[team] += 1;
      for (const count of counts) expect(count).toBe(rounds);
    }
  });

  it("puts the user at index 0 owning exactly their own slot's picks", () => {
    for (const [teams, slot] of shapes) {
      const owners = pickOwnership(teams, slot, 10);
      const mine = [...owners.entries()]
        .filter(([, team]) => team === 0)
        .map(([pick]) => pick)
        .sort((a, b) => a - b);
      expect(mine).toEqual(snakePicks(slot, teams, 10).sort((a, b) => a - b));
    }
  });

  it("maps team indices onto distinct seats", () => {
    for (const [teams, slot] of shapes) {
      const seats = Array.from({ length: teams }, (_, i) => seatForTeamIndex(i, slot));
      expect(new Set(seats).size).toBe(teams);
      expect(seats.every((seat) => seat >= 1 && seat <= teams)).toBe(true);
      expect(seatForTeamIndex(0, slot)).toBe(slot);
    }
  });

  it("refuses a slot outside the league instead of producing another seat's picks", () => {
    // The failure this prevents was silent: a slot of 12 in a ten-team league returns the
    // pick set of seat 9, and every number in it looks perfectly ordinary.
    expect(() => snakePicks(12, 10, 15)).toThrow(/outside a 10-team league/);
    expect(() => snakePicks(0, 10, 15)).toThrow();
    expect(() => snakePicks(-1, 10, 15)).toThrow();
    expect(() => snakePicks(1.5, 10, 15)).toThrow();
    expect(() => pickOwnership(10, 12, 15)).toThrow();
    // A league with no teams skips the loop entirely, so `snakePicks` never runs and every
    // pick comes back owned by nobody. Rejected here rather than delegated.
    expect(() => pickOwnership(0, 1, 15)).toThrow();
    expect(() => pickOwnership(-4, 1, 15)).toThrow();
    expect(() => pickOwnership(10.5, 1, 15)).toThrow();
  });

  it("still reverses each round, and gives the turn manager back-to-back picks", () => {
    const owners = pickOwnership(12, 1, 4);
    // Seat 1 picks first in odd rounds and last in even ones.
    expect(owners.get(1)).toBe(0);
    expect(owners.get(24)).toBe(0);
    expect(owners.get(25)).toBe(0);
  });
});

describe("normalizeLeagueSetup", () => {
  it("rounds what a number input actually produces", () => {
    // The defect this exists for. `<input type="number">` yields "1.5" without complaint,
    // clamping alone leaves it inside 1..teams, and the whole-seat requirement then fails
    // where it is no longer recoverable — a render throw with no boundary above it, which
    // replaced the setup screen with a crash page.
    expect(normalizeLeagueSetup({ teams: 12, slot: 1.5, rounds: 15 }).slot).toBe(2);
    expect(normalizeLeagueSetup({ teams: 12, slot: 2.4, rounds: 15 }).slot).toBe(2);
    expect(normalizeLeagueSetup({ teams: 11.6, slot: 1, rounds: 15 }).teams).toBe(12);
    expect(normalizeLeagueSetup({ teams: 12, slot: 1, rounds: 14.7 }).rounds).toBe(15);
  });

  it("survives everything a text field can hand it", () => {
    for (const junk of ["", "abc", null, undefined, NaN, Infinity, -Infinity, {}, []]) {
      const setup = normalizeLeagueSetup({ teams: junk, slot: junk, rounds: junk });
      expect(Number.isInteger(setup.teams)).toBe(true);
      expect(Number.isInteger(setup.slot)).toBe(true);
      expect(Number.isInteger(setup.rounds)).toBe(true);
      expect(setup.slot).toBeGreaterThanOrEqual(1);
      expect(setup.slot).toBeLessThanOrEqual(setup.teams);
      expect(setup.rounds).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the slot inside the league when the league shrinks", () => {
    // Shrinking the league used to leave the slot pointing at a seat that no longer
    // existed, and the snake arithmetic then produced another seat's picks.
    expect(normalizeLeagueSetup({ teams: 10, slot: 12, rounds: 15 }).slot).toBe(10);
    expect(normalizeLeagueSetup({ teams: 4, slot: 99, rounds: 15 }).slot).toBe(4);
  });

  it("clamps below as well as above", () => {
    expect(normalizeLeagueSetup({ teams: 1, slot: 0, rounds: 0 })).toEqual({
      teams: 2,
      slot: 1,
      rounds: 1,
    });
    expect(normalizeLeagueSetup({ teams: -5, slot: -5, rounds: -5 }).teams).toBe(2);
  });

  it("always produces a setup the draft functions accept", () => {
    // The contract that matters: whatever goes in, what comes out can be drafted with.
    const inputs = [1.5, 0, -3, 99, NaN, "7", "abc", 12, 8.5];
    for (const teams of inputs) {
      for (const slot of inputs) {
        const setup = normalizeLeagueSetup({ teams, slot, rounds: 15 });
        expect(() => pickOwnership(setup.teams, setup.slot, setup.rounds)).not.toThrow();
        expect(() => snakePicks(setup.slot, setup.teams, setup.rounds)).not.toThrow();
      }
    }
  });

  it("honours explicit bounds", () => {
    const setup = normalizeLeagueSetup(
      { teams: 20, slot: 1, rounds: 100 },
      { maxTeams: 14, maxRounds: 20 },
    );
    expect(setup.teams).toBe(14);
    expect(setup.rounds).toBe(20);
  });
});
