import { describe, expect, it } from "vitest";

import type { Contest } from "../core/domain";

import {
  completedPeriods,
  describePeriod,
  describeSeasonState,
  isFantasyWeek,
  latestCompletedSeason,
  resolveSeasonState,
  weeksBetween,
  draftSeasonFor,
  type SeasonState,
} from "./season";

const NOW = Date.parse("2026-07-30T12:00:00Z");

function contest(
  season: number,
  week: number,
  played: boolean,
  startsAt: string | null = null,
): Contest {
  return {
    id: `${season}_${String(week).padStart(2, "0")}_AAA_BBB`,
    period: { season, index: week },
    homeTeam: "PHI",
    awayTeam: "DAL",
    startsAt,
    result: played ? { homeScore: 24, awayScore: 17 } : null,
  };
}

describe("resolveSeasonState", () => {
  it("returns null with no schedule", () => {
    expect(resolveSeasonState([], NOW)).toBeNull();
  });

  it("does not pin to a season whose results were never ingested", () => {
    // Both seasons are unplayed by result alone: 2025's schedule was ingested but its
    // results never were. Choosing the oldest unplayed season would settle on 2025 and,
    // because its kickoff is in the past, report it as an in-progress regular season —
    // permanently, since no later result can ever arrive to move it on.
    const contests = [
      contest(2025, 1, false, "2025-09-04T20:20:00Z"),
      contest(2025, 2, false, "2025-09-11T20:20:00Z"),
      contest(2026, 1, false, "2026-09-10T20:20:00Z"),
    ];

    const state = resolveSeasonState(contests, NOW);
    expect(state?.season).toBe(2026);
    expect(state?.phase).toBe("preseason");
  });

  it("still prefers the earliest upcoming season when several are scheduled", () => {
    const contests = [
      contest(2026, 1, false, "2026-09-10T20:20:00Z"),
      contest(2027, 1, false, "2027-09-09T20:20:00Z"),
    ];

    expect(resolveSeasonState(contests, NOW)?.season).toBe(2026);
  });

  it("falls back to the most recent season when nothing is upcoming or played", () => {
    // Every kickoff is in the past and nothing has a result — a schedule that stopped
    // being updated. The most recent season is the least wrong answer.
    const contests = [
      contest(2024, 1, false, "2024-09-05T20:20:00Z"),
      contest(2025, 1, false, "2025-09-04T20:20:00Z"),
    ];

    expect(resolveSeasonState(contests, NOW)?.season).toBe(2025);
  });

  it("reports the current week as the earliest unplayed one", () => {
    const contests = [
      contest(2025, 1, true),
      contest(2025, 2, true),
      contest(2025, 3, false),
      contest(2025, 4, false),
    ];
    expect(resolveSeasonState(contests, NOW)).toEqual({
      season: 2025,
      week: 3,
      phase: "regular",
      isComplete: false,
    });
  });

  it("marks a fully played season complete and shows its final week", () => {
    const contests = [contest(2025, 1, true), contest(2025, 18, true)];
    expect(resolveSeasonState(contests, NOW)).toEqual({
      season: 2025,
      week: 18,
      phase: "offseason",
      isComplete: true,
    });
  });

  /**
   * The real situation at the time of writing: 2025 is complete and 2026 is scheduled but
   * unplayed. Trusting the calendar year would show an empty 2026 Week 1.
   */
  it("prefers the last played season over a scheduled future one", () => {
    const contests = [
      contest(2025, 17, true),
      contest(2025, 18, true),
      contest(2026, 1, false, "2026-09-10T00:20:00Z"),
      contest(2026, 2, false, "2026-09-17T00:20:00Z"),
    ];
    const state = resolveSeasonState(contests, NOW)!;
    expect(state.season).toBe(2025);
    expect(state.phase).toBe("offseason");
    expect(state.isComplete).toBe(true);
  });

  it("treats a scheduled season with no kickoff yet as preseason", () => {
    const contests = [contest(2026, 1, false, "2026-09-10T00:20:00Z")];
    expect(resolveSeasonState(contests, NOW)).toEqual({
      season: 2026,
      week: 1,
      phase: "preseason",
      isComplete: false,
    });
  });

  it("switches to regular once the first kickoff has passed", () => {
    const contests = [contest(2026, 1, false, "2026-09-10T00:20:00Z")];
    const afterKickoff = Date.parse("2026-09-10T01:00:00Z");
    expect(resolveSeasonState(contests, afterKickoff)?.phase).toBe("regular");
  });

  it("does not depend on the order of the schedule", () => {
    const contests = [contest(2025, 3, false), contest(2025, 1, true), contest(2025, 2, true)];
    expect(resolveSeasonState(contests, NOW)?.week).toBe(3);
    expect(resolveSeasonState([...contests].reverse(), NOW)?.week).toBe(3);
  });
});

