import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";
import { CURRENT_TEAMS, hasIndoorHomeStadium, isTeam, normalizeTeam } from "./teams";

describe("CURRENT_TEAMS", () => {
  it("has exactly 32 unique entries", () => {
    expect(CURRENT_TEAMS).toHaveLength(32);
    expect(new Set(CURRENT_TEAMS).size).toBe(32);
  });

  it("uses LA for the Rams, matching upstream, and never LAR", () => {
    expect(CURRENT_TEAMS).toContain("LA");
    expect(CURRENT_TEAMS as readonly string[]).not.toContain("LAR");
  });
});

describe("normalizeTeam", () => {
  it("passes through current abbreviations", () => {
    for (const team of CURRENT_TEAMS) {
      expect(normalizeTeam(team)).toBe(team);
    }
  });

  it.each([
    ["OAK", "LV"],
    ["SD", "LAC"],
    ["STL", "LA"],
  ])("maps relocated franchise %s to %s", (from, to) => {
    expect(normalizeTeam(from)).toBe(to);
  });

  it.each([
    ["LAR", "LA"],
    ["WSH", "WAS"],
    ["JAC", "JAX"],
    ["ARZ", "ARI"],
    ["LVR", "LV"],
  ])("accepts the common alias %s as %s", (from, to) => {
    expect(normalizeTeam(from)).toBe(to);
  });

  it("is case and whitespace insensitive", () => {
    expect(normalizeTeam("  phi ")).toBe("PHI");
    expect(normalizeTeam("oak")).toBe("LV");
  });

  it.each([null, undefined, "", "   ", "NA", "ZZZ", "PHILADELPHIA"])(
    "returns null for unusable input %s",
    (input) => {
      expect(normalizeTeam(input)).toBeNull();
    },
  );

  it("never invents a team outside the current 32", () => {
    const candidates = ["OAK", "SD", "STL", "LAR", "WSH", "JAC", "ZZZ", "", "KC"];
    for (const candidate of candidates) {
      const result = normalizeTeam(candidate);
      if (result !== null) expect(CURRENT_TEAMS).toContain(result);
    }
  });
});

describe("isTeam", () => {
  it("narrows correctly", () => {
    expect(isTeam("KC")).toBe(true);
    expect(isTeam("OAK")).toBe(true);
    expect(isTeam("ZZZ")).toBe(false);
    expect(isTeam(null)).toBe(false);
  });
});

describe("hasIndoorHomeStadium", () => {
  it("classifies known domes and open-air venues", () => {
    expect(hasIndoorHomeStadium("MIN")).toBe(true);
    expect(hasIndoorHomeStadium("NO")).toBe(true);
    expect(hasIndoorHomeStadium("DET")).toBe(true);
    expect(hasIndoorHomeStadium("GB")).toBe(false);
    expect(hasIndoorHomeStadium("BUF")).toBe(false);
  });
});

describe("against the real games fixture", () => {
  const games = parseCsv(
    readFileSync(join(__dirname, "../../tests/fixtures/games_sample.csv"), "utf8"),
  );

  it("normalises every team appearing upstream", () => {
    const raw = new Set<string>();
    for (const game of games) {
      raw.add(game.home_team);
      raw.add(game.away_team);
    }
    expect(raw.size).toBeGreaterThan(20);
    for (const team of raw) {
      expect(normalizeTeam(team), `upstream team ${team} must normalise`).not.toBeNull();
    }
  });

  it("normalisation is idempotent on real data", () => {
    for (const game of games) {
      const once = normalizeTeam(game.home_team);
      expect(normalizeTeam(once)).toBe(once);
    }
  });
});
