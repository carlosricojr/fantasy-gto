import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";
import { teamsForWeek, toRosterStatus, toWeeklyRoster } from "./weekly-roster";

/**
 * Weekly rosters, parsed against a byte-exact slice of the real file.
 *
 * Eight rows lifted verbatim from upstream's 46,849, chosen for the cases that decide
 * whether this is safe to project from: active players at three positions, a cut player, a
 * reserve player, a traded player, a row with **no** `gsis_id` (29 of those exist), and the
 * same player in two different weeks.
 */
const FIXTURE = readFileSync(
  join(__dirname, "../../tests/fixtures/roster_weekly_2025_sample.csv"),
  "utf8",
);

const parsed = toWeeklyRoster(parseCsv(FIXTURE));

describe("toRosterStatus", () => {
  it("maps the codes upstream ships", () => {
    expect(toRosterStatus("ACT")).toBe("active");
    expect(toRosterStatus("CUT")).toBe("cut");
    expect(toRosterStatus("DEV")).toBe("practice-squad");
    expect(toRosterStatus("RES")).toBe("reserve");
    expect(toRosterStatus("INA")).toBe("inactive");
    expect(toRosterStatus("RET")).toBe("retired");
    // TRD and TRC are rare — seven rows each in 2025 — but they are real, and leaving a
    // value upstream actually ships in the unknown bucket makes the drift counter fire on
    // normal data. An alarm that fires on normal data stops being read.
    expect(toRosterStatus("TRD")).toBe("traded");
    expect(toRosterStatus("TRC")).toBe("traded");
    expect(toRosterStatus("EXE")).toBe("reserve");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(toRosterStatus(" act ")).toBe("active");
  });

  it("does not read an unrecognised code as active", () => {
    // The consequence of getting this wrong is specific: a new code folded into `active`
    // puts a practice-squad or injured-reserve player on a board as though he were
    // starting, and the board looks entirely normal.
    expect(toRosterStatus("XYZ")).toBe("unknown");
    expect(toRosterStatus("")).toBe("unknown");
  });
});

describe("toWeeklyRoster", () => {
  it("parses the fixture and drops the row with no identifier", () => {
    // Seven of the eight rows carry a gsis_id; the eighth cannot join to anything, and 29
    // such rows exist in the real file.
    expect(parsed.entries).toHaveLength(7);
    expect(parsed.entries.every((e) => e.playerId !== "")).toBe(true);
    expect(parsed.entries.some((e) => e.name === "Dante Barnett")).toBe(false);
  });

  it("reads an active player's team for a specific week", () => {
    const thielen = parsed.entries.find((e) => e.playerId === "00-0030035");
    expect(thielen?.name).toBe("Adam Thielen");
    expect(thielen?.team).toBe("MIN");
    expect(thielen?.week).toBe(1);
    expect(thielen?.status).toBe("active");
  });

  it("keeps the same player in two different weeks as two entries", () => {
    // The whole point of a *weekly* roster: a player's team is a per-week fact, so a trade
    // shows up as a change rather than being averaged away.
    const rodgers = parsed.entries.filter((e) => e.playerId === "00-0023459");
    expect(rodgers).toHaveLength(2);
    expect(rodgers.map((e) => e.week).sort()).toEqual([1, 2]);
  });

  it("records a non-active status rather than discarding the row", () => {
    const hopkins = parsed.entries.find((e) => e.playerId === "00-0030098");
    expect(hopkins?.status).toBe("cut");
    const harris = parsed.entries.find((e) => e.playerId === "00-0028845");
    expect(harris?.status).toBe("reserve");
    const koo = parsed.entries.find((e) => e.playerId === "00-0033702");
    expect(koo?.status).toBe("traded");
  });

  it("leaves the drift counter empty on a real file", () => {
    // Every status upstream ships is mapped, so the counter is a genuine alarm rather than
    // background noise.
    expect([...parsed.unknownStatus.keys()]).toEqual([]);
  });

  it("counts an unrecognised status instead of coercing it", () => {
    const report = toWeeklyRoster([
      { game_type: "REG", gsis_id: "x", season: "2025", week: "1", team: "SF", status: "XYZ" },
      { game_type: "REG", gsis_id: "y", season: "2025", week: "1", team: "SF", status: "XYZ" },
    ]);
    expect(report.unknownStatus.get("XYZ")).toBe(2);
    expect(report.entries.every((e) => e.status === "unknown")).toBe(true);
  });

  it("drops postseason rows", () => {
    const report = toWeeklyRoster([
      { game_type: "POST", gsis_id: "x", season: "2025", week: "19", team: "SF", status: "ACT" },
    ]);
    expect(report.entries).toHaveLength(0);
  });

  it("normalizes a retired team code", () => {
    // Weekly rosters go back to 2002, so OAK, SD and STL all appear.
    const report = toWeeklyRoster([
      { game_type: "REG", gsis_id: "a", season: "2015", week: "1", team: "OAK", status: "ACT" },
      { game_type: "REG", gsis_id: "b", season: "2015", week: "1", team: "SD", status: "ACT" },
      { game_type: "REG", gsis_id: "c", season: "2014", week: "1", team: "STL", status: "ACT" },
    ]);
    expect(report.entries.map((e) => e.team)).toEqual(["LV", "LAC", "LA"]);
  });
});

describe("teamsForWeek", () => {
  it("returns only the active players for that week", () => {
    const week1 = teamsForWeek(parsed.entries, 1);
    // Three active in week 1; the cut kicker and the reserve long snapper are excluded.
    expect(week1.get("00-0030035")).toBe("MIN");
    expect(week1.get("00-0029892")).toBe("SF");
    expect(week1.get("00-0023459")).toBe("PIT");
    expect(week1.has("00-0030098")).toBe(false);
    expect(week1.has("00-0028845")).toBe(false);
    expect(week1.size).toBe(3);
  });

  it("does not leak a player from another week", () => {
    // Rodgers is active in both weeks here, but a week-2 lookup must not see week 1's row
    // for a player who has since been traded.
    const week2 = teamsForWeek(parsed.entries, 2);
    expect(week2.size).toBe(1);
    expect(week2.get("00-0023459")).toBe("PIT");
  });

  it("resolves a mid-week duplicate deterministically", () => {
    // A transaction can list a player on two teams in the same week. First entry wins, so
    // the result is a function of file order rather than of iteration order — a board that
    // reshuffles between runs reads as a bug.
    const entries = toWeeklyRoster([
      { game_type: "REG", gsis_id: "x", season: "2025", week: "3", team: "SF", status: "ACT" },
      { game_type: "REG", gsis_id: "x", season: "2025", week: "3", team: "MIN", status: "ACT" },
    ]).entries;
    expect(teamsForWeek(entries, 3).get("x")).toBe("SF");
  });

  it("excludes a player whose status is unknown rather than assuming he plays", () => {
    const entries = toWeeklyRoster([
      { game_type: "REG", gsis_id: "x", season: "2025", week: "1", team: "SF", status: "XYZ" },
    ]).entries;
    expect(teamsForWeek(entries, 1).size).toBe(0);
  });
});
