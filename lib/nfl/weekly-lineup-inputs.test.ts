import { expect, it } from "vitest";
import { mergeWeeklyRefresh } from "./weekly-lineup-inputs";
import type { WeeklyLineupSnapshot } from "./weekly-lineup";

const base: WeeklyLineupSnapshot = { leagueId: "league", ownerId: "owner", season: 2026, week: 1, scoringId: "exact", leagueName: "League", slots: [], source: "test", retrievedAt: 1, projectionUpdatedAt: null, rosterRetrievedAt: 1,
  players: [{ id: "manual", name: "Manual", positions: ["RB"], availability: "active", kickoffAt: 50, currentSlotId: null, projectedPoints: 15, projectionOrigin: "manual", projectionEnteredAt: 1 }, { id: "model", name: "Model", positions: ["RB"], availability: "active", kickoffAt: 50, currentSlotId: null, projectedPoints: 10, projectionOrigin: "model" }] };
const incoming: WeeklyLineupSnapshot = { ...base, rosterRetrievedAt: 20, players: base.players.map((p) => ({ ...p, projectedPoints: 20, projectionOrigin: "model" })) };

it("preserves manual overrides and their original age, while refreshing automatic values", () => {
  const result = mergeWeeklyRefresh(base, incoming);
  expect(result.sameContext).toBe(true);
  expect(result.snapshot.players.map((p) => p.projectedPoints)).toEqual([15, 20]);
  expect(result.snapshot.players[0].projectionEnteredAt).toBe(1);
  expect(result.snapshot.rosterRetrievedAt).toBe(20);
});

it("preserves an explicit cleared manual value and does not restore a model estimate over it", () => {
  const prior = { ...base, players: base.players.map((p) => ({ ...p, projectedPoints: null })) };
  expect(mergeWeeklyRefresh(prior, incoming).snapshot.players.map((p) => p.projectedPoints)).toEqual([null, 20]);
});

it.each(["leagueId", "ownerId", "season", "week", "scoringId"] as const)("invalidates overrides when %s changes", (key) => {
  const changed = { ...incoming, [key]: typeof incoming[key] === "number" ? (incoming[key] as number) + 1 : "other" };
  expect(mergeWeeklyRefresh(base, changed).snapshot).toBe(changed);
});

it("removes departed players and keeps new players' own source values", () => {
  const next = { ...incoming, players: [{ ...incoming.players[0], id: "new" }] };
  expect(mergeWeeklyRefresh(base, next).snapshot.players).toEqual(next.players);
});
