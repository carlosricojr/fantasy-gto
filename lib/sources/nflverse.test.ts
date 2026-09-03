import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "../nfl/csv";

import {
  NflverseProvider,
  parseDraftRoster,
  parseSeasonRoster,
  seasonRosterUrl,
  easternWallClockToUtcIso,
  parseContests,
  parseMarketLines,
  injuriesUrl,
  playersUrl,
  snapCountsUrl,
  schedulesUrl,
  weeklyRosterUrl,
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
const playersCsv = readFileSync(
  join(__dirname, "../../tests/fixtures/players_sample.csv"),
  "utf8",
);
const injuries2024Csv = readFileSync(
  join(__dirname, "../../tests/fixtures/injuries_2024_sample.csv"),
  "utf8",
);
const snaps2024Csv = readFileSync(
  join(__dirname, "../../tests/fixtures/snap_counts_2024_sample.csv"),
  "utf8",
);
const weeklyRosterCsv = readFileSync(
  join(__dirname, "../../tests/fixtures/roster_weekly_2025_sample.csv"),
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

  it("normalizes teams and records results", () => {
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

  it("shares one fetch and parse across concurrent contest calls", async () => {
    // The in-flight promise, not just the settled cache. With only the cache, two
    // concurrent callers both miss it and the whole schedule file is fetched and parsed
    // twice — `AdpProvider` documents the same discipline for the same reason.
    let fetches = 0;
    const provider = new NflverseProvider(async (url: string) => {
      if (url !== schedulesUrl()) throw new Error(`404 for ${url}`);
      fetches += 1;
      // A microtask boundary, so both calls are genuinely in flight together.
      await Promise.resolve();
      return gamesCsv;
    });
    const [first, second] = await Promise.all([
      provider.allContests(),
      provider.allContests(),
    ]);
    expect(fetches).toBe(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.data).toBe(first.data);
  });

  it("retries a failed contest fetch instead of caching the failure", async () => {
    // Only successes persist. One transient outage must not fail every later call for
    // the provider's lifetime — the exact trade `AdpProvider`'s cache documents.
    let attempts = 0;
    const provider = new NflverseProvider(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return gamesCsv;
    });
    const first = await provider.allContests();
    expect(first.ok).toBe(false);
    const second = await provider.allContests();
    expect(second.ok).toBe(true);
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

  it("keeps the provider bridge and rookie year where the roster supplies them", () => {
    const header = "season,team,position,status,full_name,gsis_id,sleeper_id,rookie_year";
    const [entry] = parseSeasonRoster(
      parseCsv(`${header}\n2026,CAR,WR,ACT,Rookie Receiver,00-0040000,123456,2026`),
    );
    expect(entry).toMatchObject({
      playerId: "00-0040000",
      sleeperId: "123456",
      rookieYear: 2026,
    });
  });

  it("drops players who are not active", () => {
    // Retired and cut players stay on the file. A draft board that offered them would be
    // recommending someone who will not take a snap.
    //
    // Named by id rather than counted. `entries.length < rows.length` is satisfied by any
    // row dropped for any reason — a missing gsis_id, a blank name — so it passed without
    // the status filter doing anything, and would still have passed had the fixture
    // contained no retired player at all.
    // Restricted to rows that carry a join key. A retired row with an empty `gsis_id`
    // satisfies the assertion below for the wrong reason — no entry has an empty
    // `playerId` either way — so only rows the *status* filter must drop are selected.
    const retired = parseCsv(rosterCsv).filter(
      (r) => (r.status ?? "").toUpperCase() === "RET" && (r.gsis_id ?? "") !== "",
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

  it("normalizes team codes and folds fullbacks into running backs", () => {
    for (const entry of entries) {
      if (entry.team !== null) expect(entry.team).toMatch(/^[A-Z]{2,3}$/);
      expect(entry.position).not.toBe("FB");
    }
  });

  it("normalizes a legacy team code to its canonical one", () => {
    // On a constructed row. The captured fixture is a current-season file, so it carries
    // only canonical codes — `/^[A-Z]{2,3}$/` accepts `OAK` and `STL` just as happily, and
    // the assertion above would pass with `normalizeTeam` deleted outright.
    const header = "season,team,position,status,full_name,gsis_id";
    const rows = [
      "2026,OAK,RB,ACT,Legacy Raider,00-0030400",
      "2026,STL,WR,ACT,Legacy Ram,00-0030401",
    ];
    const parsed = parseSeasonRoster(parseCsv([header, ...rows].join("\n")));
    expect(parsed.map((e) => e.team)).toEqual(["LV", "LA"]);
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

describe("parseDraftRoster", () => {
  it("keeps active, reserve and exempt players recordable without recommending their status", () => {
    const csv = [
      "season,team,position,status,full_name,gsis_id,sleeper_id,rookie_year",
      "2026,GB,RB,EXE,Exempt Veteran,00-0041000,7001,2020",
      "2026,SEA,RB,RES,Pup Veteran,00-0041001,7002,2023",
      "2026,KC,WR,ACT,Active Player,00-0041002,7003,2026",
    ].join("\n");
    const report = parseDraftRoster(parseCsv(csv));
    expect(report.entries.map((entry) => [entry.name, entry.status])).toEqual([
      ["Exempt Veteran", "reserve"],
      ["Pup Veteran", "reserve"],
      ["Active Player", "active"],
    ]);
  });

  it("does not report documented current-season inactive codes as source drift", () => {
    const csv = [
      "season,team,position,status,full_name,gsis_id",
      "2026,SF,WR,RLS,Left Squad Player,00-0041010",
      "2026,SEA,RB,PUP,Physically Unable Player,00-0041011",
      "2026,NO,WR,SUS,Suspended Player,00-0041012",
      "2026,CLE,TE,RSN,Non Football Injury Player,00-0041013",
      "2026,ATL,WR,RSR,Reserve Player,00-0041014",
    ].join("\n");
    const report = parseDraftRoster(parseCsv(csv));
    expect(report.entries.every((entry) => entry.status !== "active")).toBe(true);
    expect([...report.unknownStatus]).toEqual([]);
  });

  it("keeps an active player without GSIS by a stable provider id", () => {
    const csv = [
      "season,team,position,status,full_name,gsis_id,sleeper_id",
      "2026,KC,K,ACT,Unpriced Kicker,,9988",
    ].join("\n");
    const [entry] = parseDraftRoster(parseCsv(csv)).entries;
    expect(entry.playerId).toBe("sleeper:9988");
    expect(entry.gsisId).toBeNull();
    expect(parseSeasonRoster(parseCsv(csv))).toEqual([]);
  });

  it("surfaces an upstream status code it does not understand", () => {
    const csv = [
      "season,team,position,status,full_name,gsis_id",
      "2026,KC,WR,W04,New Designation,00-0041004",
    ].join("\n");
    const report = parseDraftRoster(parseCsv(csv));
    expect(report.entries[0]).toMatchObject({
      status: "unknown",
      statusCode: "W04",
    });
    expect(report.unknownStatus.get("W04")).toBe(1);
  });

  it("lets an active transaction row win over an inactive duplicate", () => {
    const csv = [
      "season,team,position,status,full_name,gsis_id",
      "2026,NYJ,WR,TRD,Moving Player,00-0041005",
      "2026,SF,WR,ACT,Moving Player,00-0041005",
    ].join("\n");
    expect(parseDraftRoster(parseCsv(csv)).entries).toHaveLength(1);
    expect(parseDraftRoster(parseCsv(csv)).entries[0]).toMatchObject({
      team: "SF",
      status: "active",
    });
  });
});

describe("NflverseProvider.players", () => {
  const serve = (body: string) => async (url: string) => {
    if (url === playersUrl()) return body;
    throw new Error(`unexpected url ${url}`);
  };

  it("parses the directory and exposes the pfr bridge", async () => {
    const provider = new NflverseProvider(serve(playersCsv));
    const result = await provider.players();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(9);
    expect(result.data.find((p) => p.playerId === "00-0032104")?.pfrId).toBe("AbduAm00");
  });

  it("fetches once and serves the rest from cache", async () => {
    // One multi-megabyte download shared by every caller that needs an age or a bridge
    // lookup. Without this it is re-fetched per use and dominates the cost of any run.
    let calls = 0;
    const provider = new NflverseProvider(async (url) => {
      calls += 1;
      if (url === playersUrl()) return playersCsv;
      throw new Error(`unexpected url ${url}`);
    });
    await provider.players();
    await provider.players();
    expect(calls).toBe(1);
  });

  it("coalesces concurrent callers into one download", async () => {
    // The settled result being cached is not enough: callers here are concurrent by
    // construction — one action builds many boards at once — and without sharing the
    // in-flight promise each of them starts its own download of the same multi-megabyte
    // file before the first has resolved.
    let calls = 0;
    const provider = new NflverseProvider(async (url) => {
      calls += 1;
      // Resolve on a later tick so all four callers are genuinely in flight together.
      await Promise.resolve();
      if (url === playersUrl()) return playersCsv;
      throw new Error(`unexpected url ${url}`);
    });
    const results = await Promise.all([
      provider.players(),
      provider.players(),
      provider.players(),
      provider.players(),
    ]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("returns a failure rather than throwing past the seam", async () => {
    const provider = new NflverseProvider(async () => {
      throw new Error("network down");
    });
    const result = await provider.players();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/player directory is unavailable/i);
  });

  it("refuses a file that parses cleanly to nothing", async () => {
    // HTTP 200 with a valid header and no usable rows is a real shape in these releases —
    // snap_counts_2012.csv is exactly that — and reporting success would leave every caller
    // concluding the league has no players.
    const headerOnly = `${playersCsv.split("\n")[0]}\n`;
    const provider = new NflverseProvider(serve(headerOnly));
    const result = await provider.players();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no players with a gsis_id/i);
  });

  it("does not cache a failure", async () => {
    // A transient blip cached for the provider's lifetime turns one bad fetch into every
    // later call failing too.
    let attempt = 0;
    const provider = new NflverseProvider(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("blip");
      return playersCsv;
    });
    expect((await provider.players()).ok).toBe(false);
    expect((await provider.players()).ok).toBe(true);
  });
});

describe("NflverseProvider.injuries", () => {
  it("parses a season and surfaces the unrecognised-value counts", async () => {
    const provider = new NflverseProvider(async (url) => {
      if (url === injuriesUrl(2024)) return injuries2024Csv;
      throw new Error(`unexpected url ${url}`);
    });
    const result = await provider.injuries(2024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.reports).toHaveLength(7);
    // Surfaced rather than folded away: a new designation upstream must be visible.
    expect(result.data.unknownGameStatus.get("Note")).toBe(1);
  });

  it("refuses a season that parsed to no regular-season rows", async () => {
    // This is the shape the season_type/game_type drift produces. Reporting success on it
    // yields a confident result built from nothing, which has already cost one debugging
    // cycle on this project.
    const headerOnly = `${injuries2024Csv.split("\n")[0]}\n`;
    const provider = new NflverseProvider(async () => headerOnly);
    const result = await provider.injuries(2024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no regular-season rows/i);
    expect(result.reason).toMatch(/header shape has drifted/i);
  });

  it("refuses a season in which no row carries any designation", async () => {
    // The row count catches a renamed `game_type`; it cannot catch a renamed
    // `report_status`, because an absent column reads as blank and blank is legitimately
    // "no designation". Thousands of rows in which nobody was ever listed Out is the
    // clean-looking result built from nothing this seam exists to refuse.
    const rows = parseCsv(injuries2024Csv);
    const header = Object.keys(rows[0])
      .map((c) => (c === "report_status" ? "game_status" : c))
      .join(",");
    const body = rows
      .map((r) =>
        Object.keys(rows[0])
          .map((c) => (c === "practice_status" || c === "report_status" ? "" : String(r[c] ?? "")))
          .join(","),
      )
      .join("\n");
    const provider = new NflverseProvider(async () => `${header}\n${body}\n`);
    const result = await provider.injuries(2024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no designation on any of them/i);
    expect(result.reason).toMatch(/probably been renamed/i);
  });

  it("coalesces concurrent callers for one season into a single download", async () => {
    let calls = 0;
    const provider = new NflverseProvider(async (url) => {
      calls += 1;
      await Promise.resolve();
      if (url === injuriesUrl(2024)) return injuries2024Csv;
      throw new Error(`unexpected url ${url}`);
    });
    const results = await Promise.all([
      provider.injuries(2024),
      provider.injuries(2024),
      provider.injuries(2024),
    ]);
    expect(calls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("caches per season and does not cache a failure", async () => {
    let calls = 0;
    const provider = new NflverseProvider(async (url) => {
      calls += 1;
      if (calls === 1) throw new Error("blip");
      if (url === injuriesUrl(2024)) return injuries2024Csv;
      throw new Error(`unexpected url ${url}`);
    });
    expect((await provider.injuries(2024)).ok).toBe(false);
    expect((await provider.injuries(2024)).ok).toBe(true);
    await provider.injuries(2024);
    expect(calls).toBe(2);
  });
});

describe("NflverseProvider.snapCounts", () => {
  it("parses a season", async () => {
    const provider = new NflverseProvider(async (url) => {
      if (url === snapCountsUrl(2024)) return snaps2024Csv;
      throw new Error(`unexpected url ${url}`);
    });
    const result = await provider.snapCounts(2024);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(5);
  });

  it("refuses an empty release rather than reporting no snaps taken", async () => {
    // HTTP 200, valid sixteen-column header, zero rows — the shape the 2012 asset actually
    // has, and the reason the development window floor moved to 2013. The message names the
    // season and points at the document; which seasons are populated is a measurement that
    // belongs there, not baked into an error string where it would go stale on a backfill.
    const headerOnly = `${snaps2024Csv.split("\n")[0]}\n`;
    const provider = new NflverseProvider(async () => headerOnly);
    const result = await provider.snapCounts(2012);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/2012/);
    expect(result.reason).toMatch(/no regular-season rows/i);
    expect(result.reason).toMatch(/docs\/data-sources\.md/);
  });

  it("coalesces concurrent callers and does not cache a failure", async () => {
    let calls = 0;
    const provider = new NflverseProvider(async (url) => {
      calls += 1;
      await Promise.resolve();
      if (calls === 1) throw new Error("blip");
      if (url === snapCountsUrl(2024)) return snaps2024Csv;
      throw new Error(`unexpected url ${url}`);
    });
    expect((await provider.snapCounts(2024)).ok).toBe(false);
    const results = await Promise.all([
      provider.snapCounts(2024),
      provider.snapCounts(2024),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("NflverseProvider.weeklyRoster", () => {
  const serve = (body: string) => async (url: string) => {
    if (url === weeklyRosterUrl(2025)) return body;
    throw new Error(`unexpected url ${url}`);
  };

  it("parses a season and surfaces the drift counter", async () => {
    const provider = new NflverseProvider(serve(weeklyRosterCsv));
    const result = await provider.weeklyRoster(2025);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries).toHaveLength(7);
    expect([...result.data.unknownStatus.keys()]).toEqual([]);
  });

  it("refuses a file with rows but nobody active", async () => {
    // The payload-level failure a row count cannot see. Every player would be skipped and
    // the week would look uncovered for a reason that is not true — the same shape the
    // injury seam refuses, and for the same reason.
    //
    // Built from scratch rather than by rewriting the fixture's status column. The first
    // attempt re-emitted the parsed fixture by joining its values with commas, which
    // corrupts it: `roster_weekly` carries `headshot_url`, and those contain commas. That
    // is the precise defect `lib/nfl/csv.ts` exists to prevent, reintroduced inside a test
    // written to check a different failure — and it presented as the wrong error message
    // rather than as anything obviously broken.
    const csv = [
      "season,team,position,status,full_name,gsis_id,week,game_type",
      "2025,SF,WR,DEV,Practice Squad Player,00-0000001,1,REG",
      "2025,MIN,RB,RES,Injured Player,00-0000002,1,REG",
    ].join("\n");
    const provider = new NflverseProvider(serve(`${csv}\n`));
    const result = await provider.weeklyRoster(2025);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no active player among them/i);
    expect(result.reason).toMatch(/renamed or recoded/i);
  });

  it("refuses an empty release", async () => {
    const headerOnly = `${weeklyRosterCsv.split("\n")[0]}\n`;
    const provider = new NflverseProvider(serve(headerOnly));
    const result = await provider.weeklyRoster(2025);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no regular-season rows/i);
  });

  it("coalesces concurrent callers and does not cache a failure", async () => {
    let calls = 0;
    const provider = new NflverseProvider(async (url) => {
      calls += 1;
      await Promise.resolve();
      if (calls === 1) throw new Error("blip");
      if (url === weeklyRosterUrl(2025)) return weeklyRosterCsv;
      throw new Error(`unexpected url ${url}`);
    });
    expect((await provider.weeklyRoster(2025)).ok).toBe(false);
    const results = await Promise.all([
      provider.weeklyRoster(2025),
      provider.weeklyRoster(2025),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toBe(2);
  });
});
