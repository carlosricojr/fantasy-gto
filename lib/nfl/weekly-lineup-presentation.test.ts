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
it("suppresses identical-eligibility slot permutations even with different labels", () => {
  const input = { ...snapshot, slots: [{ id: "rb", label: "RB 1", eligiblePositions: ["RB"] }, { id: "rb2", label: "RB 2", eligiblePositions: ["RB"] }], players: [{ ...snapshot.players[0], currentSlotId: "rb2" }, { ...snapshot.players[1], currentSlotId: "rb" }] };
  const plan = planWeeklyLineup(input, { now: 10, maxProjectionAgeMs: 10_000, maxRosterAgeMs: 10_000 });
  expect(plan.assignments.map((a) => a.playerId)).toEqual(["a", "b"]);
  expect(weeklyLineupActions(input, plan)).toEqual([]);
});
it("preserves broader FLEX moves as slot explanations, not start/bench actions", () => {
  const input = { ...snapshot, slots: [...snapshot.slots, { id: "flex", label: "FLEX", eligiblePositions: ["RB", "WR", "TE"] }], players: [{ ...snapshot.players[0], currentSlotId: "flex" }, { ...snapshot.players[1], currentSlotId: "rb" }] };
  const actions = weeklyLineupActions(input, planWeeklyLineup(input, { now: 10, maxProjectionAgeMs: 10_000, maxRosterAgeMs: 10_000 }));
  expect(actions.map((a) => a.kind)).toEqual(["slot", "slot"]);
  expect(actions.map((a) => a.text)).toEqual(["Move A from FLEX to RB", "Move B from RB to FLEX"]);
});
it("retains an equivalent-slot move needed to free the displayed substitution destination", () => {
  const input: WeeklyLineupSnapshot = { ...snapshot, slots: [{ id: "rb1", label: "RB1", eligiblePositions: ["RB"] }, { id: "rb2", label: "RB2", eligiblePositions: ["RB"] }], players: [
    { ...snapshot.players[0], id: "a", name: "A", currentSlotId: "rb2", projectedPoints: 15 },
    { ...snapshot.players[0], id: "b", name: "B", currentSlotId: "rb1", projectedPoints: 5 },
    { ...snapshot.players[0], id: "c", name: "C", currentSlotId: null, projectedPoints: 10 },
  ] };
  const plan = planWeeklyLineup(input, { now: 10, maxProjectionAgeMs: 10_000, maxRosterAgeMs: 10_000 });
  expect(plan.assignments.map((a) => a.playerId)).toEqual(["a", "c"]);
  const actions = weeklyLineupActions(input, plan);
  expect(actions.map((a) => a.text)).toEqual(["Move A from RB2 to RB1", "Bench B", "Start C at RB2"]);
  expect(actions.filter((a) => a.kind !== "slot").map((a) => a.text)).toEqual(["Bench B", "Start C at RB2"]);
});
