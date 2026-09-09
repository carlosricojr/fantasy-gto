import { describe, expect, it } from "vitest";
import type { WeeklyLineupSnapshot } from "./weekly-lineup";
import { MANUAL_ESTIMATE_MAX_AGE, parseWeeklyManual, restoreWeeklyManual, saveWeeklyManual, updateWeeklyManualStore } from "./weekly-lineup-storage";

const snapshot: WeeklyLineupSnapshot = { leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact", leagueName: "League", slots: [], source: "source", retrievedAt: 100, projectionUpdatedAt: null, rosterRetrievedAt: 100,
  players: [{ id: "1", name: "Manual", positions: ["RB"], availability: "out", kickoffAt: 1000, team: "GB", gameId: "game", currentSlotId: null, projectedPoints: 0, projectionOrigin: "manual", projectionEnteredAt: 50 }, { id: "2", name: "Auto", positions: ["RB"], availability: "active", kickoffAt: 1000, currentSlotId: null, projectedPoints: 10, projectionOrigin: "model" }] };
const incoming = { ...snapshot, rosterRetrievedAt: 300, players: snapshot.players.map((p) => ({ ...p, projectedPoints: 20, projectionOrigin: "model" as const })) };
const saved = saveWeeklyManual(snapshot, "source", "", 100);

describe("manual browser persistence", () => {
  it("stores only manual entries and restores exact zeros with original timestamps", () => {
    expect(saved.rows).toHaveLength(1);
    const result = restoreWeeklyManual(incoming, parseWeeklyManual(JSON.stringify([saved])), 300);
    expect(result.restored).toBe(1);
    expect(result.snapshot.players[0]).toMatchObject({ projectedPoints: 0, projectionEnteredAt: 50, availability: "out" });
    expect(result.snapshot.players[1].projectedPoints).toBe(20);
    expect(result.snapshot.rosterRetrievedAt).toBe(300);
  });
  it.each(["leagueId", "ownerId", "season", "week", "scoringId"] as const)("never crosses %s context", (key) => {
    const changed = { ...incoming, [key]: typeof incoming[key] === "number" ? Number(incoming[key]) + 1 : "different" };
    expect(restoreWeeklyManual(changed, [saved], 300).restored).toBe(0);
  });
  it.each(["team", "gameId", "kickoffAt"] as const)("discards changed %s", (key) => {
    const changed = { ...incoming, players: [{ ...incoming.players[0], [key]: key === "kickoffAt" ? 2000 : "changed" }] };
    expect(restoreWeeklyManual(changed, [saved], 300)).toMatchObject({ restored: 0, discarded: 1 });
  });
  it("expires entries rather than treating a restore as a new publication", () => {
    expect(restoreWeeklyManual(incoming, [saved], 51 + MANUAL_ESTIMATE_MAX_AGE)).toMatchObject({ restored: 0, discarded: 1 });
    expect(restoreWeeklyManual(incoming, [saved], 49).restored).toBe(0);
  });
  it("retains explicit clears, never stores conditional values or source clearance", () => {
    const entry = saveWeeklyManual({ ...snapshot, players: [{ ...snapshot.players[0], projectedPoints: null }, { ...snapshot.players[1], projectionOrigin: "model-conditional" }] }, "source", "", 100);
    expect(entry.rows).toHaveLength(1);
    expect(restoreWeeklyManual(incoming, [entry], 300).snapshot.players[0].projectedPoints).toBeNull();
    expect(JSON.stringify(entry)).not.toMatch(/availability|conditional|rosterRetrievedAt/);
  });
  it("rejects corrupt, oversized and duplicate inputs and limits saved contexts", () => {
    for (const raw of ["null", "bad", JSON.stringify([{ ...saved, rows: [saved.rows[0], saved.rows[0]] }]), JSON.stringify([{ ...saved, rows: [{ ...saved.rows[0], points: "10" }] }])]) expect(parseWeeklyManual(raw)).toEqual([]);
    expect(updateWeeklyManualStore(Array.from({ length: 10 }, (_, i) => ({ ...saved, context: String(i) })), saved)).toHaveLength(8);
    expect(updateWeeklyManualStore([saved], saved)).toHaveLength(1);
  });
});
