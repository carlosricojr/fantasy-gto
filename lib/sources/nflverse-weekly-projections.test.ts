import { describe, expect, it } from "vitest";
import { buildNflverseWeeklyEstimates, generateNflverseWeeklyProjections, nflverseWeeklyIdentities, nflverseWeeklyScoring, type NflverseWeeklyInputs, type NflverseWeeklyRequest } from "./nflverse-weekly-projections";
import { parseSleeperScoring } from "../nfl/scoring/sleeper";
import { toPlayerWeek } from "../nfl/stats/parse";
import { NflverseProvider, parseDraftRoster } from "./nflverse";
import { parseNflverseKickingWeeks } from "./nflverse-kicking";

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
    weeklyRoster: [{ playerId: "gsis-1", sleeperId: "5844", season: 2026, week: 1, name: "Test TE", position: "TE", team: "MIN", status: "active" }],
    injuries: [{ season: 2026, week: 1, playerId: "other", name: "Other player", position: "TE", team: "MIN",
      gameStatus: "questionable", practiceStatus: "limited", primaryInjury: "Knee", dateModified: null }],
    contests: [{ id: "game", period: { season: 2026, index: 1 }, homeTeam: "MIN", awayTeam: "GB",
      startsAt: "2026-09-13T17:00:00Z", result: null }], lines: [],
  };
}
describe("nflverse personal weekly estimates", () => {
  it("rejects explicit season/weekly identity conflicts even for ordinary estimates", () => {
    const data = inputs();
    for (const weeklyRoster of [
      [...data.weeklyRoster, { ...data.weeklyRoster[0], playerId: "other", team: "BAL" }],
      [{ ...data.weeklyRoster[0], sleeperId: "different" }],
    ]) {
      const row = buildNflverseWeeklyEstimates(request, { ...data, weeklyRoster }).players[0];
      expect(row).toMatchObject({ points: null, availability: "unknown", reason: "Current weekly and season-roster player identities conflict" });
    }
  });
  it("requires a direct current-week bridge for experimental values, without changing legacy ordinary missing-bridge behavior", () => {
    const data = inputs(); data.weeklyRoster = data.weeklyRoster.map(row => ({ ...row, sleeperId: undefined }));
    expect(buildNflverseWeeklyEstimates(request, data).players[0].points).not.toBeNull();
    data.history = data.history.map((row, i) => ({ ...row, period: { season: 2025, index: 7 + i } }));
    expect(buildNflverseWeeklyEstimates({ ...request, includeExperimentalEstimates: true }, data).players[0].experimentalEstimate).toBeUndefined();
  });
  it.each([5, 9])("offers gap-%s returning history only as an independent experimental opt-in", gap => {
    const data = inputs();
    data.injuries = [];
    data.history = data.history.map((row, i) => ({ ...row, period: { season: 2025, index: 16 - gap + i } }));
    const conditional = { ...request, includeConditionalEstimates: true };
    expect(buildNflverseWeeklyEstimates(conditional, data).players[0].experimentalEstimate).toBeUndefined();
    const result = buildNflverseWeeklyEstimates({ ...request, includeExperimentalEstimates: true }, data);
    expect(result.players[0]).toMatchObject({ points: null, injuryCoverage: "unavailable", experimentalEstimate: {
      version: 1, method: "frozen-model-returning-history", condition: "active-at-kickoff", historyGames: 4,
      historyGapWeeks: gap, calibration: "ppr-only", excludedRules: ["st_ff"], evidence: "exploratory-development-tuning",
    } });
    expect(result.players[0].conditionalEstimate).toBeUndefined();
    expect(result.coverage.projected).toBe(0);
    expect(buildNflverseWeeklyEstimates({ ...conditional, includeExperimentalEstimates: true }, data).players).toEqual(result.players);
  });
  it("experimental consent alone does not widen ordinary/provisional coverage", () => {
    const data = inputs(); data.injuries = [];
    const result = buildNflverseWeeklyEstimates({ ...request, includeExperimentalEstimates: true }, data);
    expect(result.players[0]).toMatchObject({ points: null });
    expect(result.players[0].conditionalEstimate).toBeUndefined();
    expect(result.players[0].experimentalEstimate).toBeUndefined();
    expect(buildNflverseWeeklyEstimates({ ...request, includeExperimentalEstimates: true }, inputs()).players)
      .toEqual(buildNflverseWeeklyEstimates(request, inputs()).players);
  });
  it.each(["no identity", "ambiguous identity", "unknown roster", "out", "unknown injury", "little history", "older season", "duplicate history", "position changed", "started", "unknown kickoff", "no game", "week 2", "penalty only"])("never relaxes the experimental returning guard for %s", cause => {
    const data = inputs();
    data.injuries = [];
    data.history = data.history.map((row, i) => ({ ...row, period: { season: 2025, index: 7 + i } }));
    let profile = request.profile;
    if (cause === "no identity") data.roster = [];
    if (cause === "ambiguous identity") data.roster = [...data.roster, { ...data.roster[0], playerId: "other" }];
    if (cause === "unknown roster") data.weeklyRoster = [{ ...data.weeklyRoster[0], status: "unknown" }];
    if (cause === "out" || cause === "unknown injury") data.injuries = [{ ...inputs().injuries[0], playerId: "gsis-1", gameStatus: cause === "out" ? "out" : "unknown" }];
    if (cause === "little history") data.history = data.history.slice(0, 3);
    if (cause === "older season") data.history = data.history.map(row => ({ ...row, period: { ...row.period, season: 2024 } }));
    if (cause === "duplicate history") data.history = [...data.history, data.history[0]];
    if (cause === "position changed") data.weeklyRoster = [{ ...data.weeklyRoster[0], position: "WR" }];
    if (cause === "started") data.contests = [{ ...data.contests[0], startsAt: "2026-09-08T00:00:00Z" }];
    if (cause === "unknown kickoff") data.contests = [{ ...data.contests[0], startsAt: null }];
    if (cause === "no game") data.contests = [];
    if (cause === "penalty only") { const parsed = parseSleeperScoring({ pass_td: 6, rec_yd: -1 }); if (!parsed.ok) throw new Error("Bad fixture"); profile = parsed.profile; }
    if (cause === "week 2") { data.weeklyRoster = data.weeklyRoster.map(row => ({ ...row, week: 2 })); data.contests = data.contests.map(row => ({ ...row, period: { season: 2026, index: 2 } })); }
    const row = buildNflverseWeeklyEstimates({ ...request, profile, week: cause === "week 2" ? 2 : 1, includeExperimentalEstimates: true }, data).players[0];
    expect(row.points).toBeNull(); expect(row.experimentalEstimate).toBeUndefined(); expect(row.conditionalEstimate).toBeUndefined();
  });
  it("preserves negative and zero returning-model values, with ordinary points still absent", () => {
    const parsed = parseSleeperScoring({ rec_yd: -0.1, rec_td: 0.01 });
    if (!parsed.ok) throw new Error("Bad fixture");
    const data = inputs(); data.injuries = [];
    data.history = data.history.map((row, i) => ({ ...row, period: { season: 2025, index: 7 + i } }));
    const opted = { ...request, profile: parsed.profile, includeExperimentalEstimates: true };
    expect(buildNflverseWeeklyEstimates(opted, data).players[0].experimentalEstimate?.points).toBeLessThan(0);
    data.history = data.history.map(row => ({ ...row, stats: { ...row.stats, receivingYards: 0, receivingTds: 0 }, usage: { ...row.usage, targets: 0 } }));
    expect(buildNflverseWeeklyEstimates(opted, data).players[0]).toMatchObject({ points: null, experimentalEstimate: { points: 0 } });
  });
  it("offers an explicit kicking-events baseline without ordinary points or injury clearance", () => {
    const data = inputs(); data.injuries = [];
    data.weeklyRoster = [{ ...data.weeklyRoster[0], position: "K" }];
    data.kickingHistory = parseNflverseKickingWeeks(Array.from({ length: 9 }, (_, i) => ({ player_id: "gsis-1", position: "K", season: "2025", season_type: "REG", week: String(i + 10),
      fg_made_0_19: "0", fg_made_20_29: "1", fg_made_30_39: "0", fg_made_40_49: "0", fg_made_50_59: "0", fg_made_60_: "0", fg_missed: "0", pat_made: "2", pat_missed: "0" })), 2025);
    const parsed = parseSleeperScoring({ fgm_20_29: 3, xpm: 1, st_ff: 1 }); if (!parsed.ok) throw new Error("Bad fixture");
    const opted = { ...request, profile: parsed.profile, includeExperimentalEstimates: true };
    expect(buildNflverseWeeklyEstimates(opted, data).players[0]).toMatchObject({ points: null, injuryCoverage: "unavailable", experimentalEstimate: { points: 5, method: "kicker-prior-season-game-mean", calibration: "none", excludedRules: ["st_ff"] } });
    for (const gameStatus of ["out", "unknown"] as const) {
      data.injuries = [{ ...inputs().injuries[0], playerId: "gsis-1", gameStatus }];
      expect(buildNflverseWeeklyEstimates(opted, data).players[0].experimentalEstimate).toBeUndefined();
    }
  });
  it("rejects nonboolean experimental requests before source I/O", async () => {
    const result = await generateNflverseWeeklyProjections({ ...request, includeExperimentalEstimates: "yes" as unknown as boolean }, new NflverseProvider(() => { throw new Error("Unexpected I/O"); }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("Invalid");
  });
  it("exposes partial injury source evidence without changing estimate coverage", () => {
    const result = buildNflverseWeeklyEstimates(request, inputs());
    expect(result.injurySource).toMatchObject({ season: 2026, week: 1, reportRows: 1,
      reportedTeams: ["MIN"], latestRowUpdatedAt: null, freshness: "unknown", scope: "reported-rows-only" });
    expect(result.warnings.some(warning => warning.includes("1 reported rows across 1 teams"))).toBe(true);
    expect(result.players[0].points).not.toBeNull();
  });
  it("keeps conditional-on-active forecasts behind an explicit opt-in and separate value", () => {
    const data = inputs();
    data.injuries = [];
    for (const includeConditionalEstimates of [undefined, false]) {
      const row = buildNflverseWeeklyEstimates({ ...request, includeConditionalEstimates }, data).players[0];
      expect(row.points).toBeNull();
      expect(row.conditionalEstimate).toBeUndefined();
    }
    const result = buildNflverseWeeklyEstimates({ ...request, includeConditionalEstimates: true }, data);
    expect(result.players[0]).toMatchObject({ points: null, availability: "active", injuryCoverage: "unavailable",
      conditionalEstimate: { points: expect.any(Number), condition: "active-at-kickoff", missingEvidence: "team-injury-report" } });
    expect(result.coverage.projected).toBe(0);
    expect(result.excludedRules).toEqual(["st_ff"]);
    expect(result.warnings.some(warning => warning.includes("not availability-adjusted"))).toBe(true);
    const covered = buildNflverseWeeklyEstimates({ ...request, includeConditionalEstimates: true }, inputs());
    expect(covered.players[0].points).not.toBeNull();
    expect(covered.players[0].conditionalEstimate).toBeUndefined();
  });
  it.each(["no identity", "ambiguous identity", "unknown roster", "out", "unknown injury", "little history", "old history", "started", "unknown kickoff", "no game", "kicker", "unsupported scoring"])("does not issue conditional forecasts with %s", cause => {
    const data = inputs();
    data.injuries = [];
    let profile = request.profile;
    if (cause === "no identity") data.roster = [];
    if (cause === "ambiguous identity") data.roster = [...data.roster, { ...data.roster[0], playerId: "other" }];
    if (cause === "unknown roster") data.weeklyRoster = [{ ...data.weeklyRoster[0], status: "unknown" }];
    if (cause === "out" || cause === "unknown injury") data.injuries = [{ season: 2026, week: 1, playerId: "gsis-1",
      name: "Test TE", position: "TE", team: "GB", gameStatus: cause === "out" ? "out" : "unknown",
      practiceStatus: "none", primaryInjury: "Knee", dateModified: null }];
    if (cause === "little history") data.history = data.history.slice(0, 3);
    if (cause === "old history") data.history = data.history.map(row => ({ ...row, period: { season: 2024, index: row.period.index } }));
    if (cause === "started") data.contests = [{ ...data.contests[0], startsAt: "2026-09-08T00:00:00Z" }];
    if (cause === "unknown kickoff") data.contests = [{ ...data.contests[0], startsAt: null }];
    if (cause === "no game") data.contests = [];
    if (cause === "kicker") data.weeklyRoster = [{ ...data.weeklyRoster[0], position: "K" }];
    if (cause === "unsupported scoring") {
      const parsed = parseSleeperScoring({ st_ff: 1 });
      if (!parsed.ok) throw new Error("Bad fixture");
      profile = parsed.profile;
    }
    const row = buildNflverseWeeklyEstimates({ ...request, profile, includeConditionalEstimates: true }, data).players[0];
    expect(row.points).toBeNull();
    expect(row.conditionalEstimate).toBeUndefined();
  });
  it("retains signed conditional values without promoting them to ordinary points", () => {
    const parsed = parseSleeperScoring({ rec_yd: -0.1, rec_td: 0.01 });
    if (!parsed.ok) throw new Error("Bad fixture");
    const data = inputs();
    data.injuries = [];
    const opted = { ...request, profile: parsed.profile, includeConditionalEstimates: true };
    expect(buildNflverseWeeklyEstimates(opted, data).players[0].conditionalEstimate?.points).toBeLessThan(0);
    data.history = data.history.map(row => ({ ...row, stats: { ...row.stats, receivingYards: 0, receivingTds: 0 },
      usage: { ...row.usage, targets: 0 } }));
    expect(buildNflverseWeeklyEstimates(opted, data).players[0]).toMatchObject({ points: null, conditionalEstimate: { points: 0 } });
  });
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
    expect(buildNflverseWeeklyEstimates(request, data).players[0].availability).toBe("out");
    for (const gameStatus of ["unknown", "questionable", "doubtful"] as const) {
      data.injuries = [{ ...data.injuries[0], gameStatus }];
      const result = buildNflverseWeeklyEstimates(request, data);
      expect(result.players[0].availability).toBe(gameStatus);
      if (gameStatus === "unknown") expect(result.players[0].points).toBeNull();
      else expect(result.warnings.some(warning => warning.includes(gameStatus))).toBe(true);
    }
  });
  it("does not manufacture availability when the player identity is missing", () => {
    const data = inputs();
    data.roster = [];
    expect(buildNflverseWeeklyEstimates(request, data).players[0].availability).toBeUndefined();
    const inactive = inputs();
    inactive.weeklyRoster = [{ ...inactive.weeklyRoster[0], status: "reserve" }];
    expect(buildNflverseWeeklyEstimates(request, inactive).players[0].availability).toBe("inactive");
  });
  it("does not treat missing target-week injury coverage as clearance", () => {
    const data = inputs();
    for (const injuries of [[], data.injuries.map(row => ({ ...row, season: 2025 })),
      data.injuries.map(row => ({ ...row, week: 2 })), data.injuries.map(row => ({ ...row, team: "GB" as const }))]) {
      data.injuries = injuries;
      expect(buildNflverseWeeklyEstimates(request, data).players[0]).toMatchObject({
        points: null, availability: "active", injuryCoverage: "unavailable", team: "MIN", gameId: "game",
        reason: expect.stringContaining("requested week are unavailable"),
      });
    }
  });
  it("preserves explicit injury designations even when current-team coverage is missing", () => {
    const data = inputs();
    for (const gameStatus of ["out", "questionable"] as const) {
      data.injuries = [{ ...data.injuries[0], playerId: "gsis-1", team: "GB", gameStatus }];
      const result = buildNflverseWeeklyEstimates(request, data);
      expect(result.players[0]).toMatchObject({ points: null, availability: gameStatus, injuryCoverage: "unavailable" });
      expect(result.warnings.some(warning => warning.includes("not injury clearance"))).toBe(true);
    }
  });
  it("applies the last injury correction for the exact player-week", () => {
    const data = inputs();
    const injury = { season: 2026, week: 1, playerId: "gsis-1", name: "Test TE", position: "TE", team: "MIN",
      gameStatus: "out" as const, practiceStatus: "none" as const, primaryInjury: "Knee", dateModified: null };
    data.injuries = [injury, { ...injury, gameStatus: "questionable" }];
    const eligible = buildNflverseWeeklyEstimates(request, data).players[0];
    expect(eligible.availability).toBe("questionable");
    expect(eligible.points).not.toBeNull();
    data.injuries = [...data.injuries, injury];
    expect(buildNflverseWeeklyEstimates(request, data).players[0].availability).toBe("out");
  });
  it("resolves one active transaction destination but rejects conflicting active teams", () => {
    const data = inputs();
    data.weeklyRoster = [{ ...data.weeklyRoster[0], team: "GB", status: "traded" }, ...data.weeklyRoster];
    expect(buildNflverseWeeklyEstimates(request, data).players[0].points).not.toBeNull();
    data.weeklyRoster = [{ ...data.weeklyRoster[0], status: "active" }, data.weeklyRoster[1]];
    expect(buildNflverseWeeklyEstimates(request, data).players[0]).toMatchObject({ points: null, availability: "unknown" });
  });
  it("warns when a successful market response has no usable total for the projected game", () => {
    const data = inputs();
    data.lines = [{ contestId: "game", total: null, spread: 3, homeMoneyline: null, awayMoneyline: null }];
    expect(buildNflverseWeeklyEstimates(request, data).warnings.some(warning => warning.includes("Betting lines are missing"))).toBe(true);
    data.lines = [{ ...data.lines[0], total: 45 }];
    expect(buildNflverseWeeklyEstimates(request, data).warnings.some(warning => warning.includes("Betting lines are missing"))).toBe(false);
  });
  it("retains valid zero and negative model means after the history gate", () => {
    const parsed = parseSleeperScoring({ rec_yd: -0.1, rec_td: 0.01 });
    if (!parsed.ok) throw new Error("Bad fixture");
    const data = inputs();
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, data).players[0].points).toBeLessThan(0);
    data.history = data.history.map(row => ({ ...row, stats: { ...row.stats, receivingYards: 0, receivingTds: 0 },
      usage: { ...row.usage, targets: 0 } }));
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, data).players[0].points).toBe(0);
  });
  it("does not run the model when every offensive scoring term is unsupported", () => {
    const parsed = parseSleeperScoring({ st_ff: 1 });
    if (!parsed.ok) throw new Error("Bad fixture");
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, inputs()).players[0])
      .toMatchObject({ points: null, reason: "No supported offensive scoring rules" });
  });
  it("fails closed on penalty-only scoring instead of inventing a positive usage-prior score", () => {
    const parsed = parseSleeperScoring({ pass_int: -2 });
    if (!parsed.ok) throw new Error("Bad fixture");
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, inputs()).players[0])
      .toMatchObject({ points: null, availability: "active" });
  });
  it("keeps a verified inactive identity until the current weekly availability gate", () => {
    const data = inputs();
    const catalog = parseDraftRoster([{ gsis_id: "gsis-1", sleeper_id: "5844", full_name: "Test TE", position: "TE", team: "MIN", status: "RES" }]);
    data.roster = nflverseWeeklyIdentities(catalog.entries);
    data.weeklyRoster = [{ ...data.weeklyRoster[0], status: "reserve" }];
    expect(buildNflverseWeeklyEstimates(request, data).players[0])
      .toMatchObject({ gsisId: "gsis-1", points: null, availability: "inactive" });
  });
  it("does not apply a receiver usage prior to QB-only scoring", () => {
    const parsed = parseSleeperScoring({ pass_yd: 0.04, pass_td: 6 });
    if (!parsed.ok) throw new Error("Bad fixture");
    expect(buildNflverseWeeklyEstimates({ ...request, profile: parsed.profile }, inputs()).players[0])
      .toMatchObject({ points: null, reason: expect.stringContaining("for this position") });
  });
  it("retains current team and kickoff context even when no estimate is available", () => {
    const data = inputs();
    data.contests = [{ ...data.contests[0], startsAt: "2026-09-08T17:00:00Z" }];
    expect(buildNflverseWeeklyEstimates(request, data).players[0]).toMatchObject({ points: null, team: "MIN",
      gameId: "game", kickoffAt: Date.parse("2026-09-08T17:00:00Z") });
    data.weeklyRoster = [{ ...data.weeklyRoster[0], status: "reserve" }];
    expect(buildNflverseWeeklyEstimates(request, data).players[0]).toMatchObject({ availability: "inactive", team: "MIN", gameId: "game" });
    data.contests = [];
    expect(buildNflverseWeeklyEstimates(request, data).players[0]).toMatchObject({ team: "MIN", gameId: null, kickoffAt: null });
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
