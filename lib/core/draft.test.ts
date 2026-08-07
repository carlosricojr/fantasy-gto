import { describe, expect, it } from "vitest";

import {
  DEFAULT_ADP_STDEV,
  MAX_DRAFT_ROUNDS,
  MAX_LEAGUE_TEAMS,
  MIN_ADP_STDEV,
  adpDispersion,
  type MarketPlayer,
  normalCdf,
  normalizeLeagueSetup,
  pickCoordinates,
  pickOwnership,
  seatForTeamIndex,
  snakePicks,
  survivalProbability,
  teamIndexForSeat,
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

  it("holds the error bound its docstring claims", () => {
    // Five fitted coefficients and a sixth in the `t` substitution, none of which any
    // assertion above could move: at five decimal places every one of them can be retyped
    // in its last two digits and nothing fails. The docstring claims a maximum error of
    // about 7.5e-8, so that is what is checked, against values from the standard tables.
    //
    // This matters because it is the survival curve. A tenth of a percent of drift on
    // "will he last until pick 45" is not visible on screen and is not correctable by
    // anyone using it.
    const known: Array<[number, number]> = [
      [-3, 0.0013498980316301],
      [-2, 0.0227501319481792],
      [-1.5, 0.0668072012688581],
      [-0.5, 0.3085375387259869],
      [0, 0.5],
      [0.25, 0.5987063256829237],
      [0.5, 0.6914624612740131],
      [1, 0.8413447460685429],
      [1.5, 0.9331927987311419],
      [1.96, 0.9750021048517795],
      [2, 0.9772498680518208],
      [3, 0.9986501019683699],
    ];
    for (const [x, expected] of known) {
      expect(Math.abs(normalCdf(x) - expected)).toBeLessThan(7.5e-8);
    }
  });

  it("stays a probability, and increases", () => {
    let previous = 0;
    for (let x = -6; x <= 6; x += 0.05) {
      const p = normalCdf(x);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
      expect(p).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = p;
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
    // The reason dispersion is modeled at all: a spread of 12 leaves a real chance five
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

  it("honors explicit bounds", () => {
    const setup = normalizeLeagueSetup(
      { teams: 20, slot: 1, rounds: 100 },
      { maxTeams: 14, maxRounds: 20 },
    );
    expect(setup.teams).toBe(14);
    expect(setup.rounds).toBe(20);
  });
});

/**
 * The coercion boundary, and the market's published assumption.
 *
 * `normalizeLeagueSetup` is the one place a string from a number input becomes a number,
 * and `DEFAULT_ADP_STDEV` is what the survival model assumes when the market publishes no
 * dispersion. Neither was pinned: the coercion could stop coercing and the assumption could
 * change value, both silently.
 */
describe("normalizeLeagueSetup coerces what the controls actually produce", () => {
  it("reads a numeric string, which is what a number input yields", () => {
    // The docstring is explicit that the controls feeding this produce "1.5", "" and
    // "abc". A guard that stops converting strings sends every one of them to the
    // fallback, so the setup screen silently ignores what was typed.
    expect(normalizeLeagueSetup({ teams: "12", slot: "3", rounds: "15" })).toEqual({
      teams: 12,
      slot: 3,
      rounds: 15,
    });
  });

  it("rounds a fraction rather than rejecting it", () => {
    expect(normalizeLeagueSetup({ teams: 12, slot: "1.5", rounds: 15 }).slot).toBe(2);
    expect(normalizeLeagueSetup({ teams: "11.4", slot: 1, rounds: 15 }).teams).toBe(11);
  });

  it("falls back only for what is genuinely unreadable", () => {
    const setup = normalizeLeagueSetup({ teams: "abc", slot: "", rounds: undefined });
    expect(setup.teams).toBe(2);
    expect(setup.slot).toBe(1);
    expect(setup.rounds).toBe(1);
  });
});

describe("the market's dispersion assumption", () => {
  it("is the value the survival model documents", () => {
    // Nothing pinned this. It is read where the market publishes no spread, so changing it
    // moves every survival probability for every unranked player on the board.
    expect(DEFAULT_ADP_STDEV).toBe(12);
    // A player at his own ADP is a coin flip, whatever the spread.
    expect(survivalProbability({ adp: 40, adpStdev: null }, 40, 300)).toBeCloseTo(0.5, 6);
    // One standard deviation past it is the normal tail.
    expect(survivalProbability({ adp: 40, adpStdev: null }, 52, 300)).toBeCloseTo(
      0.158655,
      5,
    );
  });

  it("treats a published zero spread as no spread at all", () => {
    // This test used to assert the opposite, on the reading that a stored zero is real
    // data meaning the market is certain. It is not. `parseAdp` writes zero when the
    // source omits the field, and says so where it does it: "deliberately not defaulted
    // here: the survival model owns that choice, and burying it in the parser would hide
    // which players had no dispersion published". The survival model then tested for
    // `null` and never saw one, because the ingest writes the parsed zero straight
    // through — so the choice the parser delegated was never made.
    //
    // Backwards in the worst direction: the player the market has said least about became
    // the one it was most certain of. Floored to half a pick, his survival curve is a step
    // function — gone one pick after his ADP, certain one pick before — and the board
    // reported that as fact.
    expect(survivalProbability({ adp: 40, adpStdev: 0 }, 41, 300)).toBeCloseTo(
      survivalProbability({ adp: 40, adpStdev: null }, 41, 300),
      12,
    );
    expect(survivalProbability({ adp: 40, adpStdev: 0 }, 41, 300)).toBeGreaterThan(0.4);
    // A negative spread is not data either, and arithmetic on it produces a survival
    // probability that runs the wrong way.
    expect(survivalProbability({ adp: 40, adpStdev: -3 }, 41, 300)).toBeGreaterThan(0.4);
  });

  it("still believes a market that is genuinely confident", () => {
    // The other side of it. A published spread of 0.8 is real data and stays 0.8 — the
    // default is for absence, not for tight markets. Floored at half a pick, because a
    // market is never a certainty and dividing by something smaller makes it one.
    expect(adpDispersion(0.8)).toBe(0.8);
    expect(adpDispersion(0.1)).toBe(MIN_ADP_STDEV);
    expect(adpDispersion(null)).toBe(DEFAULT_ADP_STDEV);
    expect(adpDispersion(undefined)).toBe(DEFAULT_ADP_STDEV);
    expect(adpDispersion(0)).toBe(DEFAULT_ADP_STDEV);
    expect(adpDispersion(-1)).toBe(DEFAULT_ADP_STDEV);
    // Half a pick either side of an ADP is still not a step function.
    const tight = survivalProbability({ adp: 40, adpStdev: 0.1 }, 41, 300);
    expect(tight).toBeGreaterThan(0.005);
    expect(tight).toBeLessThan(0.05);
  });
});

describe("the league-shape guards, at their boundaries", () => {
  it("accepts the smallest coherent league and the shortest draft", () => {
    // `teams < 1` and `rounds < 0`. Both sit one away from rejecting something valid: a
    // one-team draft is degenerate but coherent, and a zero-round draft is the state a
    // setup screen is in before anyone has said how long it runs.
    expect(snakePicks(1, 1, 3)).toEqual([1, 2, 3]);
    expect(snakePicks(1, 4, 0)).toEqual([]);
    expect(pickOwnership(1, 1, 2).size).toBe(2);
  });

  it("refuses a league with no teams, and a draft with negative rounds", () => {
    expect(() => snakePicks(1, 0, 3)).toThrow(/cannot have 0 teams/);
    expect(() => snakePicks(1, 4, -1)).toThrow(/cannot have -1 rounds/);
    expect(() => pickOwnership(0, 1, 2)).toThrow(/cannot have 0 teams/);
  });

  it("refuses a fractional league or a fractional draft length", () => {
    // `!isInteger(x) || x < 1` — both halves. With `&&`, a fractional count passes the
    // guard and produces fractional overall pick numbers, which `pickOwnership` then keys
    // a Map on, so they never match the integer pick counter the board increments and
    // every pick ends up owned by nobody.
    expect(() => snakePicks(1, 10.5, 3)).toThrow(/cannot have 10.5 teams/);
    expect(() => snakePicks(1, 10, 3.5)).toThrow(/cannot have 3.5 rounds/);
    expect(() => snakePicks(1.5, 10, 3)).toThrow(/outside a 10-team league/);
    expect(() => pickOwnership(10.5, 1, 3)).toThrow(/cannot have 10.5 teams/);
  });

  it("walks exactly as many team indices as there are teams", () => {
    // `index < teams`. One further asks `seatForTeamIndex` for a seat outside the league,
    // which `snakePicks` refuses — so this fails loudly rather than quietly, but only if
    // something calls it.
    for (const teams of [1, 2, 8, 12]) {
      const owners = pickOwnership(teams, 1, 3);
      expect(new Set(owners.values()).size).toBe(teams);
      expect(owners.size).toBe(teams * 3);
    }
  });
});

describe("normalizeLeagueSetup's bounds are the caller's, including zero", () => {
  it("honors a bound of zero rather than substituting its own", () => {
    // `bounds.minTeams ?? 2`. With `||`, a caller asking for a minimum of zero silently
    // gets two — and the three defaults differ, so the substituted value is not even
    // consistent between the fields.
    expect(normalizeLeagueSetup({ teams: 0 }, { minTeams: 0 }).teams).toBe(0);
    expect(normalizeLeagueSetup({ teams: 99 }, { maxTeams: 0, minTeams: 0 }).teams).toBe(0);
    expect(normalizeLeagueSetup({ teams: 8, rounds: 99 }, { maxRounds: 0 }).rounds).toBe(0);
  });

  it("uses its own defaults when the caller names none", () => {
    // The three defaults, which nothing pinned. They are the bounds every draft setup gets
    // when the caller says nothing, so each is the difference between a league the rest of
    // the code accepts and one it does not.
    expect(normalizeLeagueSetup({ teams: 1 }).teams).toBe(2);
    expect(normalizeLeagueSetup({ teams: 999 }).teams).toBe(32);
    expect(normalizeLeagueSetup({ teams: 12, rounds: 999 }).rounds).toBe(40);
    expect(normalizeLeagueSetup({ teams: 12, rounds: 0 }).rounds).toBe(1);
    expect(normalizeLeagueSetup({ teams: 12, slot: 0 }).slot).toBe(1);
  });
});

describe("the ceiling on a league this builds pick numbers for", () => {
  it("refuses a draft large enough to be an allocation rather than a league", () => {
    // These numbers reach here from a parsed response body. One array entry per round and
    // one map entry per pick means an unbounded pair is a memory request, not a draft.
    expect(() => snakePicks(1, 1e9, 1e9)).toThrow(/past what this builds/);
    expect(() => snakePicks(1, MAX_LEAGUE_TEAMS + 1, 10)).toThrow(/past what this builds/);
    expect(() => snakePicks(1, 12, MAX_DRAFT_ROUNDS + 1)).toThrow(/past what this builds/);
    expect(() => pickOwnership(1e9, 1, 1e9)).toThrow(/past what this builds/);
  });

  it("still builds the largest league the setup screen allows", () => {
    // The bound is the one `normalizeLeagueSetup` already clamps to, so it refuses nothing
    // the product accepts. A ceiling below that would break real drafts silently.
    expect(snakePicks(1, MAX_LEAGUE_TEAMS, MAX_DRAFT_ROUNDS)).toHaveLength(MAX_DRAFT_ROUNDS);
    expect(pickOwnership(MAX_LEAGUE_TEAMS, 1, MAX_DRAFT_ROUNDS).size).toBe(
      MAX_LEAGUE_TEAMS * MAX_DRAFT_ROUNDS,
    );
    const setup = normalizeLeagueSetup({ teams: 999, slot: 1, rounds: 999 });
    expect(() => snakePicks(setup.slot, setup.teams, setup.rounds)).not.toThrow();
  });
});

describe("normalizeLeagueSetup always returns a setup the draft accepts", () => {
  it("clamps the fallback, not just the parsed value", () => {
    // `clampWhole` returned `fallback` raw. With `minTeams: 0` the team count resolves to
    // zero and an unreadable slot fell back to 1 — a seat outside a zero-team league, which
    // `snakePicks` then rejects. The function's own docstring promises otherwise, and the
    // promise held only for input it could read.
    const setup = normalizeLeagueSetup(
      { teams: 0, slot: "not a number", rounds: "also not" },
      { minTeams: 0, maxTeams: 0, maxRounds: 0 },
    );
    expect(setup.teams).toBe(0);
    expect(setup.slot).toBe(0);
    expect(setup.rounds).toBe(0);
  });

  it("produces a draftable setup from unreadable input at the normal bounds", () => {
    for (const raw of [
      { teams: "abc", slot: "abc", rounds: "abc" },
      { teams: undefined, slot: null, rounds: Number.NaN },
      { teams: Number.POSITIVE_INFINITY, slot: -5, rounds: 1e9 },
    ]) {
      const setup = normalizeLeagueSetup(raw);
      expect(() => snakePicks(setup.slot, setup.teams, setup.rounds)).not.toThrow();
    }
  });
});

describe("the grid inverse", () => {
  it("round-trips every seat of every league size", () => {
    // The property, not an example. An off-by-one here draws a pick under the wrong
    // manager and nothing about the rendered board says so, and an example is exactly what
    // an off-by-one survives.
    for (let teams = 2; teams <= 20; teams += 1) {
      for (let slot = 1; slot <= teams; slot += 1) {
        for (let index = 0; index < teams; index += 1) {
          expect(teamIndexForSeat(seatForTeamIndex(index, slot), slot)).toBe(index);
        }
      }
    }
  });

  it("puts the manager being advised in their own seat and nobody else there", () => {
    const seats = Array.from({ length: 12 }, (_, seat) => teamIndexForSeat(seat + 1, 4));
    expect(seats.filter((index) => index === 0)).toHaveLength(1);
    expect(seats[3]).toBe(0);
    expect(new Set(seats).size).toBe(12);
  });
});

describe("pickCoordinates", () => {
  it("inverts snakePicks for every pick of a draft", () => {
    // The two pieces of snake arithmetic in this module have to agree exactly: one decides
    // who owns a pick, the other decides where it is drawn. Checked against each other
    // rather than against a table, so neither can be "fixed" alone.
    for (const teams of [8, 10, 12, 14]) {
      for (let slot = 1; slot <= teams; slot += 1) {
        const picks = snakePicks(slot, teams, 15);
        picks.forEach((pick, roundIndex) => {
          expect(pickCoordinates(pick, teams)).toEqual({ round: roundIndex + 1, seat: slot });
        });
      }
    }
  });

  it("covers every cell of the grid exactly once", () => {
    const teams = 10;
    const rounds = 15;
    const cells = new Set<string>();
    for (let pick = 1; pick <= teams * rounds; pick += 1) {
      const { round, seat } = pickCoordinates(pick, teams);
      expect(round).toBeGreaterThanOrEqual(1);
      expect(round).toBeLessThanOrEqual(rounds);
      expect(seat).toBeGreaterThanOrEqual(1);
      expect(seat).toBeLessThanOrEqual(teams);
      cells.add(`${round}.${seat}`);
    }
    expect(cells.size).toBe(teams * rounds);
  });

  it("refuses input that is not a pick in a league", () => {
    expect(() => pickCoordinates(0, 10)).toThrow();
    expect(() => pickCoordinates(1.5, 10)).toThrow();
    expect(() => pickCoordinates(1, 0)).toThrow();
  });
});
