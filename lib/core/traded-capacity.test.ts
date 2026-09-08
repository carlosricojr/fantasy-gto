import { expect, it } from "vitest";
import { completeDraft, trimDraftRoster, type DraftPolicyState } from "./draft-policy";
import { canonicalizeState, stateSignature } from "./draft-speculation";
import type { PlayerRisk } from "./roster-utility";

const player = (id: string, weeklyMean: number, position = "WR"): PlayerRisk => ({
  id, name: id, position, weeklyMean, p10: .5, p90: 1.5, availability: 1, byeWeek: 18,
});
const slots = [{ id: "wr", label: "WR", eligiblePositions: ["WR"] }];
const league = { slots, weeks: [1], wireCover: new Map([["WR", 0]]), unprojectedPositions: new Set<string>() };
const state: DraftPolicyState = {
  myTeamIndex: 0, rosterSize: 1,
  teams: [
    { id: "a", name: "A", roster: [player("keeper", 1)], remainingPicks: [1], draftRosterSize: 2 },
    { id: "b", name: "B", roster: [], remainingPicks: [2], draftRosterSize: 1 },
  ],
  available: [player("first", 10), player("second", 5)],
};
it("consumes an extra traded selection before cutting down, never handing it to the next team", () => {
  const complete = completeDraft(state, league, null);
  expect(complete.map((roster) => roster.map((p) => p.id))).toEqual([["keeper", "first"], ["second"]]);
  expect(trimDraftRoster(complete[0], state.rosterSize, slots).map((p) => p.id)).toEqual(["first"]);
  expect(state.teams[0].roster.map((p) => p.id)).toEqual(["keeper"]);
});
it("cuts depth without dropping the only starter at another position", () => {
  const roster = [player("wr1", 100), player("wr2", 99), player("rb", 1, "RB")];
  const allSlots = [...slots, { id: "rb", label: "RB", eligiblePositions: ["RB"] }];
  expect(new Set(trimDraftRoster(roster, 2, allSlots).map((p) => p.id))).toEqual(new Set(["wr1", "rb"]));
});
it("keeps legacy capacity behavior and isolates cache entries", () => {
  const legacy = { ...state, teams: state.teams.map((team) => ({ ...team, draftRosterSize: undefined })) };
  expect(completeDraft(legacy, league, null).map((r) => r.map((p) => p.id))).toEqual([["keeper"], ["first"]]);
  expect(stateSignature(canonicalizeState(state))).not.toBe(stateSignature(canonicalizeState(legacy)));
});
