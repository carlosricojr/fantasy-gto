import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement as h } from "react";
import { DecisionRecordView } from "@/components/decision-history";
import { WeeklyDecisionSave } from "@/components/weekly-decision-save";
import { createWeeklyDecisionRecord, evaluateWeeklyDecision, type WeeklyDecisionOutcomes } from "@/lib/nfl/decision-journal";
import type { WeeklyLineupSnapshot } from "@/lib/nfl/weekly-lineup";

const now = 100000;
const snapshot: WeeklyLineupSnapshot = { leagueId: "123", ownerId: "456", leagueName: "Private league", season: 2026, week: 1, scoringId: "exact", source: "Manual source", retrievedAt: now, projectionUpdatedAt: now, rosterRetrievedAt: now, slots: [{ id: "rb", label: "RB", eligiblePositions: ["RB"] }], players: [ { id: "a", name: "Original", positions: ["RB"], currentSlotId: "rb", projectedPoints: 5, availability: "active", kickoffAt: now + 1000 }, { id: "b", name: "Suggested", positions: ["RB"], currentSlotId: null, projectedPoints: 10, availability: "active", kickoffAt: now + 1000 } ] };
const record = createWeeklyDecisionRecord(JSON.stringify(snapshot), "{}", now);
const outcomes: WeeklyDecisionOutcomes = { leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact", fetchedAt: now + 2000, source: "Observed source", pointsByPlayer: { a: 3, b: -2 }, completePlayerIds: ["a", "b"], kickoffByPlayer: { a: now + 1000, b: now + 1000 } };

describe("decision history presentation", () => {
  it("shows both frozen lineups, signed losses, and narrow evidence scope", () => {
    const html = renderToStaticMarkup(h(DecisionRecordView, { detail: { _id: "id", recordJson: JSON.stringify(record), observations: [{ observedAt: outcomes.fetchedAt, outcomeJson: JSON.stringify(outcomes), evaluationJson: JSON.stringify(evaluateWeeklyDecision(record, outcomes)) }] } }));
    expect(html).toContain("Original"); expect(html).toContain("Suggested");
    expect(html).toContain("difference -5.00 points");
    expect(html).toContain("User-supplied inputs");
    expect(html).toContain("One observed comparison is not an established advantage");
  });
  it("does not render an actual score for pending games", () => {
    const html = renderToStaticMarkup(h(DecisionRecordView, { detail: { _id: "id", recordJson: JSON.stringify(record), observations: [{ observedAt: outcomes.fetchedAt, outcomeJson: JSON.stringify(outcomes), evaluationJson: JSON.stringify(evaluateWeeklyDecision(record, { ...outcomes, completePlayerIds: [] })) }] } }));
    expect(html).toContain("Pending:");
    expect(html).not.toContain("difference -5.00 points");
  });
  it("fails gracefully on unsupported stored record formats", () => {
    expect(renderToStaticMarkup(h(DecisionRecordView, { detail: { _id: "id", recordJson: "{}", observations: [] } }))).toContain("format is unavailable");
  });
  it("does not offer a private write when signed out or without capability", () => {
    const props = { snapshot, preferences: record.preferences, disabled: false, save: async () => "id" };
    expect(renderToStaticMarkup(h(WeeklyDecisionSave, { ...props, access: "signed-out" }))).toContain("Sign in to save");
    const unavailable = renderToStaticMarkup(h(WeeklyDecisionSave, { ...props, access: "unavailable" }));
    expect(unavailable).toContain("not included in your current plan");
    expect(unavailable).not.toContain("<button");
    expect(renderToStaticMarkup(h(WeeklyDecisionSave, { ...props, access: "enabled", disabled: true }))).toContain("disabled=");
  });
});
