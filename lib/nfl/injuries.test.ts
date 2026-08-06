import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";
import {
  indexInjuries,
  injuryKey,
  toGameStatus,
  toPracticeStatus,
  toRegularSeasonInjuries,
} from "./injuries";

/**
 * The injury report, parsed against byte-exact slices of **both** header shapes.
 *
 * Two fixtures rather than one, because the shapes genuinely differ and the difference is
 * the trap: 2024 carries `date_modified` and no `season_type`, 2025 the reverse. A single
 * fixture would test whichever shape it happened to be cut from and pass while the other
 * silently produced nothing.
 */
const FIXTURES = join(__dirname, "../../tests/fixtures");
const csv2024 = readFileSync(join(FIXTURES, "injuries_2024_sample.csv"), "utf8");
const csv2025 = readFileSync(join(FIXTURES, "injuries_2025_sample.csv"), "utf8");

describe("toGameStatus", () => {
  it("maps the designations upstream publishes", () => {
    expect(toGameStatus("Out")).toBe("out");
    expect(toGameStatus("Doubtful")).toBe("doubtful");
    expect(toGameStatus("Questionable")).toBe("questionable");
  });

  it("treats a blank as no designation, not as unknown", () => {
    // A player listed with a practice limitation but no game status is a real and common
    // row. Calling that "unknown" would bury it in the drift counter.
    expect(toGameStatus("")).toBe("none");
    expect(toGameStatus("   ")).toBe("none");
    // Upstream genuinely ships whitespace-with-newline in these columns.
    expect(toGameStatus("\n    ")).toBe("none");
  });

  it("does not fold an unrecognised value into a known one", () => {
    // Upstream ships a literal "Note". Quietly reading it as "no designation" is how a new
    // status value goes unnoticed for a season.
    expect(toGameStatus("Note")).toBe("unknown");
    expect(toGameStatus("Probable")).toBe("unknown");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(toGameStatus("  OUT ")).toBe("out");
    expect(toGameStatus("questionable")).toBe("questionable");
  });
});

describe("toPracticeStatus", () => {
  it("maps the participation levels upstream publishes", () => {
    expect(toPracticeStatus("Full Participation in Practice")).toBe("full");
    expect(toPracticeStatus("Limited Participation in Practice")).toBe("limited");
    expect(toPracticeStatus("Did Not Participate In Practice")).toBe("did-not-participate");
  });

  it("treats blank and whitespace-with-newline as no entry", () => {
    expect(toPracticeStatus("")).toBe("none");
    expect(toPracticeStatus("\n    ")).toBe("none");
  });

  it("counts anything else as unknown", () => {
    expect(toPracticeStatus("Note")).toBe("unknown");
  });
});

describe("toRegularSeasonInjuries — 2024 shape", () => {
  const parsed = toRegularSeasonInjuries(parseCsv(csv2024));

  it("keeps regular-season rows and drops the rest", () => {
    // The fixture holds one Wild Card row. Filtering on `game_type` works for both header
    // shapes; filtering on `season_type` would discard all of 2024, which is the trap.
    expect(parsed.reports).toHaveLength(7);
    expect(parsed.reports.every((r) => r.season === 2024)).toBe(true);
  });

  it("parses a quoted field containing a newline without shifting columns", () => {
    // 48 records in the real 2024 file have a `practice_status` of "\n    ". Splitting the
    // file on newlines shifts every column after it, and the row still looks plausible.
    const vanNoy = parsed.reports.find((r) => r.playerId === "00-0031360");
    expect(vanNoy).toBeDefined();
    expect(vanNoy?.name).toBe("Kyle Van Noy");
    expect(vanNoy?.gameStatus).toBe("out");
    expect(vanNoy?.practiceStatus).toBe("none");
    // The column after the newline field is still read correctly, which is the real check.
    expect(vanNoy?.dateModified).toBe("2024-09-06T03:11:40Z");
  });

  it("carries date_modified, which 2024 has and 2025 does not", () => {
    expect(parsed.reports.every((r) => r.dateModified !== null)).toBe(true);
  });

  it("counts an unrecognised designation instead of coercing it", () => {
    expect(parsed.unknownGameStatus.get("Note")).toBe(1);
    // And the row is still parsed — an unknown status is not a corrupt record.
    const carr = parsed.reports.find((r) => r.playerId === "00-0031280");
    expect(carr?.gameStatus).toBe("unknown");
  });

  it("normalizes a retired team code, not merely a canonical one", () => {
    // Asserting non-null against fixture teams that are already canonical would pass with
    // no normalization at all. The seasons this file can be extended to carry OAK, SD and
    // STL, and a join keyed on the raw code drops every one of those teams silently.
    const rows = [
      { season: "2015", week: "3", gsis_id: "x", game_type: "REG", team: "OAK" },
      { season: "2015", week: "3", gsis_id: "y", game_type: "REG", team: "SD" },
      { season: "2014", week: "3", gsis_id: "z", game_type: "REG", team: "STL" },
    ];
    expect(toRegularSeasonInjuries(rows).reports.map((r) => r.team)).toEqual([
      "LV",
      "LAC",
      "LA",
    ]);
    expect(parsed.reports.every((r) => r.team !== null)).toBe(true);
  });
});

