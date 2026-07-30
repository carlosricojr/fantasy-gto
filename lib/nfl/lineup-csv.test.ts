import { describe, expect, it } from "vitest";

import { type LineupRow, fromLineupCsv, toLineupCsv } from "./lineup-csv";

const ROWS: LineupRow[] = [
  { slot: "QB", player: "Josh Allen", position: "QB", team: "BUF", projected: 21.4 },
  { slot: "FLEX", player: "Ja'Marr Chase", position: "WR", team: "CIN", projected: 17.05 },
  { slot: "TE", player: "", position: "", team: "", projected: null },
];

describe("toLineupCsv", () => {
  it("writes a header and one line per row", () => {
    const csv = toLineupCsv(ROWS);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("slot,player,position,team,projected");
    expect(lines).toHaveLength(4);
  });

  it("formats projections to two decimals and leaves absent ones blank", () => {
    const csv = toLineupCsv(ROWS);
    expect(csv).toContain("21.40");
    expect(csv).toContain("17.05");
    expect(csv.trimEnd().split("\r\n")[3]).toBe("TE,,,,");
  });

  it("quotes fields containing commas", () => {
    const csv = toLineupCsv([
      { slot: "WR", player: "Beckham, Odell", position: "WR", team: "MIA", projected: 9 },
    ]);
    expect(csv).toContain('"Beckham, Odell"');
  });

  it("escapes embedded quotes by doubling them", () => {
    const csv = toLineupCsv([
      { slot: "WR", player: 'The "Truth"', position: "WR", team: "NE", projected: null },
    ]);
    expect(csv).toContain('"The ""Truth"""');
  });

  it("produces only a header for an empty lineup", () => {
    expect(toLineupCsv([])).toBe("slot,player,position,team,projected\r\n");
  });
});

describe("fromLineupCsv", () => {
  it("reads a well-formed file", () => {
    const result = fromLineupCsv(
      "slot,player,position,team,projected\r\nQB,Josh Allen,QB,BUF,21.4\r\n",
    );
    expect(result.warnings).toEqual([]);
    expect(result.rows).toEqual([
      { slot: "QB", player: "Josh Allen", position: "QB", team: "BUF", projected: 21.4 },
    ]);
  });

  it("accepts headers in any case or order", () => {
    const result = fromLineupCsv("Player,TEAM,Pos\r\nJosh Allen,buf,qb\r\n");
    expect(result.rows[0]).toMatchObject({
      player: "Josh Allen",
      team: "BUF",
      position: "QB",
    });
  });

  it("accepts 'name' as an alias for the player column", () => {
    expect(fromLineupCsv("name\r\nJosh Allen\r\n").rows[0].player).toBe("Josh Allen");
  });

  it("skips blank spreadsheet rows without warning", () => {
    const result = fromLineupCsv("player,team\r\nJosh Allen,BUF\r\n,\r\n");
    expect(result.rows).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("reports an unreadable projection but keeps the row", () => {
    const result = fromLineupCsv("player,projected\r\nJosh Allen,not-a-number\r\n");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].projected).toBeNull();
    expect(result.warnings[0]).toContain("not-a-number");
  });

  it("reports a file with no player column", () => {
    const result = fromLineupCsv("foo,bar\r\n1,2\r\n");
    expect(result.rows).toEqual([]);
    expect(result.warnings[0]).toContain("No 'player' column");
  });

  it("reports an empty file", () => {
    expect(fromLineupCsv("").warnings[0]).toContain("empty");
    expect(fromLineupCsv("player,team\r\n").warnings[0]).toContain("empty");
  });

  it("ignores unknown columns", () => {
    const result = fromLineupCsv("player,notes\r\nJosh Allen,ignore me\r\n");
    expect(result.rows[0].player).toBe("Josh Allen");
  });
});

describe("round trip", () => {
  it("survives export then import unchanged", () => {
    const populated = ROWS.filter((row) => row.player !== "");
    const result = fromLineupCsv(toLineupCsv(populated));
    expect(result.warnings).toEqual([]);
    expect(result.rows).toEqual(populated);
  });

  it("survives names containing commas and quotes", () => {
    const tricky: LineupRow[] = [
      { slot: "WR", player: 'Beckham, Odell "OBJ"', position: "WR", team: "MIA", projected: 9.5 },
    ];
    expect(fromLineupCsv(toLineupCsv(tricky)).rows).toEqual(tricky);
  });
});
