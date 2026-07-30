import { getFunctionName } from "convex/server";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";

import { runProjectWeek } from "../ingest";
import { CURRENT_TEAMS } from "../../lib/nfl/teams";
import { NflverseProvider, schedulesUrl, weeklyStatsUrl } from "../../lib/sources/nflverse";

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

  it("orders every projection write after the coverage decision", async () => {
    // The regression guard. Coverage passes here, so rows are written — what matters is
    // that none of them was attempted before the run had enough evidence to decide, which
    // is what made the failing case silently serve a partial board.
    const { ctx, calls } = recordingCtx();
    await runProjectWeek(ctx, { season: SEASON, week: TARGET_WEEK }, providerFor(TEAMS.length));

    const writes = projectionWrites(calls);
    expect(writes.length).toBeGreaterThan(0);

    // Every projection write carries rows for the target week only, and the first of them
    // comes after all stats have been consumed. Asserting the count matches the reported
    // total proves nothing was flushed early and then re-counted.
    const written = writes.reduce(
      (sum, c) => sum + (c.args.rows as unknown[]).length,
      0,
    );
    const result = await runProjectWeek(
      recordingCtx().ctx,
      { season: SEASON, week: TARGET_WEEK },
      providerFor(TEAMS.length),
    );
    expect(written).toBe(result.projections);
  });
});
