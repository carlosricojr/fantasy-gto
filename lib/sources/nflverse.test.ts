import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "../nfl/csv";

import {
  NflverseProvider,
  parseSeasonRoster,
  seasonRosterUrl,
  easternWallClockToUtcIso,
  parseContests,
  parseMarketLines,
  schedulesUrl,
  weeklyStatsUrl,
} from "./nflverse";

const gamesCsv = readFileSync(
  join(__dirname, "../../tests/fixtures/games_sample.csv"),
  "utf8",
);
const statsCsv = readFileSync(
  join(__dirname, "../../tests/fixtures/stats_player_week_sample.csv"),
  "utf8",
);
const rosterCsv = readFileSync(
  join(__dirname, "../../tests/fixtures/roster_2026_sample.csv"),
  "utf8",
);

describe("easternWallClockToUtcIso", () => {
  it("applies the summer offset (EDT, UTC-4)", () => {
    // A 20:20 Eastern kickoff in September is 00:20 UTC the next day.
    expect(easternWallClockToUtcIso("2025-09-07", "20:20")).toBe("2025-09-08T00:20:00.000Z");
  });

  it("applies the winter offset (EST, UTC-5)", () => {
    // The same wall clock in January is 01:20 UTC the next day.
    expect(easternWallClockToUtcIso("2026-01-11", "20:20")).toBe("2026-01-12T01:20:00.000Z");
  });

  it("does not treat Eastern wall clock as UTC", () => {
    // The regression: appending Z shifted every kickoff by four or five hours.
    expect(easternWallClockToUtcIso("2025-09-07", "13:00")).not.toBe(
      "2025-09-07T13:00:00.000Z",
    );
  });

  it("defaults a missing time to midnight Eastern", () => {
    expect(easternWallClockToUtcIso("2025-09-07", "")).toBe("2025-09-07T04:00:00.000Z");
  });

  it("returns null for an unusable date", () => {
    expect(easternWallClockToUtcIso("", "13:00")).toBeNull();
    expect(easternWallClockToUtcIso("not-a-date", "13:00")).toBeNull();
  });

  it("round-trips back to the original Eastern wall clock", () => {
    for (const [day, time] of [
      ["2025-09-07", "13:00"],
      ["2025-11-30", "16:25"],
      ["2026-01-04", "20:20"],
    ] as const) {
      const iso = easternWallClockToUtcIso(day, time)!;
      const back = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso));
      expect(back).toContain(day);
      expect(back).toContain(time);
    }
  });
});

describe("parseContests", () => {
  const contests = parseContests(parseCsv(gamesCsv));

  it("parses the fixture", () => {
    expect(contests.length).toBeGreaterThan(100);
  });

  it("normalises teams and records results", () => {
    for (const contest of contests) {
      expect(contest.homeTeam).toMatch(/^[A-Z]{2,3}$/);
      expect(contest.awayTeam).toMatch(/^[A-Z]{2,3}$/);
      expect(contest.period.season).toBe(2025);
      if (contest.result) {
        expect(Number.isFinite(contest.result.homeScore)).toBe(true);
      }
    }
  });

  it("produces parseable UTC timestamps", () => {
    for (const contest of contests) {
      if (contest.startsAt === null) continue;
      expect(Number.isNaN(Date.parse(contest.startsAt))).toBe(false);
      expect(contest.startsAt.endsWith("Z")).toBe(true);
    }
  });
});

describe("parseMarketLines", () => {
  const lines = parseMarketLines(parseCsv(gamesCsv));

  it("returns a line for games that have one", () => {
    expect(lines.length).toBeGreaterThan(100);
  });

  it("omits an entry entirely rather than reporting a zero line", () => {
    // Conflating "no line" with "line of zero" would drag projections toward zero.
    for (const line of lines) {
      expect(line.total === null || Number.isFinite(line.total)).toBe(true);
    }
    const contestIds = new Set(parseContests(parseCsv(gamesCsv)).map((c) => c.id));
    for (const line of lines) expect(contestIds.has(line.contestId)).toBe(true);
  });
});