describe("latestCompletedSeason", () => {
  it("ignores scheduled-but-unplayed seasons", () => {
    const contests = [contest(2025, 1, true), contest(2026, 1, false)];
    expect(latestCompletedSeason(contests)).toBe(2025);
  });

  it("returns null when nothing has been played", () => {
    expect(latestCompletedSeason([contest(2026, 1, false)])).toBeNull();
  });
});

describe("completedPeriods", () => {
  it("returns distinct periods in chronological order", () => {
    const contests = [
      contest(2025, 2, true),
      contest(2025, 2, true),
      contest(2025, 1, true),
      contest(2025, 3, false),
    ];
    expect(completedPeriods(contests)).toEqual([
      { season: 2025, index: 1 },
      { season: 2025, index: 2 },
    ]);
  });
});

describe("isFantasyWeek", () => {
  it.each([
    [1, true],
    [18, true],
    [0, false],
    [19, false],
    [1.5, false],
  ])("classifies week %s as %s", (week, expected) => {
    expect(isFantasyWeek(week)).toBe(expected);
  });
});

describe("labels", () => {
  it("describes a period", () => {
    expect(describePeriod({ season: 2025, index: 7 })).toBe("2025 Week 7");
  });

  it("explains each phase honestly", () => {
    expect(
      describeSeasonState({ season: 2025, week: 18, phase: "offseason", isComplete: true }),
    ).toContain("complete");
    expect(
      describeSeasonState({ season: 2026, week: 1, phase: "preseason", isComplete: false }),
    ).toContain("not kicked off");
    expect(
      describeSeasonState({ season: 2025, week: 7, phase: "regular", isComplete: false }),
    ).toBe("2025 Week 7");
  });
});

describe("weeksBetween", () => {
  const at = (season: number, index: number) => ({ season, index });

  it("counts within a season", () => {
    expect(weeksBetween(at(2025, 3), at(2025, 7))).toBe(4);
  });

  it("counts across one season boundary", () => {
    // Week 17 of 2024 to week 1 of 2025 is two weeks of football apart.
    expect(weeksBetween(at(2024, 17), at(2025, 1))).toBe(2);
  });

  it("multiplies the season gap out rather than assuming one season", () => {
    // The regression this exists for. A player whose last appearance was week 17 of 2023
    // and who missed all of 2024 is a year and a half stale at week 1 of 2025. Treating
    // the gap as a single season reads it as 2 weeks — inside INACTIVITY_WEEKS — and
    // projects them confidently from form over a year old.
    expect(weeksBetween(at(2023, 17), at(2025, 1))).toBe(20);
    expect(weeksBetween(at(2023, 17), at(2025, 1))).toBeGreaterThan(
      weeksBetween(at(2024, 17), at(2025, 1)),
    );
  });

  it("is negative when the earlier period is actually later", () => {
    // Callers compare against a staleness threshold, so a negative reads as recent, which
    // is right: the appearance is in the future relative to the week being projected.
    expect(weeksBetween(at(2025, 7), at(2025, 3))).toBe(-4);
  });
});

describe("draftSeasonFor", () => {
  const state = (over: Partial<SeasonState>): SeasonState => ({
    season: 2026,
    week: 1,
    phase: "preseason",
    isComplete: false,
    ...over,
  });

  it("is the upcoming season through the preseason", () => {
    // The window in which drafts actually happen. The rebuild cron used to return null
    // here and so never built the board it exists to keep fresh.
    expect(draftSeasonFor(state({ phase: "preseason" }))).toBe(2026);
  });

  it("is next season once this one has finished", () => {
    expect(draftSeasonFor(state({ phase: "offseason", isComplete: true }))).toBe(2027);
  });

  it("is the current season while it is being played", () => {
    // Nobody drafts here, but the page still renders a board for anyone looking, and it
    // must be the season they are in rather than the next one.
    expect(draftSeasonFor(state({ phase: "regular" }))).toBe(2026);
  });

  it("has no answer when there is no season", () => {
    expect(draftSeasonFor(null)).toBeNull();
  });
});
