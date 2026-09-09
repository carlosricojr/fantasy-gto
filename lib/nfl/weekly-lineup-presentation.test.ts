import { expect, it } from "vitest";
import { groupWeeklyNotices, weeklyKickoffChecks, weeklyLineupActions } from "./weekly-lineup-presentation";
import { planWeeklyLineup, type WeeklyLineupSnapshot } from "./weekly-lineup";

const snapshot: WeeklyLineupSnapshot = { leagueId: "1", ownerId: "2", leagueName: "League", season: 2026, week: 1, scoringId: "ppr", source: "test", retrievedAt: 10, rosterRetrievedAt: 10, projectionUpdatedAt: 10, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [{ id: "a", name: "A", positions: ["RB"], availability: "active", kickoffAt: 1000, currentSlotId: "rb", projectedPoints: 5 }, { id: "b", name: "B", positions: ["RB"], availability: "active", kickoffAt: 2000, currentSlotId: null, projectedPoints: 10 }] };
it("lists concrete start/bench actions without pretending locked players can move", () => {
  const options = { now: 10, maxProjectionAgeMs: 10_000, maxRosterAgeMs: 10_000 };
  const actions = weeklyLineupActions(snapshot, planWeeklyLineup(snapshot, options));
  expect(actions.map((a) => a.text)).toEqual(["Bench A", "Start B at RB"]);
  expect(weeklyLineupActions(snapshot, planWeeklyLineup(snapshot, { ...options, now: 1001 }))).toEqual([]);
});
it("groups notes while retaining all unique evidence", () => {
  const notes = ["A is questionable", "Unknown publication time", "Missing projection", "Unknown publication time", "Other detail"];
  expect(groupWeeklyNotices(notes).flatMap((g) => g.messages).sort()).toEqual([...new Set(notes)].sort());
});
it("builds a local kickoff checklist from known games only", () => {
  const rows = weeklyKickoffChecks({ ...snapshot, players: [...snapshot.players, { ...snapshot.players[0], id: "unknown", kickoffAt: null }] }, 1000);
  expect(rows).toHaveLength(2); expect(rows[0].locked).toBe(true); expect(rows[1].locked).toBe(false);
  expect(rows[1].checkAt).toBe(2000 - 90 * 60_000);
});
