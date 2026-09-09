import { describe, expect, it } from "vitest";
import { assertCoverageAuditRows, hasExplicitCounters } from "./coverage-audit-data";

const row = { season_type: "REG", season: "2024", week: "1", player_id: "test" };
describe("coverage audit source boundaries", () => {
  it("rejects holdout, wrong-year, duplicate and malformed observations", () => {
    expect(() => assertCoverageAuditRows([row], 2024, "player_id")).not.toThrow();
    expect(() => assertCoverageAuditRows([row], 2025, "player_id")).toThrow("holdout");
    expect(() => assertCoverageAuditRows([row], 2023, "player_id")).toThrow("period");
    expect(() => assertCoverageAuditRows([row, row], 2024, "player_id")).toThrow("Duplicate");
    for (const bad of [{ ...row, week: "19" }, { ...row, week: "1.5" }, { ...row, player_id: "" }]) {
      expect(() => assertCoverageAuditRows([bad], 2024, "player_id")).toThrow();
    }
  });
  it("distinguishes observed zero from absent or malformed counters", () => {
    expect(hasExplicitCounters({ sacks: "0" }, ["sacks"])).toBe(true);
    for (const value of [undefined, "", " ", "NaN", "Infinity"]) {
      expect(hasExplicitCounters(value === undefined ? {} : { sacks: value }, ["sacks"])).toBe(false);
    }
  });
});
