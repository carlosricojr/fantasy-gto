import { describe, expect, it } from "vitest";

import type { Contest } from "../core/domain";

import {
  NFL_REGULAR_SEASON_WEEKS,
  completedPeriods,
  describePeriod,
  describeSeasonState,
  isNflRegularSeasonWeek,
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

describe("isNflRegularSeasonWeek", () => {
  it.each([
    [1, true],
    [18, true],
    [0, false],
    [19, false],
    [1.5, false],
  ])("classifies week %s as %s", (week, expected) => {
    expect(isNflRegularSeasonWeek(week)).toBe(expected);
  });

  it("answers a question about the NFL calendar, not about anyone's league", () => {
    // Week 18 is the case the old name got wrong. It is an NFL week, and it is a fantasy
    // week in no league this product offers — the final is played in 15, 16 or 17. A
    // predicate called `isFantasyWeek` that returns true here would have been reached for
    // to gate exactly the question it answers incorrectly.
    expect(isNflRegularSeasonWeek(NFL_REGULAR_SEASON_WEEKS)).toBe(true);
    expect(NFL_REGULAR_SEASON_WEEKS).toBe(18);
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

/**
 * The season resolver's own edges.
 *
 * This module decides what season and week every other screen is about, and it was never
 * mutation-tested. Each of these was a survivor: a comparison, a `Math.min`, a sort, and
 * two boundaries against the injected clock — which is the one thing that makes a boundary
 * on "has it kicked off yet" testable at all.
 */
describe("resolveSeasonState boundaries", () => {
  const KICKOFF = "2026-09-10T20:20:00Z";
  const kickoffAt = Date.parse(KICKOFF);

  it("counts a season as started at the instant of kickoff, not a moment later", () => {
    // `Date.parse(firstKickoff) <= now`. A game that is kicking off right now has started,
    // and the difference decides whether the product says "preseason" or "week 1" at the
    // exact moment everybody is watching.
    const contests = [contest(2026, 1, false, KICKOFF)];
    expect(resolveSeasonState(contests, kickoffAt)?.phase).toBe("regular");
    expect(resolveSeasonState(contests, kickoffAt - 1)?.phase).toBe("preseason");
  });

  it("stops calling a season upcoming once its first game has kicked off", () => {
    // `kickoff > now`, in the scan that decides which season to display. Nothing here has
    // a result, so that scan is what chooses.
    //
    // The answer at the instant of 2026's kickoff is 2027, and that is deliberate rather
    // than ideal: with no result ingested yet, 2026 is indistinguishable from a season
    // whose schedule was loaded and whose results never were, and treating *that* as
    // current would pin the product to a dead season permanently — which the comment above
    // `firstKickoff` explains at length. The window is the hours between kickoff and the
    // first result landing, once a year. Pinned so the tradeoff is visible rather than
    // rediscovered.
    const contests = [
      contest(2026, 1, false, KICKOFF),
      contest(2027, 1, false, "2027-09-09T20:20:00Z"),
    ];
    expect(resolveSeasonState(contests, kickoffAt - 1)?.season).toBe(2026);
    expect(resolveSeasonState(contests, kickoffAt)?.season).toBe(2027);
  });

  it("reads the first kickoff of a season, not the last", () => {
    // `Math.min` over the season's start times. Taking the maximum judges a season by its
    // *final* game, so one that kicked off in September is still "upcoming" until January.
    //
    // Two seasons, because with one the answer is the same either way — it is the only
    // season there is. Here 2026 is under way and 2027 has not started: the earliest season
    // that has genuinely not kicked off is 2027, and reading 2026's last game instead of
    // its first would make 2026 upcoming too, and 2026 sorts first.
    const contests = [
      contest(2026, 1, false, "2026-09-10T20:20:00Z"),
      contest(2026, 18, false, "2027-01-04T18:00:00Z"),
      contest(2027, 1, false, "2027-09-09T20:20:00Z"),
    ];
    const between = Date.parse("2026-11-01T00:00:00Z");
    expect(resolveSeasonState(contests, between)?.season).toBe(2027);
  });

  it("reads kickoffs from the season it was asked about", () => {
    // `season === s && startsAt !== null`. As `||` every contest with a start time is
    // collected for every season, so `firstKickoff` returns the earliest kickoff in the
    // whole schedule whatever season it is asked about — and every later season inherits an
    // already-passed kickoff and stops counting as upcoming.
    const contests = [
      contest(2026, 1, false, "2026-09-10T20:20:00Z"),
      contest(2027, 1, false, "2027-09-09T20:20:00Z"),
      contest(2028, 1, false, "2028-09-07T20:20:00Z"),
    ];
    // 2026 has kicked off; the earliest season that has not is 2027.
    const between = Date.parse("2026-11-01T00:00:00Z");
    expect(resolveSeasonState(contests, between)?.season).toBe(2027);

    // And before anything has kicked off, the earliest is the one to show.
    const before = Date.parse("2026-08-01T00:00:00Z");
    expect(resolveSeasonState(contests, before)?.season).toBe(2026);
    expect(resolveSeasonState(contests, before)?.phase).toBe("preseason");
  });

  it("takes the earliest unplayed week however the schedule is ordered", () => {
    // The sort is `a.index - b.index`; as a sum it is positive for every pair, so nothing
    // moves and the week shown is whichever row happened to arrive first.
    const contests = [
      contest(2026, 1, true, "2026-09-10T20:20:00Z"),
      contest(2026, 9, false, "2026-11-05T18:00:00Z"),
      contest(2026, 3, false, "2026-09-24T18:00:00Z"),
      contest(2026, 7, false, "2026-10-22T18:00:00Z"),
    ];
    expect(resolveSeasonState(contests, Date.parse("2026-09-20T00:00:00Z"))?.week).toBe(3);
  });
});

describe("latestCompletedSeason", () => {
  it("is the most recent season with a result, not the oldest", () => {
    // `Math.max`. As a minimum it pins to the first season ever ingested and never moves
    // again, so every screen that keys off it shows years-old data indefinitely.
    const contests = [
      contest(2023, 1, true),
      contest(2024, 1, true),
      contest(2026, 1, false, "2026-09-10T20:20:00Z"),
    ];
    expect(latestCompletedSeason(contests)).toBe(2024);
  });

  it("has no answer before anything has been played", () => {
    expect(latestCompletedSeason([contest(2026, 1, false, "2026-09-10T20:20:00Z")])).toBeNull();
    expect(latestCompletedSeason([])).toBeNull();
  });
});
