import type { WaiverImport } from "@/lib/sources/sleeper-waivers";
import type { WeeklyPlayer } from "@/lib/nfl/weekly-lineup";

/** Synthetic local QA only; no production records, credentials or provider forecasts. */
export const fixtureConnection = { leagueId: "123", ownerId: "456", leagueName: "Synthetic QA league", username: "fixture_manager", season: 2026 };
export function waiverFixture(now: number, compare: boolean, conditional = false): WaiverImport {
  const player = (id: string, points: number | null, patch: Partial<WeeklyPlayer> = {}): WeeklyPlayer => ({ id, name: `Fixture ${id}`, positions: ["RB"], team: "BAL", availability: "active", kickoffAt: now + 3600000, currentSlotId: null, projectedPoints: points, projectionOrigin: "model", ...patch });
  const players = [player("1", 10, { currentSlotId: "rb" })];
  const candidates = [player("7", compare ? 12 : null), player("8", null, conditional ? { injuryCoverage: "unavailable", conditionalEstimate: { points: 20, condition: "active-at-kickoff", missingEvidence: "team-injury-report" } } : {})];
  return {
    roster: { ...fixtureConnection, season: 2026, week: 1, scoringId: 'sleeper-v1:{"rush_yd":0.1,"st_ff":1}', source: "Synthetic local fixture", retrievedAt: now, rosterRetrievedAt: now, projectionUpdatedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players, ...(compare ? { model: { source: "Synthetic model fixture", computedAt: now, providerUpdatedAt: null, excludedRules: ["st_ff"], warnings: ["Synthetic incomplete scoring; not a real forecast"], coverage: { requested: 3, projected: 2 } } } : {}) },
    ownership: { leagueId: "123", ownerId: "456", rosterId: 6, rosterCount: 2, ownedPlayerIds: ["1", "2"], ownPlayerIds: ["1"], protectedPlayerIds: [], retrievedAt: now },
    candidates: compare ? candidates : [], availablePlayers: candidates, availableCount: 2, directoryExcludedCount: 4,
    rosterEvidence: { sourceUrl: "https://github.com/nflverse/nflverse-data", season: 2026, week: 1, retrievedAt: now, publicationTime: null, reportRows: 3, reportedTeams: ["BAL"], excluded: { missing: 2, inactive: 3, conflicting: 1 } },
  };
}
