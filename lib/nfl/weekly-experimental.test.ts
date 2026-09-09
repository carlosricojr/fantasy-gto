import { expect, it } from "vitest";
import { validWeeklyExperimentalEstimate, type WeeklyExperimentalEstimate } from "./weekly-experimental";
import { applyWeeklyModel, mergeWeeklyRefresh, selectWeeklyExperimentalEstimates, type WeeklyModelResponse } from "./weekly-lineup-inputs";
import { planWeeklyLineup, type WeeklyLineupSnapshot } from "./weekly-lineup";
import { createWeeklyDecisionRecord, evaluateWeeklyDecision } from "./decision-journal";
import { parseWeeklyDecisionInput } from "./decision-journal-inputs";

const estimate: WeeklyExperimentalEstimate = { version: 1, points: 12, condition: "active-at-kickoff", method: "frozen-model-returning-history", historyGames: 12, lastPlayed: { season: 2025, index: 10 }, historyGapWeeks: 9, calibration: "ppr-only", scoringScope: "supported-offense", excludedRules: ["st_ff"], evidence: "exploratory-development-tuning" };
const raw = (): WeeklyLineupSnapshot => ({ leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact", leagueName: "Test", slots: [{ id: "wr", label: "WR", eligiblePositions: ["WR"] }], source: "nflverse", retrievedAt: 10, projectionUpdatedAt: null, rosterRetrievedAt: 10,
  model: { source: "nflverse", computedAt: 10, providerUpdatedAt: null, excludedRules: [], warnings: [], coverage: { requested: 1, projected: 0 } },
  players: [{ id: "p", name: "Test", positions: ["WR"], availability: "active", kickoffAt: 1000, currentSlotId: "wr", projectedPoints: null, projectionOrigin: "model", experimentalEstimate: estimate, injuryCoverage: "unavailable" }] });
const options = { now: 20, maxProjectionAgeMs: 100, maxRosterAgeMs: 100, compareAvailableEstimates: true, allowExperimentalEstimates: true };
const preferences = { compareAvailableEstimates: true, allowExperimentalEstimates: true };

