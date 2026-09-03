import { describe, expect, it } from "vitest";

import {
  type LeagueConfig,
  bracketRoundsRequired,
  fantasySeasonWeeks,
  sampleTeamWeeklyScores,
  simulateLeague,
} from "@/lib/core/season-sim";
import { leagueFingerprint as memoFingerprint } from "@/lib/core/draft-memo";
import type { PlayerRisk } from "@/lib/core/roster-utility";
import { NFL_REGULAR_SEASON_WEEKS, isNflRegularSeasonWeek } from "@/lib/nfl/season";
import { UNPROJECTED_POSITIONS, WAIVER_WIRE_COVER, slotsForTemplate } from "@/lib/nfl/roster";

import {
  CHAMPIONSHIP_WEEKS,
  DEFAULT_CHAMPIONSHIP_WEEK,
  type PersistedDraft,
  PLAYOFF_FIELDS,
  parsePersistedDraft,
} from "./persistence";
import { leagueFingerprint as replyFingerprint } from "./reply-gate";
import { describeSeason, seasonSummary } from "./season-label";

/**
 * Every league this product can be put into, walked through every layer that has an opinion
 * about which weeks it plays.
 *
 * The reality this exists for: **a fantasy season ends before the NFL one does.** Finals are
 * played in week 15, 16 or 17 — never 18 — so the season the product simulates is a proper
 * *prefix* of the season the data describes, and the tail is football nobody's league scores.
 * That was implicit for as long as the board wrote out one hardcoded season, and it became
 * load-bearing the moment the final became a setting: the layout, the objective, the depth
 * model, storage, the on-screen labels, the memo key and the reply gate all now derive
 * something from where a league stops, and a disagreement between any two of them is a
 * wrong number rather than a crash.
 *
 * So these are identities and invariants rather than examples. The files beside this one pin
 * what particular leagues look like; this one pins that no reachable league is incoherent —
 * that the weeks partition, that what is stored comes back, that what is rendered equals what
 * was computed, that two different seasons cannot share a cache entry, and that the
 * assumption the depth model rests on actually holds for all of them.
 *
 * `SHAPES` is the whole product of the two offered lists, not a sample. Six is small enough
 * to be exhaustive, and an exhaustive walk cannot be lucky.
 */

const SHAPES = CHAMPIONSHIP_WEEKS.flatMap((championshipWeek) =>
  PLAYOFF_FIELDS.map((playoffTeams) => ({ championshipWeek, playoffTeams })),
);

const seasonFor = (championshipWeek: number, playoffTeams: number) =>
  fantasySeasonWeeks(championshipWeek, playoffTeams);

/** The shipped waiver-wire cover; these invariants are about the product's league. */
const WIRE_COVER = WAIVER_WIRE_COVER;

describe("the offered set is the whole space, and it is not empty", () => {
  it("is every combination the two controls can produce", () => {
    // A guard on the loops below: a list edited to nothing would make every property here
    // pass vacuously and read as coverage. Stated against a concrete floor rather than
    // against `CHAMPIONSHIP_WEEKS.length * PLAYOFF_FIELDS.length`, which `flatMap` makes
    // true by construction — including when both lists are empty, which is the one case
    // the guard exists to catch.
    expect(SHAPES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SHAPES.map((s) => `${s.championshipWeek}/${s.playoffTeams}`)).size).toBe(
      SHAPES.length,
    );
  });
});

