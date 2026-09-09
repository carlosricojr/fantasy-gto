import { describe, expect, it } from "vitest";
import { createWeeklyDecisionRecord, evaluateWeeklyDecision, type WeeklyDecisionOutcomes } from "./decision-journal";
import { parseWeeklyDecisionInput, MAX_DECISION_JSON_LENGTH } from "./decision-journal-inputs";
import type { WeeklyLineupSnapshot, WeeklyPlayer } from "./weekly-lineup";

const now = 1_800_000_000_000;
const player = (id: string, points: number | null, patch: Partial<WeeklyPlayer> = {}): WeeklyPlayer => ({ id, name: id, positions: ["RB"], projectedPoints: points, availability: "active", kickoffAt: now + 10000, currentSlotId: null, ...patch });
const snapshot = (patch: Partial<WeeklyLineupSnapshot> = {}): WeeklyLineupSnapshot => ({ leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact-rules", leagueName: "Test", source: "Test", retrievedAt: now, projectionUpdatedAt: now, rosterRetrievedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [player("original", 10, { currentSlotId: "rb" }), player("recommended", 15), player("hindsight", 5)], ...patch });
const record = (data = snapshot(), preferences = {}) => createWeeklyDecisionRecord(JSON.stringify(data), JSON.stringify(preferences), now);
const outcomes = (patch: Partial<WeeklyDecisionOutcomes> = {}): WeeklyDecisionOutcomes => ({ leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact-rules", fetchedAt: now + 100000, source: "Verified source", pointsByPlayer: { original: 12, recommended: 8, hindsight: 40 }, completePlayerIds: ["original", "recommended", "hindsight"], kickoffByPlayer: { original: now + 10000, recommended: now + 10000, hindsight: now + 10000 }, ...patch });

describe("private pre-kickoff decision journal", () => {
  it("recomputes and freezes the recommendation against original starters, not hindsight winners", () => {
    const saved = record();
    expect(saved.recordedAt).toBe(now);
    expect(saved.inputProvenance).toBe("user-supplied");
    expect(saved.plan.assignments[0].playerId).toBe("recommended");
    expect(evaluateWeeklyDecision(saved, outcomes())).toMatchObject({ status: "complete", recommendedActualPoints: 8, originalActualPoints: 12, actualDifference: -4, forecastErrors: [{ origin: "unspecified", count: 3, meanAbsoluteError: 44 / 3 }] });
    expect(saved.plan.assignments[0].playerId).toBe("recommended");
  });
  it("never accepts a submitted plan, unknown fields, or oversized JSON", () => {
    expect(() => record({ ...snapshot(), plan: {} } as WeeklyLineupSnapshot)).toThrow();
    expect(() => parseWeeklyDecisionInput(" ".repeat(MAX_DECISION_JSON_LENGTH + 1), "{}")).toThrow("too large");
    expect(() => parseWeeklyDecisionInput("{", "{}")).toThrow();
    expect(() => record(snapshot(), { surprise: true })).toThrow();
  });
  it.each([NaN, Infinity, -1, 8.65e15])("rejects invalid receiving clocks: %s", clock => {
    expect(() => createWeeklyDecisionRecord(JSON.stringify(snapshot()), "{}", clock)).toThrow("receipt time");
  });
  it("rejects stale or failed roster refreshes, old manual inputs, and missing comparison consent", () => {
    for (const patch of [{ rosterRetrievedAt: now - 900001 }, { refreshFailed: true }, { retrievedAt: now + 1 }]) expect(() => record(snapshot(patch))).toThrow("not recorded");
    expect(() => record(snapshot({ players: [player("old", 20, { projectionOrigin: "manual", projectionEnteredAt: now - 86400001 })] }))).toThrow("manual estimate");
    expect(() => record(snapshot({ players: [player("missing", null)] }))).toThrow("not recorded");
  });
  it("stores late decisions honestly but excludes them from prospective evaluation", () => {
    const saved = record(snapshot({ players: [player("original", 10, { currentSlotId: "rb", kickoffAt: now })] }));
    expect(saved.timing).toBe("after-listed-kickoff");
    expect(evaluateWeeklyDecision(saved, outcomes()).status).toBe("ineligible");
  });
  it("independently detects falsely future listed kickoffs", () => {
    expect(evaluateWeeklyDecision(record(), outcomes({ kickoffByPlayer: { original: now, recommended: now + 10000 } }))).toMatchObject({ status: "ineligible", actualDifference: null });
  });
  it("does not invalidate a pre-game comparison because an unrelated bench player has a bye", () => {
    const saved = record(snapshot({ players: [...snapshot().players, player("bye", null, { availability: "bye", kickoffAt: null })] }));
    expect(saved.timing).toBe("before-listed-kickoffs");
    expect(evaluateWeeklyDecision(saved, outcomes()).status).toBe("complete");
  });
  it.each([{ leagueId: "999" }, { ownerId: "999" }, { season: 2027 }, { week: 2 }, { scoringId: "other" }, { fetchedAt: now - 1 }, { source: "" }])("rejects mismatched context/provenance %j", patch => {
    expect(evaluateWeeklyDecision(record(), outcomes(patch)).status).toBe("ineligible");
  });
  it("keeps zero scores pending until game completion, and preserves signed final outcomes", () => {
    expect(evaluateWeeklyDecision(record(), outcomes({ pointsByPlayer: { original: 0, recommended: 0 }, completePlayerIds: [] }))).toMatchObject({ status: "pending", actualDifference: null });
    expect(evaluateWeeklyDecision(record(), outcomes({ pointsByPlayer: { original: 0, recommended: -2 } }))).toMatchObject({ status: "complete", actualDifference: -2 });
  });
  it.each<Partial<WeeklyDecisionOutcomes>>([{ pointsByPlayer: { original: 12 } }, { pointsByPlayer: { original: 12, recommended: NaN } }, { kickoffByPlayer: {} }, { completePlayerIds: ["original"] }])("never turns missing evidence into zero: %j", patch => {
    expect(evaluateWeeklyDecision(record(), outcomes(patch))).toMatchObject({ status: "pending", actualDifference: null });
  });
  it("excludes held unpriced slots from both frozen totals and labels the scope", () => {
    const saved = record(snapshot({ slots: [...snapshot().slots, { id: "k", label: "K", eligiblePositions: ["K"] }], players: [...snapshot().players, player("k", null, { positions: ["K"], currentSlotId: "k" })] }), { holdUnpricedPositions: ["K"] });
    expect(evaluateWeeklyDecision(saved, outcomes())).toMatchObject({ status: "complete", actualDifference: -4, comparedPlayerIds: ["recommended", "original"], scope: "included-estimates" });
  });
  it("separates manual/full-scoring model errors, and excludes partial or conditional model accuracy", () => {
    const data = snapshot({ players: [player("original", 10, { currentSlotId: "rb", projectionOrigin: "manual", projectionEnteredAt: now }), player("recommended", 15, { projectionOrigin: "model" })], model: { source: "model", computedAt: now, providerUpdatedAt: now, excludedRules: [], warnings: [], coverage: { requested: 2, projected: 1 } } });
    expect(evaluateWeeklyDecision(record(data), outcomes()).forecastErrors).toEqual([{ origin: "model", count: 1, meanAbsoluteError: 7 }, { origin: "manual", count: 1, meanAbsoluteError: 2 }]);
    data.model!.excludedRules = ["st_ff"];
    const partial = evaluateWeeklyDecision(record(data, { compareAvailableEstimates: true }), outcomes());
    expect(partial.forecastErrors).toEqual([{ origin: "manual", count: 1, meanAbsoluteError: 2 }]);
    expect(partial.unevaluatedForecastCount).toBe(1);
    data.players = [data.players[0], player("recommended", 15, { projectionOrigin: "model-conditional", injuryCoverage: "unavailable", conditionalEstimate: { points: 15, condition: "active-at-kickoff", missingEvidence: "team-injury-report" } })];
    expect(() => record(data, { compareAvailableEstimates: true })).toThrow();
    expect(evaluateWeeklyDecision(record(data, { compareAvailableEstimates: true, allowConditionalEstimates: true }), outcomes()).forecastErrors).toEqual([{ origin: "manual", count: 1, meanAbsoluteError: 2 }]);
  });
});
