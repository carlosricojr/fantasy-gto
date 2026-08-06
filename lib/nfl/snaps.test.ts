import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";
import { type PlayerProfile, pfrBridge, toPlayerProfiles } from "./players";
import { bridgeSnaps, indexSnaps, snapKey, toRegularSeasonSnaps } from "./snaps";

/**
 * Snap counts, and the bridge that lets them meet a projection.
 *
 * The fixture is six rows lifted verbatim from upstream's 26,615, chosen to cover the cases
 * that matter: a full-time quarterback, a rotational back, a tight end who plays mostly
 * special teams, a defender with zero offensive snaps, a starting receiver, and one
 * postseason row that must be filtered out.
 */
const FIXTURES = join(__dirname, "../../tests/fixtures");
const snapsCsv = readFileSync(join(FIXTURES, "snap_counts_2024_sample.csv"), "utf8");
const playersCsv = readFileSync(join(FIXTURES, "players_sample.csv"), "utf8");

const snaps = toRegularSeasonSnaps(parseCsv(snapsCsv));

describe("toRegularSeasonSnaps", () => {
  it("keeps regular-season rows and drops the rest", () => {
    // Five of the six fixture rows are regular season; the Wild Card row is not.
    expect(snaps).toHaveLength(5);
    expect(snaps.every((s) => s.season === 2024)).toBe(true);
  });

  it("reads a full-time player's share as a fraction, not a percentage", () => {
    // Upstream ships 0.9 for 90%. Reading it as a percentage would make every snap share
    // two orders of magnitude too small and quietly disable any feature built on it.
    const allen = snaps.find((s) => s.pfrPlayerId === "AlleJo02");
    expect(allen?.name).toBe("Josh Allen");
    expect(allen?.offenseSnaps).toBe(62);
    expect(allen?.offenseShare).toBe(1);

    const harrison = snaps.find((s) => s.pfrPlayerId === "HarrMa09");
    expect(harrison?.offenseShare).toBeCloseTo(0.9, 10);
  });

  it("distinguishes a rotational role from a starting one", () => {
    // The entire reason this file exists: two targets on 14 snaps and two on 55 are the
    // same box score and different facts.
    const johnson = snaps.find((s) => s.pfrPlayerId === "JohnTy02");
    expect(johnson?.offenseSnaps).toBe(14);
    expect(johnson?.offenseShare).toBeCloseTo(0.23, 10);
    expect(johnson?.specialTeamsShare).toBeCloseTo(0.29, 10);
  });

  it("keeps a player with no offensive snaps but real special-teams work", () => {
    const rapp = snaps.find((s) => s.pfrPlayerId === "RappTa00");
    expect(rapp?.offenseSnaps).toBe(0);
    expect(rapp?.offenseShare).toBe(0);
    expect(rapp?.specialTeamsShare).toBeCloseTo(0.15, 10);
  });

  it("normalizes team and opponent, including retired codes", () => {
    // Asserting against 2024 codes alone would pass with no normalization. Snap counts go
    // back to 2013, and OAK, SD and STL all appear in that range.
    expect(snaps.every((s) => s.team !== null)).toBe(true);
    const historical = toRegularSeasonSnaps([
      { game_type: "REG", pfr_player_id: "x", season: "2015", week: "1", team: "OAK", opponent: "SD" },
      { game_type: "REG", pfr_player_id: "y", season: "2014", week: "1", team: "STL", opponent: "OAK" },
    ]);
    expect(historical.map((s) => [s.team, s.opponent])).toEqual([
      ["LV", "LAC"],
      ["LA", "LV"],
    ]);
  });

  it("drops a row with no pfr_player_id rather than counting it as unmatched", () => {
    // It could never have bridged, so counting it would inflate the miss rate with rows
    // that were never candidates.
    const columns = Object.keys(parseCsv(snapsCsv)[0]);
    const header = snapsCsv.split("\n")[0];
    const blank = `${header}\n${columns.map((c) => (c === "game_type" ? "REG" : "")).join(",")}\n`;
    expect(toRegularSeasonSnaps(parseCsv(blank))).toHaveLength(0);
  });
});

describe("bridgeSnaps", () => {
  const directory = pfrBridge(toPlayerProfiles(parseCsv(playersCsv)));

  it("resolves a row whose identifier is in the directory", () => {
    const profile: PlayerProfile = {
      playerId: "00-0000001",
      name: "Josh Allen",
      position: "QB",
      birthDate: null,
      pfrId: "AlleJo02",
      rookieSeason: null,
      lastSeason: null,
      yearsExperience: null,
      draft: null,
      status: "ACT",
    };
    const report = bridgeSnaps(snaps, new Map([["AlleJo02", profile]]));
    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].playerId).toBe("00-0000001");
    expect(report.matched[0].offenseSnaps).toBe(62);
  });

  it("counts an unmatched row instead of dropping or zeroing it", () => {
    // The assertion the whole join exists for. Zero snaps means benched and unknown snaps
    // means unknown; a model that cannot tell those apart will read every missing bridge as
    // a player who did not play.
    const report = bridgeSnaps(snaps, directory);
    expect(report.matched).toHaveLength(0);
    expect(report.unmatched).toHaveLength(5);
    expect(report.unmatchedPlayers.size).toBe(5);
    // The rows survive intact, so a caller can report the gap rather than infer it.
    expect(report.unmatched[0].offenseSnaps).toBeGreaterThanOrEqual(0);
  });

  it("accounts for every input row exactly once", () => {
    const report = bridgeSnaps(snaps, directory);
    expect(report.matched.length + report.unmatched.length).toBe(snaps.length);
  });

  it("counts a player who recurs across weeks once in the distinct set", () => {
    const repeated = [
      { ...snaps[0], week: 1 },
      { ...snaps[0], week: 2 },
      { ...snaps[0], week: 3 },
    ];
    const report = bridgeSnaps(repeated, new Map());
    expect(report.unmatched).toHaveLength(3);
    expect(report.unmatchedPlayers.size).toBe(1);
  });
});

describe("indexSnaps", () => {
  it("keys on player, season and week", () => {
    const bridged = snaps.map((s) => ({ ...s, playerId: `gsis-${s.pfrPlayerId}` }));
    const index = indexSnaps(bridged);
    expect(index.size).toBe(bridged.length);
    const first = bridged[0];
    expect(index.get(snapKey(first.playerId, first.season, first.week))?.offenseSnaps).toBe(
      first.offenseSnaps,
    );
  });
});
