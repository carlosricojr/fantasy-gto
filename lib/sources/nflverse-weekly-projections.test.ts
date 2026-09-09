import { describe, expect, it } from "vitest";
import { buildNflverseWeeklyEstimates, generateNflverseWeeklyProjections, nflverseWeeklyScoring, type NflverseWeeklyInputs, type NflverseWeeklyRequest } from "./nflverse-weekly-projections";
import { parseSleeperScoring } from "../nfl/scoring/sleeper";
import { toPlayerWeek } from "../nfl/stats/parse";
import { NflverseProvider } from "./nflverse";

const rules = parseSleeperScoring({ pass_yd: 0.04, pass_td: 6, pass_int: -2, rush_yd: 0.1, rush_td: 6,
  rec: 0.5, rec_yd: 0.1, rec_td: 6, fum_lost: -2, pass_2pt: 2, rec_2pt: 2, rush_2pt: 2,
  st_td: 6, st_ff: 1 });
if (!rules.ok) throw new Error("Invalid test profile");
const request: NflverseWeeklyRequest = { season: 2026, week: 1, playerIds: ["5844"], profile: rules.profile,
  now: Date.parse("2026-09-09T15:00:00Z") };
function inputs(): NflverseWeeklyInputs {
  return {
    history: [15, 16, 17, 18].map(week => toPlayerWeek({ player_id: "gsis-1", player_display_name: "Test TE",
      season: "2025", week: String(week), season_type: "REG", position: "TE", team: "MIN", opponent_team: "GB",
      receiving_yards: "70", receptions: "6", receiving_tds: "1", targets: "8" })!),
    roster: [{ playerId: "gsis-1", sleeperId: "5844", name: "Test TE", position: "TE", team: "MIN", rookieYear: 2019 }],
    weeklyRoster: [{ playerId: "gsis-1", season: 2026, week: 1, name: "Test TE", position: "TE", team: "MIN", status: "active" }],
    injuries: [], contests: [{ id: "game", period: { season: 2026, index: 1 }, homeTeam: "MIN", awayTeam: "GB",
      startsAt: "2026-09-13T17:00:00Z", result: null }], lines: [],
  };
}
describe("nflverse personal weekly estimates", () => {
  it("generates an estimate under imported offensive coefficients and names every omitted rule", () => {
    const result = buildNflverseWeeklyEstimates(request, inputs());
    expect(result.players[0].points).toBeGreaterThan(10);
    expect(result.coverage).toEqual({ requested: 1, projected: 1 });
    expect(result.excludedRules).toEqual(["st_ff"]);
    expect(result.providerUpdatedAt).toBeNull();
    expect(result.computedAt).toBe(request.now);
    expect(result.warnings.some(warning => warning.includes("not a full custom-scoring projection"))).toBe(true);
    expect(nflverseWeeklyScoring(request.profile).scoring.offense.passingTd).toBe(6);
  });
  it("never lets target/future weeks or older history alter this estimate", () => {
    const data = inputs();
    const expected = buildNflverseWeeklyEstimates(request, data).players;
    data.history = [...data.history, ...[2023, 2026, 2027].map(season => ({ ...data.history[0], period: { season, index: 1 },
      stats: { ...data.history[0].stats, receivingYards: 9000 } }))];
    expect(buildNflverseWeeklyEstimates(request, data).players).toEqual(expected);
  });
  it.each(["no identity", "ambiguous identity", "no weekly roster", "inactive", "started", "unknown kickoff", "no game", "little history", "old history", "kicker"])("reports unavailable %s without zero imputation", cause => {
    const data = inputs();
    if (cause === "no identity") data.roster = [];
    if (cause === "ambiguous identity") data.roster = [...data.roster, { ...data.roster[0], playerId: "gsis-2" }];
    if (cause === "no weekly roster") data.weeklyRoster = [];
    if (cause === "inactive") data.weeklyRoster = [{ ...data.weeklyRoster[0], status: "reserve" }];
    if (cause === "started") data.contests = [{ ...data.contests[0], startsAt: "2026-09-08T00:00:00Z" }];
    if (cause === "unknown kickoff") data.contests = [{ ...data.contests[0], startsAt: null }];
    if (cause === "no game") data.contests = [];
    if (cause === "little history") data.history = data.history.slice(0, 3);
    if (cause === "old history") data.history = data.history.map(row => ({ ...row, period: { season: 2024, index: row.period.index } }));
    if (cause === "kicker") data.weeklyRoster = [{ ...data.weeklyRoster[0], position: "K" }];
    const result = buildNflverseWeeklyEstimates(request, data);
    expect(result.players[0].points).toBeNull();
    expect(result.players[0].reason).toBeTruthy();
  });
  it("requires explicit current injury eligibility", () => {
    const data = inputs();
    data.injuries = [{ season: 2026, week: 1, playerId: "gsis-1", name: "Test TE", position: "TE", team: "MIN",
      gameStatus: "out", practiceStatus: "none", primaryInjury: "Knee", dateModified: null }];
    expect(buildNflverseWeeklyEstimates(request, data).players[0].points).toBeNull();
  });
  it("retains valid zero and negative model means after the history gate", () => {
    const parsed = parseSleeperScoring({ rec_yd: -0.1 });
    if (!parsed.ok) throw new Error("Bad fixture");
    const data = inputs();
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, data).players[0].points).toBeLessThan(0);
    data.history = data.history.map(row => ({ ...row, stats: { ...row.stats, receivingYards: 0 },
      usage: { ...row.usage, targets: 0 } }));
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, data).players[0].points).toBe(0);
  });
  it("does not run the model when every offensive scoring term is unsupported", () => {
    const parsed = parseSleeperScoring({ st_ff: 1 });
    if (!parsed.ok) throw new Error("Bad fixture");
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, inputs()).players[0])
      .toMatchObject({ points: null, reason: "No supported offensive scoring rules" });
  });
  it("does not silently combine unequal two-point coefficients", () => {
    const parsed = parseSleeperScoring({ rec: 0.5, pass_2pt: 1, rush_2pt: 2, rec_2pt: 2 });
    if (!parsed.ok) throw new Error("Bad fixture");
    const converted = nflverseWeeklyScoring(parsed.profile);
    expect(converted.scoring.offense.twoPointConversion).toBe(0);
    expect(converted.excludedRules).toEqual(["pass_2pt", "rush_2pt", "rec_2pt"]);
  });
  it("rejects oversized or invalid requests before fetching", async () => {
    let requests = 0;
    const provider = new NflverseProvider(async () => { requests++; throw new Error("network should not run"); });
    expect((await generateNflverseWeeklyProjections({ ...request, playerIds: Array.from({ length: 101 }, String) }, provider)).ok).toBe(false);
    expect((await generateNflverseWeeklyProjections({ ...request, week: 19 }, provider)).ok).toBe(false);
    expect(requests).toBe(0);
  });
});
