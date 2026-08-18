import { describe, expect, it } from "vitest";

import type { Contest } from "../core/domain";
import { teamByeWeeks } from "./byes";

/**
 * The derivation is a complement — schedule weeks minus weeks played — so the tests build
 * schedules where the complement is known by construction and probe the two ways it can
 * go wrong: guessing when several weeks are missing, and reading another season's games
 * as this season's.
 */

function contest(season: number, week: number, home: string, away: string): Contest {
  return {
    id: `${season}_${String(week).padStart(2, "0")}_${away}_${home}`,
    period: { season, index: week },
    homeTeam: home,
    awayTeam: away,
    startsAt: null,
    result: null,
  };
}

/**
 * A season where PHI sits out `phiBye` and DAL sits out `dalBye`, filler opponents
 * covering the week the other is idle. The fillers (NYG, WAS) each appear in exactly one
 * week, so 16 of the span's weeks are missing for them — the ambiguous shape.
 */
function seasonSchedule(season: number, phiBye: number, dalBye: number): Contest[] {
  const contests: Contest[] = [];
  for (let week = 1; week <= 18; week += 1) {
    if (week === phiBye) contests.push(contest(season, week, "DAL", "WAS"));
    else if (week === dalBye) contests.push(contest(season, week, "PHI", "NYG"));
    else contests.push(contest(season, week, "PHI", "DAL"));
  }
  return contests;
}

describe("teamByeWeeks", () => {
  it("derives each team's bye as the one week its schedule leaves empty", () => {
    const byes = teamByeWeeks(seasonSchedule(2026, 9, 7), 2026);
    expect(byes.get("PHI")).toBe(9);
    expect(byes.get("DAL")).toBe(7);
  });

  it("refuses to guess for a team missing more than one week", () => {
    // The fillers play once each, leaving seventeen candidate weeks. Any answer would be
    // a guess, and a guessed bye is the same class of silent wrong number as the null it
    // replaces — an absent entry is what tells the caller to fall back deliberately.
    const byes = teamByeWeeks(seasonSchedule(2026, 9, 7), 2026);
    expect(byes.has("NYG")).toBe(false);
    expect(byes.has("WAS")).toBe(false);
  });

  it("reads only the requested season", () => {
    // Both seasons are present, as they are in the real schedule file, and PHI's bye
    // differs between them. Skipping the season filter merges the two week sets, no week
    // is missing, and every bye vanishes.
    const contests = [...seasonSchedule(2025, 5, 6), ...seasonSchedule(2026, 9, 7)];
    expect(teamByeWeeks(contests, 2026).get("PHI")).toBe(9);
    expect(teamByeWeeks(contests, 2025).get("PHI")).toBe(5);
    expect(teamByeWeeks([...seasonSchedule(2026, 9, 7)], 2025).size).toBe(0);
  });

  it("gives a team playing every week of the span no entry at all", () => {
    // No bye is not a bye of week zero, or of any week — an eighteen-game slate with no
    // idle week (not a real NFL shape, but a possible feed defect) must yield nothing
    // rather than a fabricated number.
    const noByes: Contest[] = [];
    for (let week = 1; week <= 18; week += 1) noByes.push(contest(2026, week, "PHI", "DAL"));
    const byes = teamByeWeeks(noByes, 2026);
    expect(byes.has("PHI")).toBe(false);
    expect(byes.has("DAL")).toBe(false);
  });

  it("derives a bye in the final week of the span", () => {
    // The span's upper boundary, inclusive. Real byes never land in the last scheduled
    // week, which is exactly why only a test can hold this edge: an off-by-one that
    // stops the sweep before `lastWeek` loses precisely this bye and nothing else.
    const byes = teamByeWeeks(seasonSchedule(2026, 18, 7), 2026);
    expect(byes.get("PHI")).toBe(18);
  });

  it("derives from a truncated schedule only what the truncation can support", () => {
    // The first six weeks only — the shape of a truncated feed. The span is the
    // schedule's own, so a team playing every one of those weeks is not missing anything
    // *observable* and gets no entry — its real bye is past the truncation and inventing
    // one would be a guess. PHI's bye falls inside the span, and a team that skips one
    // week of a schedule it otherwise fills is on its bye, truncated or not.
    const partial = seasonSchedule(2026, 4, 9).filter((c) => c.period.index <= 6);
    const byes = teamByeWeeks(partial, 2026);
    expect(byes.get("PHI")).toBe(4);
    expect(byes.has("DAL")).toBe(false);
  });

  it("takes the season's span from the schedule itself", () => {
    // A seventeen-week season, as every season before 2021 was. Hardcoding an 18-week
    // span would leave week 18 "missing" for every team and turn each real bye into an
    // ambiguous pair.
    const short = seasonSchedule(2019, 8, 10).filter((c) => c.period.index <= 17);
    const byes = teamByeWeeks(short, 2019);
    expect(byes.get("PHI")).toBe(8);
    expect(byes.get("DAL")).toBe(10);
  });

  it("returns an empty map for an empty schedule", () => {
    expect(teamByeWeeks([], 2026).size).toBe(0);
  });
});