describe("toRegularSeasonInjuries — 2025 shape", () => {
  const parsed = toRegularSeasonInjuries(parseCsv(csv2025));

  it("parses the shape that has season_type and no date_modified", () => {
    expect(parsed.reports).toHaveLength(5);
    expect(parsed.reports.every((r) => r.season === 2025)).toBe(true);
    // The absence is the normal case here, not a failure.
    expect(parsed.reports.every((r) => r.dateModified === null)).toBe(true);
  });

  it("reads the same designations from the different header", () => {
    const statuses = new Set(parsed.reports.map((r) => r.gameStatus));
    expect(statuses.has("out")).toBe(true);
    expect(statuses.has("questionable")).toBe(true);
    expect(statuses.has("doubtful")).toBe(true);
    expect(statuses.has("none")).toBe(true);
  });

  it("drops the postseason row", () => {
    expect(parsed.reports.some((r) => r.playerId === "00-0023853")).toBe(false);
  });
});

describe("both shapes agree", () => {
  it("yields rows from both headers, which is the whole point of filtering on game_type", () => {
    // The previous version of this test compared `Object.keys` of two records built from
    // the same object literal, so it could not fail whatever the parse did. What actually
    // needs asserting is that neither season comes back empty: filtering on `season_type`
    // instead would leave 2024 at zero and 2025 unchanged, which is exactly the drift that
    // cost a debugging cycle.
    const a = toRegularSeasonInjuries(parseCsv(csv2024));
    const b = toRegularSeasonInjuries(parseCsv(csv2025));
    expect(a.reports.length).toBeGreaterThan(0);
    expect(b.reports.length).toBeGreaterThan(0);
    // And both carry real designations rather than an all-blank parse.
    expect(a.reports.some((r) => r.gameStatus !== "none")).toBe(true);
    expect(b.reports.some((r) => r.gameStatus !== "none")).toBe(true);
  });

  it("drops a row with no player identifier", () => {
    // Built from the parsed column names rather than by splitting the header on commas.
    // These files carry quoted fields — one of them contains a newline — and reaching for
    // `String.split(",")` inside a test is no safer than reaching for it in the parser.
    const columns = Object.keys(parseCsv(csv2025)[0]);
    const header = csv2025.split("\n")[0];
    const blank = `${header}\n${columns.map((c) => (c === "game_type" ? "REG" : "")).join(",")}\n`;
    expect(toRegularSeasonInjuries(parseCsv(blank)).reports).toHaveLength(0);
  });
});

describe("indexInjuries", () => {
  it("keys on player, season and week", () => {
    const parsed = toRegularSeasonInjuries(parseCsv(csv2024));
    const index = indexInjuries(parsed.reports);
    const first = parsed.reports[0];
    expect(index.get(injuryKey(first.playerId, first.season, first.week))).toEqual(first);
    expect(index.size).toBe(parsed.reports.length);
  });

  it("lets a later row supersede an earlier one for the same key", () => {
    // Matches upstream, where a corrected row replaces rather than duplicates.
    const rows = [
      { season: "2024", week: "3", gsis_id: "x", game_type: "REG", report_status: "Questionable" },
      { season: "2024", week: "3", gsis_id: "x", game_type: "REG", report_status: "Out" },
    ];
    const parsed = toRegularSeasonInjuries(rows);
    expect(indexInjuries(parsed.reports).get(injuryKey("x", 2024, 3))?.gameStatus).toBe("out");
  });
});
