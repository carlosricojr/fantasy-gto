import { describe, expect, it } from "vitest";
import type { InjuryReport } from "../nfl/injuries";
import { injuryCoverageWarning, summarizeNflverseInjuryCoverage } from "./nflverse-injury-coverage";

const row: InjuryReport = { season: 2026, week: 1, playerId: "test", name: "Test", position: "TE", team: "MIN",
  gameStatus: "questionable", practiceStatus: "limited", primaryInjury: "Knee", dateModified: null };
describe("nflverse injury evidence transparency", () => {
  it("counts only requested-week evidence, deduplicates teams, and never asserts freshness", () => {
    const result = summarizeNflverseInjuryCoverage([row, { ...row, team: "GB" }, row,
      { ...row, week: 2, team: "CHI" }, { ...row, season: 2024, team: "DET" }, { ...row, team: null }], 2026, 1);
    expect(result).toEqual({ sourceUrl: "https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_2026.csv",
      season: 2026, week: 1, reportRows: 4, reportedTeams: ["GB", "MIN"], datedRows: 0,
      latestRowUpdatedAt: null, freshness: "unknown", scope: "reported-rows-only" });
    expect(injuryCoverageWarning(result)).toContain("complete team coverage are unverified");
    expect(injuryCoverageWarning(result)).toContain("not injury clearance");
  });
  it("does not fabricate timestamps from invalid, absent or timezone-less dates", () => {
    const result = summarizeNflverseInjuryCoverage([row, { ...row, dateModified: "bad" },
      { ...row, dateModified: "2026-09-09T12:00:00" }, { ...row, dateModified: "2026-09-08T12:00:00Z" },
      { ...row, dateModified: "2026-09-09T08:30:00-04:00" }], 2026, 1);
    expect(result.latestRowUpdatedAt).toBe(Date.parse("2026-09-09T12:30:00Z"));
    expect(result.datedRows).toBe(2);
    expect(result.freshness).toBe("unknown");
    expect(injuryCoverageWarning(result)).toContain("2/5 rows dated");
  });
  it("exposes an empty slice without treating no reports as no injuries", () => {
    const result = summarizeNflverseInjuryCoverage([row], 2026, 2);
    expect(result.reportRows).toBe(0);
    expect(result.reportedTeams).toEqual([]);
    expect(result.latestRowUpdatedAt).toBeNull();
    expect(injuryCoverageWarning(result)).toContain("0 reported rows across 0 teams");
  });
});
