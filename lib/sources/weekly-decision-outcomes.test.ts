import { describe, expect, it, vi } from "vitest";
import { createWeeklyDecisionRecord } from "../nfl/decision-journal";
import type { WeeklyLineupSnapshot } from "../nfl/weekly-lineup";
import { fetchWeeklyDecisionOutcomes, parseDecisionMatchups } from "./weekly-decision-outcomes";
import { NflverseProvider, schedulesUrl } from "./nflverse";

const now = Date.parse("2026-09-01T12:00:00Z");
const snapshot: WeeklyLineupSnapshot = { leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: 'sleeper-v1:{"rec":1}', leagueName: "Test", source: "Test", retrievedAt: now, projectionUpdatedAt: now, rosterRetrievedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [{ id: "a", name: "A", positions: ["RB"], projectedPoints: 10, availability: "active", kickoffAt: now + 10000, currentSlotId: "rb" }] };
const record = createWeeklyDecisionRecord(JSON.stringify(snapshot), "{}", now);
const league = { league_id: "123", season: "2026", sport: "nfl", scoring_settings: { rec: 1 } };
const rosters = [{ owner_id: "456", league_id: "123", roster_id: 6 }];
const matchups = [{ roster_id: 6, custom_points: null, players: ["a"], players_points: { a: -2 } }];
const state = { season: "2026", week: 2, leg: 2, season_type: "regular" };

