import { getFunctionName } from "convex/server";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { runProjectWeek } from "../ingest";
import { CURRENT_TEAMS } from "../../lib/nfl/teams";
import {
  NflverseProvider,
  schedulesUrl,
  weeklyRosterUrl,
  weeklyStatsUrl,
} from "../../lib/sources/nflverse";

/**
 * The team-coverage gate on `projectWeek`.
 *
 * The property under test is an *ordering*: no projection row may reach the database
 * unless coverage passed. That cannot be tested by inspecting the final state, because
 * the bug this guards against left the job marked failed while the rows it had already
 * written stayed live and served — `projections.forWeek` is public and filters on
 * neither job status nor freshness. So the test records the sequence of mutations and
 * asserts on what was attempted, not on what survived.
 */

const SEASON = 2025;
const TARGET_WEEK = 5;

/** The 32 real team codes, in pairs, so a full week is 16 games. */
const TEAMS: string[] = [...CURRENT_TEAMS];

function gamesCsv(): string {
  const header = [
    "game_id", "season", "game_type", "week", "gameday", "gametime",
    "away_team", "away_score", "home_team", "home_score",
    "spread_line", "total_line",
  ];
  const rows: string[][] = [];
  // Every team plays every week, pairing i with i+1. Scores are present for weeks
  // already played and blank for the target week, as upstream has them.
  for (let week = 1; week <= TARGET_WEEK; week += 1) {
    for (let i = 0; i < TEAMS.length; i += 2) {
      const away = TEAMS[i];
      const home = TEAMS[i + 1];
      const played = week < TARGET_WEEK;
      rows.push([
        `${SEASON}_${String(week).padStart(2, "0")}_${away}_${home}`,
        String(SEASON), "REG", String(week),
        `2025-09-${String(6 + week).padStart(2, "0")}`, "13:00",
        away, played ? "20" : "", home, played ? "24" : "",
        "-2.5", "44.5",
      ]);
    }
  }
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

/**
 * Weekly stats for weeks 1..TARGET_WEEK-1, covering only the first `teamCount` teams.
 *
 * A player's team is taken from a current-season appearance, so a team absent here has no
 * projectable player in the target week — which is exactly how real under-coverage
 * presents.
 */
function statsCsv(teamCount: number): string {
  const header = [
    "player_id", "player_name", "player_display_name", "position", "season", "week",
    "season_type", "team", "opponent_team",
    "receptions", "targets", "receiving_yards", "receiving_tds",
    "carries", "rushing_yards", "rushing_tds",
  ];
  const rows: string[][] = [];
  for (let t = 0; t < teamCount; t += 1) {
    const team = TEAMS[t];
    const opponent = TEAMS[t % 2 === 0 ? t + 1 : t - 1];
    for (const [slot, position] of (["WR", "RB"] as const).entries()) {
      for (let week = 1; week < TARGET_WEEK; week += 1) {
        rows.push([
          `00-000${t}${slot}`, `Player ${t}${slot}`, `Player ${t}${slot}`, position,
          String(SEASON), String(week), "REG", team, opponent,
          "5", "8", "60", "0", "2", "10", "0",
        ]);
      }
    }
  }
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

/** A provider serving the given stats, and 404ing prior seasons as upstream would. */
function providerFor(teamCount: number): NflverseProvider {
  const stats = statsCsv(teamCount);
  const games = gamesCsv();
  return new NflverseProvider(async (url) => {
    if (url === schedulesUrl()) return games;
    if (url === weeklyStatsUrl(SEASON)) return stats;
    // Prior seasons are genuinely absent here. The action tolerates that: players simply
    // have less history.
    throw new Error(`${url} responded 404`);
  });
}

/**
 * A week-1 provider: current-season week-1 rows establish teams, and history comes from a
 * prior season.
 *
 * `staleSeasonsBack` places the stale player's only appearance that many seasons before the
 * one being projected. Everyone else has history in `SEASON - 1`.
 */
function week1Provider(staleSeasonsBack: number): NflverseProvider {
  const header = [
    "player_id", "player_name", "player_display_name", "position", "season", "week",
    "season_type", "team", "opponent_team",
    "receptions", "targets", "receiving_yards", "receiving_tds",
  ];
  const rows: string[][] = [];
  const line = (id: string, season: number, week: number, team: string, opp: string) => [
    id, `P ${id}`, `P ${id}`, "WR", String(season), String(week), "REG", team, opp,
    "5", "8", "60", "0",
  ];

  // 30 of 32 teams have a healthy player: prior-season form plus a week-1 appearance.
  for (let t = 0; t < 30; t += 1) {
    const team = TEAMS[t];
    const opp = TEAMS[t % 2 === 0 ? t + 1 : t - 1];
    for (let w = 14; w <= 17; w += 1) rows.push(line(`ok${t}`, SEASON - 1, w, team, opp));
    rows.push(line(`ok${t}`, SEASON, 1, team, opp));
  }

  // The player under test: last seen `staleSeasonsBack` seasons ago, but present in this
  // week's stats file, so his team resolves and only the staleness rule can exclude him.
  rows.push(line("stale", SEASON - staleSeasonsBack, 17, TEAMS[0], TEAMS[1]));
  rows.push(line("stale", SEASON, 1, TEAMS[0], TEAMS[1]));

  const bySeason = new Map<number, string[][]>();
  for (const r of rows) {
    const season = Number(r[4]);
    bySeason.set(season, [...(bySeason.get(season) ?? []), r]);
  }
  const csv = (season: number) =>
    [header.join(","), ...(bySeason.get(season) ?? []).map((r) => r.join(","))].join("\n");

  const games = gamesCsv();
  return new NflverseProvider(async (url) => {
    if (url === schedulesUrl()) return games;
    for (const season of bySeason.keys()) {
      if (url === weeklyStatsUrl(season)) return csv(season);
    }
    throw new Error(`${url} responded 404`);
  });
}

/** Ids written for a run, across every batch. */
async function projectedIds(provider: NflverseProvider, week: number) {
  const { ctx, calls } = recordingCtx();
  await runProjectWeek(ctx, { season: SEASON, week }, provider);
  return new Set(
    projectionWrites(calls).flatMap((c) =>
      (c.args.rows as { playerId: string }[]).map((r) => r.playerId),
    ),
  );
}

interface Recorded {
  fn: string;
  args: Record<string, unknown>;
}

/**
 * A context that records every mutation instead of performing it.
 *
 * `jobs.start` must return an id; nothing else's return value is read.
 */
function recordingCtx() {
  const calls: Recorded[] = [];
  const ctx = {
    runMutation: async (
      ref: FunctionReference<"mutation", "internal">,
      args: Record<string, unknown>,
    ) => {
      // Resolves to "module:function", e.g. "projections:upsertBatch".
      calls.push({ fn: getFunctionName(ref), args });
      return "job_1";
    },
  } as unknown as Parameters<typeof runProjectWeek>[0];
  return { ctx, calls };
}

const projectionWrites = (calls: Recorded[]) =>
  calls.filter((c) => c.fn === "projections:upsertBatch");

const finishes = (calls: Recorded[]) => calls.filter((c) => c.fn === "jobs:finish");

describe("projectWeek team coverage", () => {
  it("writes nothing when too few teams have a projectable player", async () => {
    // Two of thirty-two teams — the shape of week 1, when only the Thursday opener has
    // been played and every other team's players have no current-season appearance.
    const { ctx, calls } = recordingCtx();
    const result = await runProjectWeek(
      ctx,
      { season: SEASON, week: TARGET_WEEK },
      providerFor(2),
    );

    expect(projectionWrites(calls)).toHaveLength(0);
    expect(result.projections).toBe(0);

    const finish = finishes(calls);
    expect(finish).toHaveLength(1);
    expect(finish[0].args.status).toBe("failed");
    // The operator has to be able to tell this apart from an empty upstream file.
    expect(String(finish[0].args.error)).toMatch(/Nothing was written/);
  });

  it("writes the board when coverage is complete", async () => {
    const { ctx, calls } = recordingCtx();
    const result = await runProjectWeek(
      ctx,
      { season: SEASON, week: TARGET_WEEK },
      providerFor(TEAMS.length),
    );

    expect(result.projections).toBeGreaterThan(0);
    expect(projectionWrites(calls).length).toBeGreaterThan(0);
    expect(finishes(calls)[0].args.status).toBe("succeeded");
  });

  it("writes a week-1 board once most of week 1 has been played", async () => {
    // Week 1 is not permanently unprojectable. Before kickoff no team resolves and the
    // coverage check keeps the board unpublished, but once the games are in the stats
    // file, teams resolve from current-season appearances and the run proceeds normally.
    const ids = await projectedIds(week1Provider(1), 1);
    expect(ids.size).toBeGreaterThan(0);
  });

  it("does not project a player who has been absent for a whole season", async () => {
    // The cross-season staleness rule, exercised through the real call site — which is the
    // only place the argument order of `weeksBetween` is observable. Reversing it makes
    // every gap negative and admits every stale player.
    //
    // `stale` last appeared in week 17 two seasons ago. Measured properly that is 20 weeks,
    // well past INACTIVITY_WEEKS; measured as though it were the immediately prior season
    // it is 2, and he is projected from form over a year old.
    const twoSeasons = await projectedIds(week1Provider(2), 1);
    expect(twoSeasons.has("stale")).toBe(false);

    // The control: the same player, same week of the *previous* season, is recent enough.
    const oneSeason = await projectedIds(week1Provider(1), 1);
    expect(oneSeason.has("stale")).toBe(true);
  });

  // The threshold itself, pinned from both sides. 90% of 32 teams is 28.8, so 29 covered
  // teams is the first passing count. Stating it as a test means a change to
  // MIN_TEAM_COVERAGE has to be deliberate rather than incidental.
  it("passes at the first count that clears the threshold", async () => {
    const { ctx, calls } = recordingCtx();
    const result = await runProjectWeek(
      ctx,
      { season: SEASON, week: TARGET_WEEK },
      providerFor(29),
    );

    expect(result.projections).toBeGreaterThan(0);
    expect(finishes(calls)[0].args.status).toBe("succeeded");
  });

  it("fails at the last count that does not", async () => {
    const { ctx, calls } = recordingCtx();
    const result = await runProjectWeek(
      ctx,
      { season: SEASON, week: TARGET_WEEK },
      providerFor(28),
    );

    // 28/32 = 0.875. Close enough to full coverage to look healthy in a dashboard, which
    // is exactly why the board must not be published from it.
    expect(result.projections).toBe(0);
    expect(projectionWrites(calls)).toHaveLength(0);
    expect(finishes(calls)[0].args.status).toBe("failed");
  });
});

/**
 * Week 1, before any game has been played — the state the README's known gap describes.
 *
 * Upstream publishes `stats_player_week_{season}.csv` only once games exist, so at this
 * point it 404s. Prior seasons are present, so the model has plenty of history; what it
 * has no source for is **which team each player is on now**, because that is derived from
 * a current-season appearance and there are none.
 */
function preKickoffWeek1Provider(withWeeklyRoster: boolean): NflverseProvider {
  const header = [
    "player_id", "player_name", "player_display_name", "position", "season", "week",
    "season_type", "team", "opponent_team",
    "receptions", "targets", "receiving_yards", "receiving_tds",
  ];
  const rows: string[][] = [];
  for (let t = 0; t < TEAMS.length; t += 1) {
    const team = TEAMS[t];
    const opp = TEAMS[t % 2 === 0 ? t + 1 : t - 1];
    // Four prior-season games each: history is not the problem.
    for (let w = 14; w <= 17; w += 1) {
      rows.push([
        `p${t}`, `P ${t}`, `P ${t}`, "WR", String(SEASON - 1), String(w), "REG", team, opp,
        "5", "8", "60", "0",
      ]);
    }
  }
  const priorCsv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");

  // The weekly roster: every player listed active on his team for week 1, before any game
  // has been played. This is the only source that can answer that.
  const rosterHeader = [
    "season", "team", "position", "status", "full_name", "gsis_id", "week", "game_type",
  ];
  const rosterRows = TEAMS.map((team, t) => [
    String(SEASON), team, "WR", "ACT", `P ${t}`, `p${t}`, "1", "REG",
  ]);
  const rosterCsv = [rosterHeader.join(","), ...rosterRows.map((r) => r.join(","))].join("\n");

  const games = gamesCsv();
  return new NflverseProvider(async (url) => {
    if (url === schedulesUrl()) return games;
    if (url === weeklyStatsUrl(SEASON - 1)) return priorCsv;
    if (withWeeklyRoster && url === weeklyRosterUrl(SEASON)) return rosterCsv;
    // The current season's file does not exist yet. This is the normal pre-kickoff state,
    // not a failure.
    throw new Error(`${url} responded 404`);
  });
}

describe("week 1 before kickoff", () => {
  it("without the weekly roster, nobody resolves a team and nothing is written", async () => {
    // The gap this issue closes, kept as a test rather than described in prose. Every one
    // of the 32 teams has a player with four games of prior-season history; the only thing
    // missing is a source for which team he is on now.
    const { ctx, calls } = recordingCtx();
    const result = await runProjectWeek(
      ctx,
      { season: SEASON, week: 1 },
      preKickoffWeek1Provider(false),
    );

    expect(result.unknownTeam).toBeGreaterThan(0);
    expect(result.projections).toBe(0);
    expect(projectionWrites(calls)).toHaveLength(0);

    const failure = finishes(calls).at(-1);
    expect(failure?.args.status).toBe("failed");
    expect(String(failure?.args.error)).toMatch(/no current-season appearance/);
  });

  it("with the weekly roster, the full board is written before kickoff", async () => {
    const { ctx, calls } = recordingCtx();
    const result = await runProjectWeek(
      ctx,
      { season: SEASON, week: 1 },
      preKickoffWeek1Provider(true),
    );

    // Nothing else changed: same history, same schedule, same 404 on the current season's
    // statistics. The only difference is a source for the team.
    expect(result.unknownTeam).toBe(0);
    expect(result.projections).toBeGreaterThan(0);
    expect(projectionWrites(calls).length).toBeGreaterThan(0);

    const finish = finishes(calls).at(-1);
    expect(finish?.args.status).toBe("succeeded");

    // And the board covers the whole league, not the two Thursday teams.
    const teams = new Set(
      projectionWrites(calls).flatMap((c) =>
        (c.args.rows as { team: string }[]).map((r) => r.team),
      ),
    );
    expect(teams.size).toBe(TEAMS.length);
  });

  it("does not project a player the weekly roster does not list as active", async () => {
    // A cut or practice-squad player is on the file and cannot start. Reading any status as
    // active would put a name on the board that no lineup can legitimately use.
    const rosterHeader = [
      "season", "team", "position", "status", "full_name", "gsis_id", "week", "game_type",
    ];
    const rosterRows = TEAMS.map((team, t) => [
      String(SEASON), team, "WR", t === 0 ? "CUT" : "ACT", `P ${t}`, `p${t}`, "1", "REG",
    ]);
    const rosterCsv = [rosterHeader.join(","), ...rosterRows.map((r) => r.join(","))].join("\n");

    const base = preKickoffWeek1Provider(true);
    const provider = new NflverseProvider(async (url) => {
      if (url === weeklyRosterUrl(SEASON)) return rosterCsv;
      // Reuse the base provider's fetcher for everything else.
      return (base as unknown as { fetchText: (u: string) => Promise<string> }).fetchText(url);
    });

    const ids = await projectedIds(provider, 1);
    expect(ids.has("p0")).toBe(false);
    expect(ids.has("p1")).toBe(true);
  });
});