describe("a fantasy season ends before the NFL season does", () => {
  it("offers no final in the last NFL week, or beyond it", () => {
    // The reality, stated once as an assertion rather than left in prose. Week 18 is a real
    // NFL week — `isNflRegularSeasonWeek` says so — and it is the week resting is
    // near-universal, which is the reason leagues move their finals earlier in the first
    // place. Offering it would be offering a season this product cannot model well.
    for (const championshipWeek of CHAMPIONSHIP_WEEKS) {
      expect(isNflRegularSeasonWeek(championshipWeek)).toBe(true);
      expect(championshipWeek).toBeLessThan(NFL_REGULAR_SEASON_WEEKS);
    }
  });

  it("leaves at least one NFL week unplayed, in every league", () => {
    // The prefix property everything else leans on: there is always a tail of real NFL
    // weeks the league does not score. If this ever became false, "a bye after the final
    // costs nothing" would stop being a statement about anything.
    for (const { championshipWeek, playoffTeams } of SHAPES) {
      const { weeks, playoffWeeks } = seasonFor(championshipWeek, playoffTeams);
      const played = new Set([...weeks, ...playoffWeeks]);
      const unplayed = Array.from(
        { length: NFL_REGULAR_SEASON_WEEKS },
        (_, i) => i + 1,
      ).filter((week) => !played.has(week));
      expect(unplayed.length).toBeGreaterThan(0);
      expect(Math.min(...unplayed)).toBe(championshipWeek + 1);
    }
  });

  it("plays only weeks the NFL actually plays", () => {
    // The other direction. A season laid out past the calendar would ask the schedule for
    // games that do not exist, and read zeros as football.
    for (const { championshipWeek, playoffTeams } of SHAPES) {
      const { weeks, playoffWeeks } = seasonFor(championshipWeek, playoffTeams);
      for (const week of [...weeks, ...playoffWeeks]) {
        expect(isNflRegularSeasonWeek(week)).toBe(true);
      }
    }
  });

  it("defaults to the latest final it offers, so every other choice ends earlier", () => {
    // Two things at once. The default is the week the board used to hardcode, which is what
    // makes a stored draft with no championship week a migration rather than a guess — see
    // the restore test below for the one field size where that is not an exact identity.
    // And it is the *ceiling*, so every league a manager can choose instead of it finishes
    // sooner. That is the direction real leagues move.
    expect(DEFAULT_CHAMPIONSHIP_WEEK).toBe(Math.max(...CHAMPIONSHIP_WEEKS));
    expect(CHAMPIONSHIP_WEEKS).toContain(DEFAULT_CHAMPIONSHIP_WEEK);
    for (const week of CHAMPIONSHIP_WEEKS) {
      expect(week).toBeLessThanOrEqual(DEFAULT_CHAMPIONSHIP_WEEK);
    }
  });
});

describe("what is stored comes back as the season it was drafted against", () => {
  const base: PersistedDraft = {
    teams: 12,
    rounds: 15,
    slot: 4,
    slotConfirmed: true,
    scoringId: "ppr",
    templateId: "standard",
    scoringConfirmed: true,
    playoffTeams: 6,
    championshipWeek: 17,
    started: true,
    picks: {},
    queue: [],
    sleeper: null,
  };

  it("round-trips every league the controls can produce", () => {
    // A shape the interface offers and the parser refuses is a draft that cannot survive a
    // refresh — discovered by the manager, mid-draft, under a pick clock.
    for (const { championshipWeek, playoffTeams } of SHAPES) {
      const payload: PersistedDraft = { ...base, championshipWeek, playoffTeams };
      const restored = parsePersistedDraft(JSON.stringify(payload));
      expect(restored).toEqual(payload);
      // And the restored pair still lays out a season, rather than restoring into a config
      // that throws on the next render.
      expect(() =>
        seasonFor(restored!.championshipWeek, restored!.playoffTeams),
      ).not.toThrow();
    }
  });

  it("restores a pre-existing draft at the default final, whatever its playoff field", () => {
    // The migration. Before the setting existed the board wrote out weeks 1-14 with a
    // bracket in 15-17 for *every* league, regardless of the playoff field — so restoring a
    // payload that predates it is only an exact identity for one of the two field sizes,
    // and pretending otherwise is what an earlier version of this test did by asserting the
    // six-team case alone.
    for (const playoffTeams of PLAYOFF_FIELDS) {
      const legacy: Record<string, unknown> = { ...base, playoffTeams };
      delete legacy.championshipWeek;
      const restored = parsePersistedDraft(JSON.stringify(legacy));
      expect(restored?.championshipWeek).toBe(DEFAULT_CHAMPIONSHIP_WEEK);
    }

    // Six teams: exactly the old season, so a draft in progress does not move.
    expect(seasonFor(DEFAULT_CHAMPIONSHIP_WEEK, 6)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      playoffWeeks: [15, 16, 17],
    });

    // Four teams: deliberately *not* the old season. The old pair gave a two-round field a
    // three-week bracket, and the bracket is consumed from the front — so it ran in weeks 15
    // and 16, the title was decided in 16, and week 17, the week the league had named as its
    // final, was never played. Restoring that would preserve the defect rather than the
    // league. A draft in progress does shift here, by one regular-season week, and the shift
    // is the correction.
    expect(seasonFor(DEFAULT_CHAMPIONSHIP_WEEK, 4)).toEqual({
      weeks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      playoffWeeks: [16, 17],
    });
  });
});