describe("prospective Sleeper outcome adapter", () => {
  it("uses exact-scoring player scores, including negative values, and verifies the period", () => {
    expect(parseDecisionMatchups(record, league, rosters, matchups, state)).toEqual({ pointsByPlayer: { a: -2 }, weekClosed: true });
    expect(parseDecisionMatchups(record, league, rosters, matchups, { ...state, week: 1, leg: 1 }).weekClosed).toBe(false);
  });
  it("finalizes week18 during postseason or next-season preseason, not current-season preseason", () => {
    const last = { ...record, snapshot: { ...snapshot, week: 18 } };
    expect(parseDecisionMatchups(last, league, rosters, matchups, { ...state, week: 1, leg: 18, season_type: "post" }).weekClosed).toBe(true);
    expect(parseDecisionMatchups(last, league, rosters, matchups, { season: "2027", week: 0, leg: 0, season_type: "pre" }).weekClosed).toBe(true);
    expect(parseDecisionMatchups(last, league, rosters, matchups, { ...state, week: 0, leg: 0, season_type: "pre" }).weekClosed).toBe(false);
    expect(() => parseDecisionMatchups(last, league, rosters, matchups, { ...state, season_type: "unknown" })).toThrow("outcome period");
    expect(() => parseDecisionMatchups(last, league, rosters, matchups, { ...state, leg: 19 })).toThrow("regular-season period");
  });
  it("leaves missing optional player scores missing, never replacing them with team totals", () => {
    expect(parseDecisionMatchups(record, league, rosters, [{ roster_id: 6, custom_points: null, points: 123 }], state).pointsByPlayer).toEqual({});
  });
  it("rejects league/scoring/ownership mismatches, duplicate team matchups, and commissioner adjustments", () => {
    expect(() => parseDecisionMatchups(record, { ...league, league_id: "999" }, rosters, matchups, state)).toThrow("league/season");
    expect(() => parseDecisionMatchups(record, { ...league, scoring_settings: { rec: 0.5 } }, rosters, matchups, state)).toThrow("scoring");
    expect(() => parseDecisionMatchups(record, league, [...rosters, ...rosters], matchups, state)).toThrow("ownership");
    expect(() => parseDecisionMatchups(record, league, rosters, [...matchups, ...matchups], state)).toThrow("unique");
    expect(() => parseDecisionMatchups(record, league, rosters, [{ ...matchups[0], custom_points: 42 }], state)).toThrow("Commissioner");
  });
  it("fails closed on invalid or conflicting player-level score fields", () => {
    for (const points of [null, "2", NaN, Infinity, 10001]) expect(() => parseDecisionMatchups(record, league, rosters, [{ ...matchups[0], players_points: { a: points } }], state)).toThrow("score");
    expect(() => parseDecisionMatchups(record, league, rosters, [{ ...matchups[0], players: [] }], state)).toThrow("identity");
    expect(() => parseDecisionMatchups(record, league, rosters, [...matchups, { ...matchups[0], roster_id: 7, players_points: { a: 20 } }], state)).toThrow("Conflicting");
  });
  it("does not read the reserved holdout or any earlier outcomes", async () => {
    const fetcher = vi.fn();
    await expect(fetchWeeklyDecisionOutcomes({ ...record, snapshot: { ...snapshot, season: 2025 } }, { now }, fetcher)).rejects.toThrow("2026 onward");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses the real schedule parser without inventing a kickoff for a missing time", async () => {
    const identities = vi.spyOn(NflverseProvider.prototype, "draftRoster").mockResolvedValue({ ok: true, data: { entries: [{ sleeperId: "a", gsisId: "gsis" }], warnings: [] } } as never);
    const weekly = vi.spyOn(NflverseProvider.prototype, "weeklyRoster").mockResolvedValue({ ok: true, data: { entries: [{ playerId: "gsis", season: 2026, week: 1, team: "HOU", position: "RB", status: "active" }] } } as never);
    const fetcher = async (url: string) => url === schedulesUrl() ? "game_id,season,week,game_type,home_team,away_team,gameday,gametime,home_score,away_score\ng,2026,1,REG,HOU,NE,2026-09-01,,10,7\n" : JSON.stringify(url.endsWith("/rosters") ? rosters : url.includes("/matchups/") ? matchups : url.endsWith("/state/nfl") ? state : league);
    try {
      const observed = await fetchWeeklyDecisionOutcomes(record, { now: now + 86400000 }, fetcher);
      expect(observed.kickoffByPlayer).toEqual({});
      expect(observed.completePlayerIds).toEqual([]);
    } finally { identities.mockRestore(); weekly.mockRestore(); }
  });
  it("requires both a closed platform week and independently posted game results; pregame zero is not complete", async () => {
    const games = vi.spyOn(NflverseProvider.prototype, "allContests").mockResolvedValue({ ok: true, degraded: false, data: [{ id: "g", period: { season: 2026, index: 1 }, homeTeam: "HOU", awayTeam: "NE", startsAt: new Date(now + 10000).toISOString(), result: null }] });
    const identities = vi.spyOn(NflverseProvider.prototype, "draftRoster").mockResolvedValue({ ok: true, data: { entries: [{ sleeperId: "a", gsisId: "gsis" }], warnings: [] } } as never);
    const weekly = vi.spyOn(NflverseProvider.prototype, "weeklyRoster").mockResolvedValue({ ok: true, data: { entries: [{ playerId: "gsis", season: 2026, week: 1, team: "HOU", position: "RB", status: "active" }] } } as never);
    let period = state;
    const fetcher = vi.fn(async (url: string) => JSON.stringify(url.endsWith("/rosters") ? rosters : url.includes("/matchups/") ? [{ ...matchups[0], players_points: { a: 0 } }] : url.endsWith("/state/nfl") ? period : league));
    try {
      const pending = await fetchWeeklyDecisionOutcomes(record, { now: now + 100000 }, fetcher);
      expect(pending.pointsByPlayer).toEqual({ a: 0 });
      expect(pending.kickoffByPlayer).toEqual({ a: now + 10000 });
      expect(pending.completePlayerIds).toEqual([]);
      games.mockResolvedValue({ ok: true, degraded: false, data: [{ id: "g", period: { season: 2026, index: 1 }, homeTeam: "HOU", awayTeam: "NE", startsAt: new Date(now + 10000).toISOString(), result: { homeScore: 10, awayScore: 7 } }] });
      period = { ...state, week: 1, leg: 1 };
      expect((await fetchWeeklyDecisionOutcomes(record, { now: now + 100000 }, fetcher)).completePlayerIds).toEqual([]);
      period = state;
      expect((await fetchWeeklyDecisionOutcomes(record, { now: now + 100000 }, fetcher)).completePlayerIds).toEqual(["a"]);
      expect(fetcher.mock.calls.every(([url]) => url.startsWith("https://api.sleeper.app/v1/") && !url.includes("projections"))).toBe(true);
    } finally { games.mockRestore(); identities.mockRestore(); weekly.mockRestore(); }
  });
});
