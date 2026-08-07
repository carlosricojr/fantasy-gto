import { describe, expect, it } from "vitest";

import { fantasySeasonWeeks } from "@/lib/core/season-sim";
import { CHAMPIONSHIP_WEEKS, PLAYOFF_FIELDS } from "./persistence";
import { describeSeason, seasonSummary } from "./season-label";

/**
 * What the screen says the odds are for.
 *
 * These are user-visible numeric claims, which under the project's first rule may not be
 * stated unless the code produced them. The string these replace was a literal — "a 14-week
 * regular season and a three-week bracket" — and it went on saying that for every league
 * after the season became a setting. The point of these tests is not the wording; it is
 * that every league the controls can produce is described by the season it was simulated
 * over, and that no combination produces a sentence describing a different one.
 */

describe("seasonSummary", () => {
  it("expands the pair of controls a reader would otherwise expand by hand", () => {
    expect(seasonSummary(fantasySeasonWeeks(17, 6))).toBe("Weeks 1–14 · playoffs 15–17");
    expect(seasonSummary(fantasySeasonWeeks(16, 6))).toBe("Weeks 1–13 · playoffs 14–16");
    // The four-team field the old literals mis-described: two rounds, not three, so the
    // regular season runs a week longer rather than a week vanishing.
    expect(seasonSummary(fantasySeasonWeeks(17, 4))).toBe("Weeks 1–15 · playoffs 16–17");
  });

  it("names a single week as a week rather than as a range", () => {
    expect(seasonSummary(fantasySeasonWeeks(17, 2))).toBe("Weeks 1–16 · playoffs 17");
  });

  it("says so when there is no bracket at all", () => {
    expect(seasonSummary(fantasySeasonWeeks(17, 1))).toBe("Weeks 1–17 · no playoffs");
  });
});

describe("describeSeason", () => {
  it("reads as a sentence about the season that was simulated", () => {
    expect(describeSeason(fantasySeasonWeeks(17, 6))).toBe(
      "a 14-week regular season and a 3-week bracket ending in week 17",
    );
    expect(describeSeason(fantasySeasonWeeks(15, 4))).toBe(
      "a 13-week regular season and a 2-week bracket ending in week 15",
    );
  });

  it("does not promise a bracket that is not played", () => {
    expect(describeSeason(fantasySeasonWeeks(17, 1))).toBe(
      "a 17-week regular season and no playoffs",
    );
  });
});

describe("every league the controls offer is described, and described distinctly", () => {
  it("covers the whole product of the two offer lists", () => {
    // The property that matters more than any single string: a reader can tell which of
    // the six seasons they are looking at from the sentence alone. Two shapes sharing a
    // description would be a screen that cannot say which one the odds are for.
    const described = new Set<string>();
    for (const championshipWeek of CHAMPIONSHIP_WEEKS) {
      for (const playoffTeams of PLAYOFF_FIELDS) {
        const season = fantasySeasonWeeks(championshipWeek, playoffTeams);
        // Every week of the season is accounted for by the sentence's own arithmetic.
        expect(season.weeks.length + season.playoffWeeks.length).toBe(championshipWeek);
        described.add(describeSeason(season));
        described.add(seasonSummary(season));
      }
    }
    expect(described.size).toBe(CHAMPIONSHIP_WEEKS.length * PLAYOFF_FIELDS.length * 2);
  });
});