describe("what the screen says equals what was simulated", () => {
  // Parsed back out and compared with the config, rather than matched against a golden
  // string. A golden string pins the wording; this pins the *numbers*, which is the part
  // the honesty ledger is about — a sentence that names a season nobody simulated is the
  // failure that the old hardcoded "14-week regular season and a three-week bracket" was.

  it("names the same week counts the config holds", () => {
    for (const { championshipWeek, playoffTeams } of SHAPES) {
      const season = seasonFor(championshipWeek, playoffTeams);
      const match = /^a (\d+)-week regular season and a (\d+)-week bracket ending in week (\d+)$/.exec(
        describeSeason(season),
      );
      expect(match).not.toBeNull();
      const [, regular, rounds, final] = match!;
      expect(Number(regular)).toBe(season.weeks.length);
      expect(Number(rounds)).toBe(season.playoffWeeks.length);
      expect(Number(final)).toBe(championshipWeek);
      // The sentence's own arithmetic has to close: the two halves it names are the season.
      expect(Number(regular) + Number(rounds)).toBe(championshipWeek);
    }
  });

  it("names the same week numbers the config holds", () => {
    for (const { championshipWeek, playoffTeams } of SHAPES) {
      const season = seasonFor(championshipWeek, playoffTeams);
      const match = /^Weeks 1–(\d+) · playoffs (\d+)(?:–(\d+))?$/.exec(seasonSummary(season));
      expect(match).not.toBeNull();
      const [, lastRegular, firstPlayoff, lastPlayoff] = match!;
      expect(Number(lastRegular)).toBe(season.weeks[season.weeks.length - 1]);
      expect(Number(firstPlayoff)).toBe(season.playoffWeeks[0]);
      expect(Number(lastPlayoff ?? firstPlayoff)).toBe(championshipWeek);
    }
  });

  it("describes no two leagues the same way", () => {
    // A reader has to be able to tell which of the six they are looking at from the text
    // alone; two shapes sharing a description is a screen that cannot say what it did.
    const summaries = SHAPES.map(({ championshipWeek, playoffTeams }) =>
      seasonSummary(seasonFor(championshipWeek, playoffTeams)),
    );
    const sentences = SHAPES.map(({ championshipWeek, playoffTeams }) =>
      describeSeason(seasonFor(championshipWeek, playoffTeams)),
    );
    expect(new Set(summaries).size).toBe(SHAPES.length);
    expect(new Set(sentences).size).toBe(SHAPES.length);
  });
});

