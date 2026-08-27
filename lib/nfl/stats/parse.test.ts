import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCsv } from "../csv";
import { PPR } from "../scoring/presets";
import { scoreDefense } from "../scoring/score";
import { toDefenseStatLine, toTeamWeek } from "./parse";

/**
 * Team-defense parsing, against real upstream bytes.
 *
 * The fixture is five unedited rows of `stats_team_week_2024.csv`, chosen so that every
 * counting statistic a fantasy defense scores is non-zero in at least one of them. That is
 * the point of the file: `num` answers zero for a column that is not there, so a renamed
 * column does not throw, it quietly scores every defense as if the event never happened.
 * A hand-written fixture would pin the parser against my own transcription of the header
 * rather than against upstream's, which is exactly the check worth having.
 */

const ROWS = parseCsv(
  readFileSync(join(__dirname, "../../../tests/fixtures/stats_team_week_sample.csv"), "utf8"),
);

const COLUMNS = [
  "def_sacks",
  "def_interceptions",
  "fumble_recovery_opp",
  "def_tds",
  "special_teams_tds",
  "def_safeties",
];

describe("toTeamWeek", () => {
  it("reads the identity a defense's week is keyed on", () => {
    expect(toTeamWeek(ROWS[0])).toEqual({ team: "DEN", period: { season: 2024, index: 1 } });
  });

  it("normalizes the team rather than trusting upstream's spelling", () => {
    // The same normalization the schedule goes through, so the points-allowed join has two
    // sides that agree. A relocated franchise spelled two ways would otherwise fail to
    // join and take its whole season out of the measurement.
    expect(toTeamWeek({ ...ROWS[0], team: "OAK" })?.team).toBe("LV");
  });

  it("answers null for a row with no recognizable team", () => {
    expect(toTeamWeek({ ...ROWS[0], team: "" })).toBeNull();
  });
});

describe("toDefenseStatLine", () => {
  it("finds every column it reads present in the shipped release", () => {
    // The guard that actually matters. If upstream renames one of these, this fails here
    // rather than silently subtracting the event from every defense in the band.
    for (const column of COLUMNS) {
      expect(Object.keys(ROWS[0])).toContain(column);
    }
  });

  it("exercises each column on a row where it is non-zero", () => {
    // A fixture where a column is zero everywhere would pass the header check and still
    // not prove the parser reads *that* column rather than its neighbour.
    const lines = ROWS.map((row) => toDefenseStatLine(row, 0));
    expect(lines.some((line) => line.sacks > 0)).toBe(true);
    expect(lines.some((line) => line.interceptions > 0)).toBe(true);
    expect(lines.some((line) => line.fumbleRecoveries > 0)).toBe(true);
    expect(lines.some((line) => line.defensiveTds > 0)).toBe(true);
    expect(lines.some((line) => line.specialTeamsTds > 0)).toBe(true);
    expect(lines.some((line) => line.safeties > 0)).toBe(true);
  });

  it("maps a whole row to the stat line the scorer consumes", () => {
    const chicago = ROWS.find((row) => toTeamWeek(row)?.team === "CHI")!;
    expect(toDefenseStatLine(chicago, 17)).toEqual({
      sacks: 3,
      interceptions: 2,
      fumbleRecoveries: 1,
      defensiveTds: 1,
      specialTeamsTds: 1,
      safeties: 0,
      pointsAllowed: 17,
      yardsAllowed: null,
    });
    // 3 sacks + 2 interceptions at two + a recovery at two + two touchdowns at six, and
    // 17 conceded lands in the 14-21 band, worth one.
    expect(scoreDefense(toDefenseStatLine(chicago, 17), PPR).total).toBe(22);
  });

  it("takes points allowed from the caller, because the release has no such column", () => {
    const row = ROWS[0];
    expect(Object.keys(row)).not.toContain("points_allowed");
    expect(toDefenseStatLine(row, 0).pointsAllowed).toBe(0);
    expect(toDefenseStatLine(row, 41).pointsAllowed).toBe(41);
    // And it is load-bearing, not decorative: the tiered bonus swings fourteen points
    // between a shutout and a blowout on identical defensive counts.
    expect(scoreDefense(toDefenseStatLine(row, 0), PPR).total).toBe(
      scoreDefense(toDefenseStatLine(row, 41), PPR).total + 14,
    );
  });

  it("reads a missing column as zero, which is why the header check above exists", () => {
    // Built by filtering rather than by destructuring off the unwanted key: the discard
    // binding that reads most naturally here is an unused variable, and an ESLint warning
    // survives `pnpm verify`, which only fails on errors.
    const withoutSacks = Object.fromEntries(
      Object.entries(ROWS[3]).filter(([column]) => column !== "def_sacks"),
    );
    expect(toDefenseStatLine(ROWS[3], 0).sacks).toBe(6);
    expect(toDefenseStatLine(withoutSacks, 0).sacks).toBe(0);
  });

  it("leaves yards allowed absent rather than approximating it", () => {
    // No shipped ruleset enables yardage tiers, and the release carries no total-yards
    // column for the opponent. Inventing one from passing plus rushing yards would be a
    // different quantity wearing the same name.
    expect(toDefenseStatLine(ROWS[0], 20).yardsAllowed).toBeNull();
  });
});
