import { expect, it } from "vitest";
import { applyWeeklyModel, mergeWeeklyRefresh, reconcileWeeklyAvailability, resolveWeeklyRosterTeam, type WeeklyModelResponse } from "./weekly-lineup-inputs";
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

it("retains immutable model omissions, own source time, signed points and observed status", () => {
  const model: WeeklyModelResponse = { source: "nflverse", season: 2026, week: 1, scoringId: "exact", computedAt: 20, providerUpdatedAt: null, warnings: ["PPR calibration"], excludedRules: ["st_ff"], coverage: { requested: 2, projected: 1 }, players: [{ playerId: "manual", points: null, reason: "Out", availability: "out" }, { playerId: "model", points: -1, reason: null, availability: "active" }] };
  const result = applyWeeklyModel(base, model);
  expect(result.players[0].availability).toBe("out");
  expect(result.players[1].projectedPoints).toBe(-1);
  expect(result.players[1].projectionOrigin).toBe("model");
  expect(result.model?.excludedRules).toEqual(["st_ff"]);
  expect(result.model?.providerUpdatedAt).toBeNull();
  expect(() => applyWeeklyModel(base, { ...model, week: 2 })).toThrow("does not match");
  expect(() => applyWeeklyModel(base, { ...model, players: [model.players[0]] })).toThrow("roster");
});

it("does not clear injuries, byes or reserve status because another source merely says active", () => {
  expect(reconcileWeeklyAvailability("questionable", "active")).toBe("questionable");
  expect(reconcileWeeklyAvailability("active", "out")).toBe("out");
  expect(reconcileWeeklyAvailability("bye", "active")).toBe("bye");
  expect(reconcileWeeklyAvailability("reserve", "active")).toBe("reserve");
  expect(reconcileWeeklyAvailability("active", "unknown")).toBe("unknown");
  expect(reconcileWeeklyAvailability("active", undefined)).toBe("active");
});

it("missing injury coverage survives repeated refreshes and cannot clear known Out evidence", () => {
  const prior: WeeklyLineupSnapshot = { ...base, players: base.players.map((p) => ({ ...p, availability: "out", nflverseAvailability: "out", injuryCoverage: "available" })) };
  const partial: WeeklyLineupSnapshot = { ...incoming, players: incoming.players.map((p) => ({ ...p, nflverseAvailability: "active", injuryCoverage: "unavailable" })) };
  const missing = mergeWeeklyRefresh(prior, partial).snapshot;
  expect(missing.players[0].availability).toBe("out");
  expect(missing.players[0].projectedPoints).toBe(15);
  const refreshed = mergeWeeklyRefresh(missing, incoming).snapshot;
  const again = mergeWeeklyRefresh(refreshed, incoming).snapshot;
  expect(again.players[0].availability).toBe("out");
  expect(again.players[0].injuryCoverage).toBe("unavailable");
  const confirmed: WeeklyLineupSnapshot = { ...partial, players: partial.players.map((p) => ({ ...p, injuryCoverage: "available" })) };
  expect(mergeWeeklyRefresh(again, confirmed).snapshot.players[0].availability).toBe("active");
});

it("a roster-only refresh cannot revive a previously observed Out player with a retained manual estimate", () => {
  const prior: WeeklyLineupSnapshot = { ...base, model: { source: "nflverse", computedAt: 10, providerUpdatedAt: null, warnings: [], excludedRules: [], coverage: { requested: 2, projected: 1 } }, players: base.players.map((p) => ({ ...p, availability: "out" })) };
  const result = mergeWeeklyRefresh(prior, incoming).snapshot;
  expect(result.players[0].projectedPoints).toBe(15);
  expect(result.players[0].availability).toBe("out");
  const again = mergeWeeklyRefresh(result, incoming).snapshot;
  expect(again.players[0].projectedPoints).toBe(15);
  expect(again.players[0].availability).toBe("out");
  expect(again.players[0].nflverseAvailability).toBe("out");
});

it("uses the current weekly transaction destination for kickoff identity and rejects conflicting active teams", () => {
  const old = { playerId: "gsis", name: "Traded", position: "RB", season: 2026, week: 1, team: "LA", status: "traded" as const };
  const current = { ...old, team: "BUF", status: "active" as const };
  const ids = [{ sleeperId: "123", gsisId: "gsis" }];
  expect(resolveWeeklyRosterTeam("123", ["RB"], 2026, 1, ids, [old, current])).toBe("BUF");
  expect(resolveWeeklyRosterTeam("123", ["RB"], 2026, 1, ids, [{ ...old, status: "active" }, current])).toBeNull();
  expect(resolveWeeklyRosterTeam("123", ["RB"], 2026, 1, [], [current])).toBeNull();
  expect(resolveWeeklyRosterTeam("HOU", ["DST"], 2026, 1, [], [])).toBe("HOU");
});

it("a changed game invalidates a retained manual projection", () => {
  const prior = { ...base, players: base.players.map((p) => ({ ...p, team: "LA", gameId: "old" })) };
  const changed = { ...incoming, players: incoming.players.map((p) => ({ ...p, team: "BUF", gameId: "new" })) };
  const result = mergeWeeklyRefresh(prior, changed).snapshot.players[0];
  expect(result.projectedPoints).toBeNull();
  expect(result.projectionMissingReason).toContain("Matchup");
});

it("retains a blocking conflict when model and imported kickoff contexts disagree", () => {
  const model: WeeklyModelResponse = { source: "nflverse", season: 2026, week: 1, scoringId: "exact", computedAt: 20, providerUpdatedAt: null, warnings: [], excludedRules: [], coverage: { requested: 2, projected: 2 }, players: base.players.map((p) => ({ playerId: p.id, points: 10, reason: null, team: "BUF", gameId: "new", kickoffAt: 30 })) };
  const prior = { ...base, players: base.players.map((p) => ({ ...p, team: "LA", gameId: "old" })) };
  const result = applyWeeklyModel(prior, model);
  expect(result.players.every((p) => p.gameContextConflict)).toBe(true);
  const refreshed = mergeWeeklyRefresh(result, prior).snapshot;
  expect(refreshed.players.every((p) => p.gameContextConflict)).toBe(true);
  expect(mergeWeeklyRefresh(refreshed, prior).snapshot.players.every((p) => p.gameContextConflict)).toBe(true);
  const noGameEvidence = applyWeeklyModel(prior, { ...model, players: model.players.map((p) => ({ playerId: p.playerId, points: null, reason: "No identity" })) });
  expect(mergeWeeklyRefresh(refreshed, noGameEvidence).snapshot.players.every((p) => p.gameContextConflict)).toBe(true);
});