describe("no two seasons can be mistaken for each other by a cache or a gate", () => {
  const configFor = (championshipWeek: number, playoffTeams: number): LeagueConfig => ({
    wireCover: WIRE_COVER,
    unprojectedPositions: UNPROJECTED_POSITIONS,
    slots: slotsForTemplate("standard"),
    ...seasonFor(championshipWeek, playoffTeams),
    playoffTeams,
    scenarios: 200,
    meanAbsenceWeeks: 3,
  });

  it("gives no two of them the same recommendation memo key", () => {
    // Coverage of the *reachable* set, which is the question this file asks. A memo that
    // collides two of these answers quickly and wrongly, which is worse than not answering.
    //
    // What this does not prove is which component of the key does the work. For a season
    // laid out by `fantasySeasonWeeks` the `po=` half already determines the whole shape —
    // the bracket's weeks fix the championship week and the round count, which fix the
    // regular season — so these six stay distinct even if the `weeks=` half were reduced to
    // a count. That the key separates weeks by *identity* rather than by count is a
    // property of the fingerprint over hand-assembled configs, and it is pinned where it
    // belongs, in `draft-memo.test.ts` ("separates leagues whose weeks differ in identity,
    // not just in count"). Saying so here keeps this test from being read as covering it.
    const keys = SHAPES.map(({ championshipWeek, playoffTeams }) =>
      memoFingerprint(configFor(championshipWeek, playoffTeams), 1),
    );
    expect(new Set(keys).size).toBe(SHAPES.length);
  });

  it("retargets the reply gate when the season changes", () => {
    // The same discrimination on the other side: an answer computed for one bracket must not
    // sit on screen under another while a new one is computed.
    const prints = SHAPES.map(({ championshipWeek, playoffTeams }) =>
      replyFingerprint({
        season: 2026,
        scoringId: "ppr",
        templateId: "standard",
        teams: 12,
        rounds: 15,
        playoffTeams,
        championshipWeek,
      }),
    );
    expect(new Set(prints).size).toBe(SHAPES.length);
  });

  it("hands the depth model a regular season that runs 1..n from week one", () => {
    // Not a precondition. `expectedAboveReplacement` tests each bye for *membership* in the
    // week list it is given (`played.has(week)`) and is correct for any list at all — that
    // was the point of moving it off a count.
    //
    // What this pins is the premise of a claim made next to that code: that the count-to-list
    // change left every number identical, because `played.has(13)` rejects exactly the weeks
    // `13 <= 12` rejected. That equivalence holds only while the weeks are contiguous from
    // one. They are, for every season the product can produce — so if that ever stops being
    // true, this fails rather than the comment quietly becoming false.
    for (const { championshipWeek, playoffTeams } of SHAPES) {
      const { weeks } = seasonFor(championshipWeek, playoffTeams);
      expect(weeks).toEqual(Array.from({ length: weeks.length }, (_, i) => i + 1));
    }
  });
});

describe("every league the product can express actually simulates", () => {
  // The end of the chain: a config assembled the way the draft page assembles it, run
  // through the objective. A shape that the controls offer and the simulation refuses would
  // take the board down on a settings change, mid-draft.
  const slots = slotsForTemplate("standard");
  const p = (id: string, position: string, weeklyMean: number): PlayerRisk => ({
    id,
    name: id,
    position,
    weeklyMean,
    p10: 0.6,
    p90: 1.4,
    byeWeek: null,
    availability: 0.95,
  });
  const team = (tag: string) => [
    p(`${tag}-qb`, "QB", 18),
    p(`${tag}-rb1`, "RB", 14),
    p(`${tag}-rb2`, "RB", 11),
    p(`${tag}-wr1`, "WR", 13),
    p(`${tag}-wr2`, "WR", 10),
    p(`${tag}-te`, "TE", 9),
    p(`${tag}-k`, "K", 8),
    p(`${tag}-dst`, "DST", 7),
  ];

  it.each(SHAPES)(
    "crowns a champion with a final in week $championshipWeek and $playoffTeams qualifiers",
    ({ championshipWeek, playoffTeams }) => {
      const config: LeagueConfig = {
        wireCover: WIRE_COVER,
        unprojectedPositions: UNPROJECTED_POSITIONS,
        slots,
        ...seasonFor(championshipWeek, playoffTeams),
        playoffTeams,
        scenarios: 150,
        meanAbsenceWeeks: 3,
      };
      // The bracket is exactly as long as this field requires — asserted here too, because
      // it is the pairing that used to be written out by hand and got a four-team field a
      // round it does not play.
      expect(config.playoffWeeks).toHaveLength(bracketRoundsRequired(playoffTeams));

      const teams = Array.from({ length: 12 }, (_, i) =>
        sampleTeamWeeklyScores(team(`t${i}`), config, 3000 + i),
      );
      const outcomes = simulateLeague(teams, config);

      expect(outcomes).toHaveLength(12);
      expect(outcomes.reduce((sum, o) => sum + o.championshipProbability, 0)).toBeCloseTo(
        1,
        10,
      );
      expect(outcomes.reduce((sum, o) => sum + o.playoffProbability, 0)).toBeCloseTo(
        playoffTeams,
        10,
      );
      for (const outcome of outcomes) {
        expect(Number.isFinite(outcome.expectedPoints)).toBe(true);
        expect(outcome.expectedWins).toBeLessThanOrEqual(config.weeks.length);
      }
    },
  );
});