it("validates versions, method/calibration pairs, scoring scope, season/history and position", () => {
  expect(validWeeklyExperimentalEstimate(estimate, 2026, 1, ["WR"])).toBe(true);
  for (const patch of [{ version: 2 }, { method: "future" }, { calibration: "validated" }, { scoringScope: "full-league" }, { historyGapWeeks: 8 }, { historyGames: 3 }, { points: NaN }, { points: 10001 }, { lastPlayed: { season: 2024, index: 10 } }, { surprise: true }]) expect(validWeeklyExperimentalEstimate({ ...estimate, ...patch }, 2026, 1, ["WR"])).toBe(false);
  expect(validWeeklyExperimentalEstimate(estimate, 2026, 2, ["WR"])).toBe(false);
  expect(validWeeklyExperimentalEstimate(estimate, 2026, 1, ["K"])).toBe(false);
  const kicker = { ...estimate, method: "kicker-prior-season-game-mean", calibration: "none", scoringScope: "kicking-events-only", historyGames: 9, lastPlayed: { season: 2025, index: 18 }, historyGapWeeks: 1 };
  expect(validWeeklyExperimentalEstimate(kicker, 2026, 1, ["K"])).toBe(true);
  expect(validWeeklyExperimentalEstimate(kicker, 2026, 1, ["WR", "K"])).toBe(false);
});
it("requires independent consent, keeps the raw missing value and preserves manual overrides including cleared values", () => {
  const source = raw();
  expect(selectWeeklyExperimentalEstimates(source, false, 20)).toBe(source);
  const selected = selectWeeklyExperimentalEstimates(source, true, 20);
  expect(selected.players[0]).toMatchObject({ projectedPoints: 12, projectionOrigin: "experimental" });
  expect(source.players[0].projectedPoints).toBeNull();
  expect(planWeeklyLineup(selected, options).status).toBe("conditional");
  expect(planWeeklyLineup(selected, { ...options, allowExperimentalEstimates: false }).status).toBe("blocked");
  expect(planWeeklyLineup(selected, { ...options, compareAvailableEstimates: false }).status).toBe("blocked");
  expect(planWeeklyLineup(selected, options).warnings.join(" ")).toContain("not a validated or availability-adjusted");
  for (const projectedPoints of [0, -1, null]) {
    const prior = { ...source, players: source.players.map(p => ({ ...p, projectedPoints, projectionOrigin: "manual" as const, projectionEnteredAt: 10 })) };
    expect(selectWeeklyExperimentalEstimates(mergeWeeklyRefresh(prior, source).snapshot, true, 20).players[0].projectedPoints).toBe(projectedPoints);
  }
});
it("preserves kickoff, known-Out, source freshness and provenance checks", () => {
  for (const patch of [{ availability: "out" as const }, { availability: "unknown" as const }, { kickoffAt: 20 }, { kickoffAt: null }, { gameContextConflict: true }]) {
    const source = raw(); source.players = [{ ...source.players[0], ...patch }];
    expect(selectWeeklyExperimentalEstimates(source, true, 20).players[0].projectedPoints).toBeNull();
  }
  const selected = selectWeeklyExperimentalEstimates(raw(), true, 20);
  expect(planWeeklyLineup({ ...selected, model: undefined }, options).status).toBe("blocked");
  expect(planWeeklyLineup({ ...selected, model: { ...selected.model!, computedAt: -100 } }, options).status).toBe("blocked");
  expect(planWeeklyLineup({ ...selected, players: selected.players.map(p => ({ ...p, projectionOrigin: "model" })) }, options).status).toBe("blocked");
});
it("applies nested producer evidence without promoting it or clearing another source's Out", () => {
  const source = raw(); source.players = source.players.map(p => ({ ...p, availability: "out" }));
  const response: WeeklyModelResponse = { ...source.model!, season: 2026, week: 1, scoringId: "exact", players: [{ playerId: "p", points: null, reason: "History gap", availability: "active", injuryCoverage: "unavailable", experimentalEstimate: estimate }] };
  const imported = applyWeeklyModel(source, response);
  expect(imported.players[0]).toMatchObject({ projectedPoints: null, availability: "out", experimentalEstimate: estimate });
  expect(imported.model?.coverage.projected).toBe(0);
  expect(selectWeeklyExperimentalEstimates(imported, true, 20).players[0].projectedPoints).toBeNull();
  expect(() => applyWeeklyModel(source, { ...response, players: response.players.map(p => ({ ...p, points: 12 })) })).toThrow("experimental");
});
it("freezes experimental evidence and consent but never counts it as ordinary forecast accuracy", () => {
  const selected = selectWeeklyExperimentalEstimates(raw(), true, 20);
  expect(() => createWeeklyDecisionRecord(JSON.stringify(selected), "{}", 20)).toThrow();
  const saved = createWeeklyDecisionRecord(JSON.stringify(selected), JSON.stringify(preferences), 20);
  expect(saved.preferences.allowExperimentalEstimates).toBe(true);
  expect(saved.snapshot.players[0].experimentalEstimate).toEqual(estimate);
  const actuals = { leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact", fetchedAt: 2000, source: "verified", pointsByPlayer: { p: 8 }, completePlayerIds: ["p"], kickoffByPlayer: { p: 1000 } };
  expect(evaluateWeeklyDecision(saved, actuals)).toMatchObject({ status: "complete", forecastErrors: [], unevaluatedForecastCount: 1 });
  // Defensive handling of records created by a future version, independent of input parsing.
  for (const projectionOrigin of ["future-model", "model"] as const) {
    const unknown = { ...saved, snapshot: { ...saved.snapshot, players: saved.snapshot.players.map(p => ({ ...p, projectionOrigin: projectionOrigin as "model" })) } };
    expect(evaluateWeeklyDecision(unknown, actuals).forecastErrors).toEqual([]);
  }
});
it("journal parsing fails closed on unknown calibration/version/origin instead of stripping evidence", () => {
  for (const patch of [{ calibration: "validated" }, { version: 2 }, { mystery: true }]) {
    const source = raw(); source.players = source.players.map(p => ({ ...p, experimentalEstimate: { ...estimate, ...patch } as WeeklyExperimentalEstimate }));
    expect(() => parseWeeklyDecisionInput(JSON.stringify(source), "{}")).toThrow();
  }
  const source = raw(); source.players = source.players.map(p => ({ ...p, projectionOrigin: "future-model" as "model" }));
  expect(() => parseWeeklyDecisionInput(JSON.stringify(source), "{}")).toThrow();
  expect(parseWeeklyDecisionInput(JSON.stringify(raw()), "{}").preferences.allowExperimentalEstimates).toBe(false);
});
