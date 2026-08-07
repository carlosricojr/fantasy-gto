import { describe, expect, it } from "vitest";

import { leagueUnfilledSlots, solveDemand } from "../../core/draft-replacement";
import { pickOwnership, snakePicks } from "../../core/draft";
import { slotsForTemplate } from "../roster";
import {
  DIRECT_ADP_LEAGUE_SIZES,
  SUPPORTED_LEAGUE_SIZES,
  adpSourceFor,
  adpSourceLabel,
  distinctAdpSources,
  scalePick,
} from "./league-size";

/**
 * Where a league's market prices come from.
 *
 * The failure being avoided is the quiet one: an eight-team board served to a nine-team
 * league unchanged, every survival probability shifted by an eighth, and nothing saying so.
 * So every test here is about the *provenance* travelling with the number.
 */

describe("the published sizes", () => {
  it("are the four the provider actually answers for", () => {
    // Measured by direct request on 2026 standard: 8, 10, 12 and 14 return 200 with 201
    // players; 6, 7, 9, 11, 13, 15 and 16 return HTTP 400 with `{"status":"Error"}`. A size
    // added here without a live check is a board that fails to build for a real league.
    expect([...DIRECT_ADP_LEAGUE_SIZES]).toEqual([8, 10, 12, 14]);
  });

  it("are a subset of the sizes the product offers", () => {
    for (const size of DIRECT_ADP_LEAGUE_SIZES) {
      expect([...SUPPORTED_LEAGUE_SIZES]).toContain(size);
    }
    expect([...SUPPORTED_LEAGUE_SIZES]).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });
});

describe("adpSourceFor", () => {
  it("uses a published board as measured", () => {
    for (const size of DIRECT_ADP_LEAGUE_SIZES) {
      const source = adpSourceFor(size);
      expect(source.kind).toBe("direct");
      expect(source.sourceTeams).toBe(size);
      expect(source.factor).toBe(1);
    }
  });

  it("derives every other size from the nearest published one", () => {
    const expected: ReadonlyArray<readonly [number, number]> = [
      [6, 8],
      [7, 8],
      [9, 8],
      [11, 10],
      [13, 12],
      [15, 14],
      [16, 14],
    ];
    for (const [teams, sourceTeams] of expected) {
      const source = adpSourceFor(teams);
      expect(source.kind).toBe("scaled");
      expect(source.sourceTeams).toBe(sourceTeams);
      expect(source.factor).toBeCloseTo(teams / sourceTeams, 12);
    }
  });

  it("breaks a tie toward the smaller board, in the safe direction", () => {
    // Nine is one from eight and one from ten; eleven from ten and twelve; thirteen from
    // twelve and fourteen. The smaller source's raw pick numbers are compressed relative to
    // the target league, so whatever the rescale leaves behind points toward players going
    // *earlier* than they will. Overstating scarcity costs a round; understating it costs
    // the player.
    expect(adpSourceFor(9).sourceTeams).toBe(8);
    expect(adpSourceFor(11).sourceTeams).toBe(10);
    expect(adpSourceFor(13).sourceTeams).toBe(12);
  });

  it("scales up for the sizes with no smaller board, and that is the unsafe direction", () => {
    // Six and seven have nothing below eight to fall back to. Recorded rather than hidden:
    // for these two the residual error points toward players lasting longer than they will.
    expect(adpSourceFor(6).sourceTeams).toBe(8);
    expect(adpSourceFor(7).sourceTeams).toBe(8);
    expect(adpSourceFor(6).factor).toBeLessThan(1);
    expect(adpSourceFor(16).factor).toBeGreaterThan(1);
  });

  it("refuses a size the product does not offer rather than picking the nearest", () => {
    for (const teams of [0, 1, 5, 17, 32, -4, 10.5, Number.NaN]) {
      expect(() => adpSourceFor(teams)).toThrow(/No draft board is built/);
    }
  });

  it("gives every supported size a source", () => {
    for (const size of SUPPORTED_LEAGUE_SIZES) {
      const source = adpSourceFor(size);
      expect([...DIRECT_ADP_LEAGUE_SIZES]).toContain(source.sourceTeams);
      expect(source.teams).toBe(size);
    }
  });
});

