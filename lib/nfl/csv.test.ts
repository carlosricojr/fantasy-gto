import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { num, numOrNull, parseCsv, parseCsvRows, str } from "./csv";

const FIXTURES = join(__dirname, "../../tests/fixtures");

describe("parseCsvRows", () => {
  it("parses a plain document", () => {
    expect(parseCsvRows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("returns no rows for empty input", () => {
    expect(parseCsvRows("")).toEqual([]);
  });

  it("does not emit a trailing empty row for a trailing newline", () => {
    expect(parseCsvRows("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps commas inside quoted fields", () => {
    // This is the exact upstream hazard: headshot_url contains "f_auto,q_auto".
    const rows = parseCsvRows('id,url,pos\n7,"https://x/f_auto,q_auto/img.png",WR');
    expect(rows[1]).toEqual(["7", "https://x/f_auto,q_auto/img.png", "WR"]);
    expect(rows[1]).toHaveLength(3);
  });

  it("unescapes doubled quotes", () => {
    expect(parseCsvRows('a\n"he said ""hi"""')).toEqual([["a"], ['he said "hi"']]);
  });

  it("keeps newlines inside quoted fields", () => {
    expect(parseCsvRows('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it.each([
    ["LF", "a,b\n1,2"],
    ["CRLF", "a,b\r\n1,2"],
    ["CR", "a,b\r1,2"],
  ])("handles %s line terminators", (_name, text) => {
    expect(parseCsvRows(text)).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a UTF-8 BOM from the first header cell", () => {
    expect(parseCsvRows("﻿a,b\n1,2")[0]).toEqual(["a", "b"]);
  });

  it("preserves empty fields", () => {
    expect(parseCsvRows("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("parseCsv", () => {
  it("keys rows by header", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([{ a: "1", b: "2" }]);
  });

  it("returns nothing for a header-only document", () => {
    expect(parseCsv("a,b\n")).toEqual([]);
  });

  it("pads missing trailing columns rather than failing", () => {
    expect(parseCsv("a,b,c\n1,2")).toEqual([{ a: "1", b: "2", c: "" }]);
  });

  it("drops cells beyond the header width", () => {
    expect(parseCsv("a,b\n1,2,3")).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("cell readers", () => {
  it("num treats empty and NA as the fallback", () => {
    const row = { x: "", y: "NA", z: "3.5", bad: "abc" };
    expect(num(row, "x")).toBe(0);
    expect(num(row, "y")).toBe(0);
    expect(num(row, "z")).toBe(3.5);
    expect(num(row, "missing")).toBe(0);
    expect(num(row, "x", 1)).toBe(1);
  });

  it("num never returns NaN for unparseable input", () => {
    expect(num({ bad: "abc" }, "bad")).toBe(0);
    expect(Number.isNaN(num({ bad: "abc" }, "bad"))).toBe(false);
  });

  it("numOrNull distinguishes absent from zero", () => {
    const row = { line: "0", missing: "", na: "NA" };
    expect(numOrNull(row, "line")).toBe(0);
    expect(numOrNull(row, "missing")).toBeNull();
    expect(numOrNull(row, "na")).toBeNull();
    expect(numOrNull(row, "absent")).toBeNull();
  });

  it("str normalizes NA and absent to empty string", () => {
    expect(str({ a: "NA" }, "a")).toBe("");
    expect(str({}, "a")).toBe("");
    expect(str({ a: "WR" }, "a")).toBe("WR");
  });
});

describe("against real upstream fixtures", () => {
  const statsText = readFileSync(join(FIXTURES, "stats_player_week_sample.csv"), "utf8");
  const gamesText = readFileSync(join(FIXTURES, "games_sample.csv"), "utf8");

  it("parses the player-week fixture with a stable column count", () => {
    const rows = parseCsv(statsText);
    expect(rows.length).toBeGreaterThan(100);
    // The upstream schema is 145 columns; every row must bind all of them.
    const widths = new Set(rows.map((r) => Object.keys(r).length));
    expect(widths).toEqual(new Set([145]));
  });

  it("recovers the quoted headshot_url without column drift", () => {
    const rows = parseCsv(statsText);
    const withComma = rows.filter((r) => r.headshot_url.includes(","));
    expect(withComma.length).toBeGreaterThan(0);
    // If the parser had split naively, position would hold URL fragments.
    for (const row of rows) {
      expect(row.position).toMatch(/^[A-Z]{1,3}$/);
      expect(row.season).toBe("2025");
    }
  });

  it("parses the games fixture and exposes Vegas lines as numbers", () => {
    const rows = parseCsv(gamesText);
    expect(rows.length).toBeGreaterThan(100);
    for (const row of rows) {
      expect(row.game_id).toMatch(/^2025_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/);
      expect(numOrNull(row, "total_line")).not.toBeNull();
    }
  });
});
