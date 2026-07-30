import { describe, expect, it } from "vitest";

import type { Contest } from "@/lib/core/domain";

import {
  completedPeriods,
  describePeriod,
  describeSeasonState,
  isFantasyWeek,
  latestCompletedSeason,
  resolveSeasonState,
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