describe("scalePick", () => {
  it("leaves a published board's numbers alone", () => {
    expect(scalePick(40, adpSourceFor(10))).toBe(40);
    expect(scalePick(1.4, adpSourceFor(12))).toBe(1.4);
  });

  it("maps a pick to the same round in the target league", () => {
    // Overall pick 40 in a ten-team league is the end of round four. The same round in a
    // twelve-team league ends at pick 48.
    expect(scalePick(40, adpSourceFor(11))).toBe(44);
    // And pick 80 in an eight-team league — the end of round ten — is pick 90 of nine.
    expect(scalePick(80, adpSourceFor(9))).toBe(90);
    // Down as well as up: pick 80 of eight is pick 60 of six.
    expect(scalePick(80, adpSourceFor(6))).toBe(60);
  });

  it("leaves an absent pick absent", () => {
    // A player the market has no opinion about does not acquire one from being rescaled.
    expect(scalePick(null, adpSourceFor(9))).toBeNull();
    expect(scalePick(null, adpSourceFor(10))).toBeNull();
  });

  it("rounds to the precision the provider publishes at", () => {
    // A tenth of a pick. Carrying more would suggest the transform is more exact than the
    // two boards it maps between.
    expect(scalePick(1.4, adpSourceFor(9))).toBe(1.6);
    expect(String(scalePick(88.7, adpSourceFor(13)))).not.toMatch(/\.\d\d/);
  });

  it("is monotone, so it cannot reorder a board", () => {
    // The one property that must survive whatever the factor is. A rescale that swapped two
    // players would change the market's ranking, which is the half of the value this project
    // measured as *better* than its own model.
    const source = adpSourceFor(15);
    const picks = [1.4, 2.3, 12.5, 40, 88.7, 150.2, 201];
    const scaled = picks.map((p) => scalePick(p, source)!);
    for (let i = 1; i < scaled.length; i += 1) {
      expect(scaled[i]).toBeGreaterThan(scaled[i - 1]);
    }
  });
});

describe("distinctAdpSources", () => {
  it("collapses eleven sizes onto four requests", () => {
    // The whole refresh matrix is three scoring formats times eleven sizes. Fetching one
    // board per size would be thirty-three requests to somebody else's server for twelve
    // answers.
    expect(distinctAdpSources([...SUPPORTED_LEAGUE_SIZES])).toEqual([8, 10, 12, 14]);
  });

  it("asks only for what the given sizes need", () => {
    expect(distinctAdpSources([9, 10, 11])).toEqual([8, 10]);
    expect(distinctAdpSources([12])).toEqual([12]);
    expect(distinctAdpSources([])).toEqual([]);
  });

  it("does not depend on the order the sizes were listed in", () => {
    expect(distinctAdpSources([16, 6, 12, 9])).toEqual(distinctAdpSources([9, 12, 6, 16]));
  });
});

describe("adpSourceLabel", () => {
  it("says nothing approximate about a published board", () => {
    const text = adpSourceLabel(adpSourceFor(12));
    expect(text).toContain("as published");
    expect(text).not.toMatch(/approxim|derived|rescal/i);
  });

  it("names the source, the factor and the approximation for a derived one", () => {
    const text = adpSourceLabel(adpSourceFor(9));
    expect(text).toContain("9-team");
    expect(text).toContain("8-team");
    expect(text).toContain("1.125");
    expect(text).toContain("approximation");
  });
});

/**
 * The sizes themselves, through the parts of the product that are size-sensitive.
 *
 * Adding seven league sizes is only safe if the things that scale with league size actually
 * scale. Both of these did before — `pickOwnership` is arithmetic and `solveDemand` reads the
 * rosters — but neither had ever been exercised at six or sixteen, and "it is arithmetic" is
 * how an off-by-one at the ends survives.
 */
