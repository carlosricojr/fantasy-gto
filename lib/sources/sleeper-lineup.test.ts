import { describe, expect, it } from "vitest";
import { createSleeperLineupFetcher, parseSleeperLineup } from "./sleeper-lineup";
import { playersUrl } from "./sleeper";

const league = { league_id: "123", sport: "nfl", name: "League", season: "2026", settings: { best_ball: 0, max_subs: 0 }, scoring_settings: { pass_td: 6, rec: 0.5, sack: 2 }, roster_positions: ["QB", "FLEX", "DEF", "BN"] };
const roster = { league_id: "123", roster_id: 6, owner_id: "456", players: ["a", "b", "HOU", "c"], starters: ["a", "b", "HOU"], reserve: null, taxi: null };
const player = (name: string, position: string) => ({ full_name: name, fantasy_positions: [position], status: "Active", injury_status: null });
const directory = { a: player("QB", "QB"), b: player("RB", "RB"), HOU: player("Houston", "DEF"), c: player("WR", "WR") };
const request = { leagueId: "123", ownerId: "456", week: 1, now: 1000 };

describe("Sleeper weekly roster import", () => {
  it("shares and expires the daily player download while refreshing league state", async () => {
    let now = 1000;
    const calls: string[] = [];
    const fetchText = createSleeperLineupFetcher(async (url) => { calls.push(url); return "{}"; }, () => now);
    await Promise.all([fetchText(playersUrl()), fetchText(playersUrl())]);
    await fetchText("https://api.sleeper.app/v1/league/123");
    await fetchText("https://api.sleeper.app/v1/league/123");
    expect(calls).toHaveLength(3);
    now += 24 * 60 * 60 * 1000;
    await fetchText(playersUrl());
    expect(calls).toHaveLength(4);
  });
  it("preserves exact coefficient identity, starter order, bench, and unknown projections", () => {
    const result = parseSleeperLineup(league, [roster], directory, request);
    expect(result.scoringId).toBe('sleeper-v1:{"pass_td":6,"rec":0.5,"sack":2}');
    expect(result.slots[2].eligiblePositions).toEqual(["DST"]);
    expect(result.players.map((p) => p.currentSlotId)).toEqual(["sleeper-slot-0", "sleeper-slot-1", "sleeper-slot-2", null]);
    expect(result.players.every((p) => p.projectedPoints === null && p.kickoffAt === null)).toBe(true);
  });

  it("rejects wrong/ambiguous ownership, unsupported scoring and malformed starters", () => {
    expect(() => parseSleeperLineup(league, [roster], directory, { ...request, ownerId: "other" })).toThrow("uniquely");
    expect(() => parseSleeperLineup(league, [roster, roster], directory, request)).toThrow("uniquely");
    expect(() => parseSleeperLineup({ ...league, scoring_settings: { bonus_rec_te: 2 } }, [roster], directory, request)).toThrow("scoring");
    expect(() => parseSleeperLineup(league, [{ ...roster, starters: ["a", "a", "HOU"] }], directory, request)).toThrow("duplicate");
  });

  it("retains injury, reserve, and unknown status instead of hardcoding active", () => {
    const result = parseSleeperLineup(league, [{ ...roster, reserve: ["c"] }], { ...directory, a: { ...directory.a, injury_status: "Out" }, b: { ...directory.b, status: "Unexpected" } }, request);
    expect(result.players.map((p) => p.availability)).toEqual(["out", "unknown", "active", "reserve"]);
  });
});
