import { describe, expect, it } from "vitest";
import { summarizeDecisionResults, type DecisionResultsInput } from "./decision-results";

function input(id = "one", options: { at?: number; week?: number; owner?: string; timing?: string; difference?: number; status?: string; origin?: string; excluded?: string[]; scoringId?: string } = {}): DecisionResultsInput {
  return { _id: id, recordJson: JSON.stringify({ version: 1, recordedAt: options.at ?? 100, timing: options.timing ?? "before-listed-kickoffs", snapshot: { leagueId: "league", ownerId: options.owner ?? "owner", leagueName: "League", season: 2026, week: options.week ?? 1, scoringId: options.scoringId ?? "half-ppr", players: [{ projectedPoints: 10, projectionOrigin: "origin" in options ? options.origin : "manual" }] }, plan: { status: "ready", excludedSlotIds: options.excluded ?? [], excludedPlayerIds: [] } }), observations: [{ observedAt: 1000, evaluationJson: JSON.stringify({ status: options.status ?? "complete", recommendedActualPoints: 10 + (options.difference ?? -2), originalActualPoints: 10, actualDifference: options.difference ?? -2 }) }] };
}

describe("bounded descriptive decision-results protocol", () => {
  it("chooses the latest pre-kickoff revision without looking at outcomes", () => {
    const report = summarizeDecisionResults([input("winner", { at: 100, difference: 20 }), input("loser", { at: 200, difference: -5 })]);
    expect(report.revisions).toBe(1);
    expect(report.rows).toMatchObject([{ id: "loser", difference: -5 }]);
    expect(report.cohorts[0]).toMatchObject({ complete: 1, weeks: 1, difference: -5, meanDifference: -5 });
  });
  it.each(["pending", "ineligible"])("does not fall back to a completed winner when the newest receipt is %s", status => {
    const report = summarizeDecisionResults([input("winner", { at: 100, difference: 20 }), input("latest", { at: 200, status })]);
    expect(report.rows).toMatchObject([{ id: "latest", status, difference: null }]);
    expect(report.cohorts[0]).toMatchObject({ complete: 0, difference: null, meanDifference: null });
  });
  it("uses a deterministic ID tie breaker unrelated to results", () => {
    expect(summarizeDecisionResults([input("z", { difference: 10 }), input("a", { difference: -10 })]).rows[0].id).toBe("a");
  });
  it("excludes late and unknown timing but retains earlier pre-kickoff decisions", () => {
    const result = summarizeDecisionResults([input(), input("late", { at: 200, timing: "after-listed-kickoff", difference: 100 }), input("unknown", { timing: "unknown-kickoff" })]);
    expect(result.lateOrUnknownRecords).toBe(2);
    expect(result.rows[0].difference).toBe(-2);
  });
  it("separates ordinary, limited and experimental scopes including unknown future origins", () => {
    const report = summarizeDecisionResults([input("plain", { origin: "manual" }), input("limited", { week: 2, origin: "model", excluded: ["k"], difference: 10 }), input("conditional", { week: 3, origin: "model-conditional", difference: 4 }), input("experiment", { week: 4, origin: "experimental", difference: 7 }), input("future", { week: 5, origin: "new-origin", difference: 8 }), input("missing", { week: 6, origin: undefined, difference: -3 })]);
    expect(Object.fromEntries(report.cohorts.map(group => [group.cohort, [group.complete, group.difference]]))).toEqual({ unrestricted: [1, -2], limited: [2, 14], experimental: [3, 12] });
  });
  it.each([0, -2, 10])("segregates missing provenance for every finite supplied value, including %s", projectedPoints => {
    const saved = input("mixed", { origin: "model" });
    const record = JSON.parse(saved.recordJson);
    record.snapshot.players.push({ projectedPoints });
    saved.recordJson = JSON.stringify(record);
    expect(summarizeDecisionResults([saved]).rows[0].cohort).toBe("experimental");
  });
  it.each(["manual", "model"])("keeps declared %s inputs ordinary without treating unpriced players as unknown forecasts", origin => {
    const saved = input("declared", { origin });
    const record = JSON.parse(saved.recordJson);
    record.snapshot.players.push({ projectedPoints: null });
    saved.recordJson = JSON.stringify(record);
    expect(summarizeDecisionResults([saved]).rows[0].cohort).toBe("unrestricted");
  });
  it("keeps teams and scoring systems separate instead of summing incomparable points", () => {
    const report = summarizeDecisionResults([input("one"), input("two", { owner: "second" }), input("three", { week: 2 }), input("new-score", { week: 3, scoringId: "ppr" })]);
    expect(report.cohorts).toHaveLength(3);
    expect(report.cohorts[0]).toMatchObject({ complete: 1, weeks: 1, difference: -2 });
    expect(report.cohorts.find(group => group.complete === 2)).toMatchObject({ weeks: 2, difference: -4 });
  });
  it("uses the latest stat correction, including signed or zero differences", () => {
    const saved = input();
    saved.observations = [...input("x", { difference: 0 }).observations.map(o => ({ ...o, observedAt: 2000 })), ...saved.observations];
    expect(summarizeDecisionResults([saved]).rows[0].difference).toBe(0);
  });
  it("does not replace a newer pending or corrupt observation with an older completed one", () => {
    for (const evaluationJson of ["{}", JSON.stringify({ status: "pending", originalActualPoints: null, recommendedActualPoints: null, actualDifference: null })]) {
      const saved = input(); saved.observations = [...saved.observations, { observedAt: 2000, evaluationJson }];
      expect(summarizeDecisionResults([saved]).rows[0].difference).toBeNull();
    }
  });
  it("treats no observation as pending, never zero", () => {
    expect(summarizeDecisionResults([{ ...input(), observations: [] }]).rows[0]).toMatchObject({ status: "pending", difference: null });
  });
  it.each([
    { status: "complete", recommendedActualPoints: null, originalActualPoints: 10, actualDifference: 2 },
    { status: "complete", recommendedActualPoints: 12, originalActualPoints: 10, actualDifference: 200 },
    { status: "complete", recommendedActualPoints: 1e20, originalActualPoints: 10, actualDifference: 1e20 - 10 },
  ])("fails closed on inconsistent complete totals %j", evaluation => {
    const saved = input(); saved.observations = [{ observedAt: 1000, evaluationJson: JSON.stringify(evaluation) }];
    expect(summarizeDecisionResults([saved]).rows[0]).toMatchObject({ status: "unavailable", difference: null });
  });
  it("reports unreadable records rather than claiming complete history", () => {
    const result = summarizeDecisionResults([{ ...input(), recordJson: "{}" }]);
    expect(result).toMatchObject({ inspected: 1, invalidRecords: 1, rows: [] });
  });
  it.each(["missing-plan-field", "unsupported-version", "oversized-observations"])("never resurrects an older winner after newest receipt corruption: %s", kind => {
    const newer = input("newer", { at: 200, difference: -5 });
    const raw = JSON.parse(newer.recordJson);
    if (kind === "missing-plan-field") delete raw.plan.excludedPlayerIds;
    if (kind === "unsupported-version") raw.version = 999;
    if (kind === "oversized-observations") newer.observations = Array.from({ length: 21 }, () => newer.observations[0]);
    newer.recordJson = JSON.stringify(raw);
    const result = summarizeDecisionResults([input("older", { difference: 20 }), newer]);
    expect(result).toMatchObject({ invalidRecords: 1, rows: [], cohorts: [] });
  });
  it("rejects duplicate IDs and oversized batches instead of silently truncating", () => {
    expect(() => summarizeDecisionResults([input(), input()])).toThrow("Duplicate");
    expect(() => summarizeDecisionResults(Array.from({ length: 21 }, (_, i) => input(String(i))))).toThrow("bounded batch");
  });
  it("keeps conflicting same-time and pre-receipt observations unavailable", () => {
    const saved = input();
    saved.observations = [...saved.observations, ...input("x", { difference: 99 }).observations];
    expect(summarizeDecisionResults([saved]).rows[0].status).toBe("unavailable");
    saved.observations = saved.observations.map(o => ({ ...o, observedAt: 0 }));
    expect(summarizeDecisionResults([saved]).rows[0].status).toBe("unavailable");
  });
});