describe("every supported size, through pick ownership", () => {
  it("gives every pick in the draft exactly one owner", () => {
    // The invariant `pickOwnership` exists for. A slot outside the league silently produced
    // another seat's pick numbers once, and because the map is written index-0 first with
    // last-write-wins, that seat took every one of the user's picks.
    for (const teams of SUPPORTED_LEAGUE_SIZES) {
      for (const slot of [1, Math.ceil(teams / 2), teams]) {
        const owners = pickOwnership(teams, slot, 15);
        expect(owners.size).toBe(teams * 15);
        for (let pick = 1; pick <= teams * 15; pick += 1) {
          expect(owners.get(pick)).toBeGreaterThanOrEqual(0);
          expect(owners.get(pick)).toBeLessThan(teams);
        }
        // And the user, always index 0, holds exactly one pick per round at their own seat.
        expect(snakePicks(slot, teams, 15)).toHaveLength(15);
        expect(
          [...owners.entries()].filter(([, team]) => team === 0).map(([pick]) => pick).sort(
            (a, b) => a - b,
          ),
        ).toEqual(snakePicks(slot, teams, 15));
      }
    }
  });
});

describe("every supported size, through replacement demand", () => {
  const board = [
    ...Array.from({ length: 90 }, (_, i) => ({ position: "RB", value: 20 - i * 0.2 })),
    ...Array.from({ length: 90 }, (_, i) => ({ position: "WR", value: 19 - i * 0.18 })),
    ...Array.from({ length: 60 }, (_, i) => ({ position: "TE", value: 14 - i * 0.2 })),
    ...Array.from({ length: 50 }, (_, i) => ({ position: "QB", value: 20 - i * 0.25 })),
    ...Array.from({ length: 40 }, (_, i) => ({ position: "K", value: 8 - i * 0.04 })),
    ...Array.from({ length: 40 }, (_, i) => ({ position: "DST", value: 8.5 - i * 0.05 })),
  ];

  const demandFor = (teams: number) =>
    solveDemand(
      leagueUnfilledSlots(
        Array.from({ length: teams }, () => []),
        slotsForTemplate("standard"),
      ),
      board,
    );

  it("scales the league's demand with the league", () => {
    for (const teams of [6, 10, 12, 16]) {
      const demand = demandFor(teams);
      // One each per team at the positions with a dedicated slot and no flex eligibility.
      expect(demand.get("QB")).toBe(teams);
      expect(demand.get("K")).toBe(teams);
      expect(demand.get("DST")).toBe(teams);
      // Tight end is flex-eligible and loses every flex on this board — its curve falls away
      // below the backs and receivers — so it takes its dedicated slot and nothing more.
      expect(demand.get("TE")).toBe(teams);
      // Backs and receivers take their four dedicated slots per team plus every flex, split
      // between them by value rather than by an assumed share. The split is not a clean
      // multiple — at six teams it is RB 17 / WR 13 rather than 18 / 12, because the
      // eighteenth back is worth less than the thirteenth receiver — which is the whole
      // point of solving it. What is fixed is the total.
      expect((demand.get("RB") ?? 0) + (demand.get("WR") ?? 0)).toBe(teams * 5);
      // And every unfilled slot in the league is accounted for.
      expect([...demand.values()].reduce((a, b) => a + b, 0)).toBe(teams * 9);
    }
    expect(demandFor(6).get("RB")).toBe(17);
    expect(demandFor(6).get("WR")).toBe(13);
  });

  it("is strictly deeper in a bigger league at every position", () => {
    // The property that makes a size-sensitive board worth building at all: replacement in a
    // sixteen-team league is a materially worse player than in a six-team one.
    for (const position of ["QB", "RB", "WR", "TE", "K", "DST"]) {
      const small = demandFor(6).get(position) ?? 0;
      const large = demandFor(16).get(position) ?? 0;
      expect(large).toBeGreaterThan(small);
    }
  });
});