describe("NflverseProvider", () => {
  /** Serves fixtures instead of the network, so this never makes a request. */
  const fixtureFetcher = async (url: string) => {
    if (url === schedulesUrl()) return gamesCsv;
    if (url === weeklyStatsUrl(2025)) return statsCsv;
    throw new Error(`404 for ${url}`);
  };

  it("reads player weeks through the seam", async () => {
    const provider = new NflverseProvider(fixtureFetcher);
    const result = await provider.playerWeeks(2025);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.length).toBeGreaterThan(50);
  });

  it("degrades rather than throwing when a season is unavailable", async () => {
    const provider = new NflverseProvider(fixtureFetcher);
    const result = await provider.playerWeeks(2026);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("2026");
  });

  it("returns contests for a period", async () => {
    const provider = new NflverseProvider(fixtureFetcher);
    const result = await provider.contestsForPeriod({ season: 2025, index: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeGreaterThan(0);
      for (const contest of result.data) expect(contest.period.index).toBe(1);
    }
  });

  it("returns lines only for the contests asked for", async () => {
    const provider = new NflverseProvider(fixtureFetcher);
    const contests = await provider.contestsForPeriod({ season: 2025, index: 1 });
    if (!contests.ok) throw new Error("expected contests");
    const ids = contests.data.slice(0, 3).map((c) => c.id);
    const lines = await provider.linesForContests(ids);
    expect(lines.ok).toBe(true);
    if (lines.ok) {
      for (const line of lines.data) expect(ids).toContain(line.contestId);
    }
  });

  it("reports a schedule outage without throwing", async () => {
    const provider = new NflverseProvider(async () => {
      throw new Error("network down");
    });
    const result = await provider.allContests();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unavailable");
  });
});

describe("parseSeasonRoster", () => {
  const entries = parseSeasonRoster(parseCsv(rosterCsv));

  it("reads active players with a join key", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.playerId).not.toBe("");
      expect(entry.name).not.toBe("");
    }
  });

  it("drops players who are not active", () => {
    // Retired and cut players stay on the file. A draft board that offered them would be
    // recommending someone who will not take a snap.
    //
    // Named by id rather than counted. `entries.length < rows.length` is satisfied by any
    // row dropped for any reason — a missing gsis_id, a blank name — so it passed without
    // the status filter doing anything, and would still have passed had the fixture
    // contained no retired player at all.
    const retired = parseCsv(rosterCsv).filter(
      (r) => (r.status ?? "").toUpperCase() === "RET",
    );
    expect(retired.length).toBeGreaterThan(0);
    for (const row of retired) {
      expect(entries.some((e) => e.playerId === row.gsis_id)).toBe(false);
    }
  });

  it("drops rows with no gsis_id, which cannot be joined to any history", () => {
    // Without the join key a player has no production history, so the board would price
    // him from nothing at all.
    // On a constructed row. The captured fixture contains no active player missing a
    // `gsis_id`, so the previous form filtered to an empty list, ran its loop zero times
    // and passed without touching the filter — it would have passed with the filter
    // deleted.
    const header = "season,team,position,status,full_name,gsis_id";
    const csv = [
      header,
      "2026,KC,WR,ACT,No Join Key,",
      "2026,KC,WR,ACT,Has Join Key,00-0030300",
    ].join("\n");
    const parsed = parseSeasonRoster(parseCsv(csv));
    expect(parsed.map((e) => e.name)).toEqual(["Has Join Key"]);
  });

  it("keeps a traded player once rather than twice", () => {
    // The same active player on two teams in one release. The board is keyed by
    // (board, playerId), so both rows are written and the later silently wins — the team
    // shown is whichever the file listed last.
    const header = "season,team,position,status,full_name,gsis_id";
    const csv = [
      header,
      "2026,NYJ,RB,ACT,Traded Player,00-0030200",
      "2026,SF,RB,ACT,Traded Player,00-0030200",
    ].join("\n");
    const parsed = parseSeasonRoster(parseCsv(csv));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].team).toBe("NYJ");
  });

  it("normalises team codes and folds fullbacks into running backs", () => {
    for (const entry of entries) {
      if (entry.team !== null) expect(entry.team).toMatch(/^[A-Z]{2,3}$/);
      expect(entry.position).not.toBe("FB");
    }
  });

  it("folds a fullback into a running back", () => {
    // On a constructed row rather than the captured fixture, which contains no fullback —
    // so the assertion above that no entry has position FB was true of a file that never
    // had one, and would have stayed true with the folding removed. Not added to the
    // fixture because its value is that it is a real capture.
    const header =
      "season,team,position,depth_chart_position,jersey_number,status,full_name," +
      "first_name,last_name,birth_date,height,weight,college,gsis_id";
    const row =
      "2026,SF,FB,FB,44,ACT,Test Fullback,Test,Fullback,1991-04-23,185,235,Harvard,00-0030100";
    const [entry] = parseSeasonRoster(parseCsv(`${header}\n${row}`));
    expect(entry.position).toBe("RB");
    expect(entry.playerId).toBe("00-0030100");
  });

  it("builds the documented release url", () => {
    expect(seasonRosterUrl(2026)).toContain("/rosters/roster_2026.csv");
  });
});
