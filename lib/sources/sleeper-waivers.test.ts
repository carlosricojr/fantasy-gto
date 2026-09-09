import { describe, expect, it } from "vitest";
import { importSleeperWaivers, parseWaiverRequest, type WaiverRequest } from "./sleeper-waivers";
import { createSleeperLineupFetcher } from "./sleeper-lineup";
import { leagueUrl, playersUrl } from "./sleeper";

// Synthetic documented API shapes, not a recorded real-league fixture.
const request: WaiverRequest = { leagueId: "123", ownerId: "456", week: 1, now: 100000, candidateIds: [], includeConditionalEstimates: false };
const league = { league_id: "123", sport: "nfl", status: "in_season", name: "Synthetic", season: "2026", total_rosters: 2, settings: { disable_adds: 0, taxi_slots: 1, best_ball: 0, max_subs: 0 }, scoring_settings: { rush_yd: 0.1, rec: 0.5 }, roster_positions: ["RB", "FLEX", "BN"] };
const rosters = [
  { league_id: "123", roster_id: 6, owner_id: "456", players: ["1", "2"], starters: ["1", "2"], reserve: null, taxi: null },
  { league_id: "123", roster_id: 2, owner_id: "789", players: ["3", "4"], starters: ["3", "4"], reserve: ["5"], taxi: ["6"] },
];
const player = (id: string, patch: Record<string, unknown> = {}) => ({ player_id: id, full_name: `Player ${id}`, fantasy_positions: ["RB"], status: "Active", injury_status: null, ...patch });
const directory = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), player(String(i + 1))]));
const payloads = (patch: Record<string, unknown> = {}) => ({
  [leagueUrl("123")]: league,
  [`${leagueUrl("123")}/rosters`]: rosters,
  [playersUrl()]: { ...directory, "8": player("8", { fantasy_positions: ["QB"] }), "9": player("9", { status: "Retired" }), "10": null, "11": player("wrong") },
  "https://api.sleeper.app/v1/state/nfl": { season: "2026", week: 1, season_type: "regular" },
  ...patch,
});
const fetcher = (data: Record<string, unknown>, calls: string[] = []) => async (url: string) => { calls.push(url); if (!(url in data)) throw new Error(`Unexpected source ${url}`); return JSON.stringify(data[url]); };

describe("read-only waiver source boundary", () => {
  it("gets all rosters, excludes reserve/taxi and unsupported rows, and does no NFL/projection work during discovery", async () => {
    const calls: string[] = [];
    const result = await importSleeperWaivers(request, fetcher(payloads(), calls));
    expect(calls).toHaveLength(4);
    expect(result.availablePlayers.map((p) => p.id)).toEqual(["12", "7"]);
    expect(result.directoryExcludedCount).toBe(4);
    expect(result.ownership.ownedPlayerIds).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(result.roster.scoringId).toBe('sleeper-v1:{"rec":0.5,"rush_yd":0.1}');
    expect(result.candidates).toEqual([]);
  });
  it("rechecks ownership on every comparison and rejects a newly rostered selection before projection I/O", async () => {
    const calls: string[] = [];
    const data = payloads();
    const cached = createSleeperLineupFetcher(fetcher(data, calls), () => request.now);
    await importSleeperWaivers(request, cached);
    data[`${leagueUrl("123")}/rosters`] = [rosters[0], { ...rosters[1], players: ["3", "4", "7"] }];
    await expect(importSleeperWaivers({ ...request, candidateIds: ["7"] }, cached)).rejects.toThrow("no longer unrostered");
    expect(calls.filter((url) => url === playersUrl())).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("/rosters"))).toHaveLength(2);
    expect(calls.every((url) => url.startsWith("https://api.sleeper.app/v1/"))).toBe(true);
  });
  it.each([null, { season: "2025", week: 1, season_type: "regular" }, { season: "2026", week: 2, season_type: "regular" }, { season: "2026", week: 1, season_type: "post" }])("refuses stale/future or malformed current-week state %j", async (state) => {
    await expect(importSleeperWaivers(request, fetcher(payloads({ "https://api.sleeper.app/v1/state/nfl": state })))).rejects.toThrow();
  });
  it("never returns an available pool when any opponent membership is malformed", async () => {
    await expect(importSleeperWaivers(request, fetcher(payloads({ [`${leagueUrl("123")}/rosters`]: [rosters[0], { ...rosters[1], players: null }] })))).rejects.toThrow("ownership");
  });
  it.each(["leagueId=../123&ownerId=456&week=1", "leagueId=123&ownerId=456&week=19", "leagueId=123&ownerId=456&week=1&candidates=7,7", "leagueId=123&ownerId=456&week=1&candidates=../7", `leagueId=123&ownerId=456&week=1&candidates=${Array.from({ length: 13 }, (_, i) => i + 1).join(",")}`, "leagueId=123&ownerId=456&week=1&conditional=true"]) ("rejects request scope before network: %s", (params) => {
    expect(() => parseWaiverRequest(new URLSearchParams(params), request.now)).toThrow();
  });
  it("validates budget for direct callers before fetch", async () => {
    const calls: string[] = [];
    await expect(importSleeperWaivers({ ...request, candidateIds: Array.from({ length: 13 }, (_, i) => String(i + 1)) }, fetcher({}, calls))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it("surfaces unavailable required schedule data rather than ranking unknown forecasts", async () => {
    await expect(importSleeperWaivers({ ...request, candidateIds: ["7"] }, fetcher(payloads()))).rejects.toThrow("Schedule unavailable");
  });
});
