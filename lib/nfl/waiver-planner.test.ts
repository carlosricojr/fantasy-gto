import { describe, expect, it } from "vitest";
import { compareWeeklyWaivers, WAIVER_ROSTER_MAX_AGE_MS, type WaiverComparisonInput } from "./waiver-planner";
import type { WeeklyPlayer } from "./weekly-lineup";

const now = 100000;
const options = { now, compareAvailableEstimates: false, allowConditionalEstimates: false };
const rb = { id: "rb", label: "RB", eligiblePositions: ["RB"] };
const flex = { id: "flex", label: "FLEX", eligiblePositions: ["RB", "WR", "TE"] };
const player = (id: string, points: number | null, patch: Partial<WeeklyPlayer> = {}): WeeklyPlayer => ({ id, name: id, positions: ["RB"], projectedPoints: points, availability: "active", kickoffAt: now + 20000, currentSlotId: null, ...patch });
const input = (players = [player("own-rb", 10, { currentSlotId: "rb" }), player("bench-wr", 15, { positions: ["WR"] }), player("starter-wr", 1, { positions: ["WR"], currentSlotId: "flex" })], candidates = [player("add-rb", 12)]): WaiverComparisonInput => ({
  roster: { leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "exact-test", leagueName: "Synthetic", source: "Synthetic forecast", slots: [rb, flex], players, retrievedAt: now, projectionUpdatedAt: now, rosterRetrievedAt: now },
  candidates, ownership: { leagueId: "123", ownerId: "456", rosterId: 6, rosterCount: 10, ownPlayerIds: players.map((p) => p.id), ownedPlayerIds: [...players.map((p) => p.id), "opponent"], protectedPlayerIds: [], retrievedAt: now }, availableCount: 100,
});
describe("one-week marginal add/drop comparison", () => {
  it("compares against the optimized existing roster, not inefficient current starters or raw added points", () => {
    const result = compareWeeklyWaivers(input(), options);
    expect(result.baseline?.projectedPoints).toBe(25);
    expect(result.baseline?.currentProjectedPoints).toBe(11);
    expect(result.choices[0].marginalPoints).toBe(2);
    expect(result.choices.find((p) => p.dropId === "bench-wr")?.marginalPoints).toBe(-3);
    expect(result.coverage).toEqual({ available: 100, selected: 1, eligibleAdds: 1, eligibleDrops: 3, evaluatedPairs: 3, unknownPairs: 0 });
  });
  it("a lower raw projection can improve the roster more than a high redundant QB", () => {
    const data = input([player("qb", 30, { positions: ["QB"], currentSlotId: "qb" }), player("rb", 5, { currentSlotId: "rb" }), player("bench", 1)], [player("qb-add", 25, { positions: ["QB"] }), player("rb-add", 10)]);
    data.roster.slots = [{ id: "qb", label: "QB", eligiblePositions: ["QB"] }, rb];
    const result = compareWeeklyWaivers(data, options);
    expect(result.choices[0].addId).toBe("rb-add");
    expect(result.choices[0].marginalPoints).toBe(5);
    expect(Math.max(...result.choices.filter((p) => p.addId === "qb-add").map((p) => p.marginalPoints))).toBe(0);
  });
  it("keeps no change as a zero baseline, distinguishing no improvement from unknown", () => {
    expect(compareWeeklyWaivers(input(undefined, [player("weak", 0)]), options).status).toBe("no-improvement");
    expect(compareWeeklyWaivers(input(undefined, [player("unpriced", null)]), options).status).toBe("unknown");
  });
  it.each([{ kickoffAt: now }, { kickoffAt: null }, { availability: "out" as const }, { availability: "unknown" as const }, { gameContextConflict: true }, { projectedPoints: null }])("does not rank invalid/unpriced addition %j", (patch) => {
    const result = compareWeeklyWaivers(input(undefined, [player("add", 100, patch)]), options);
    expect(result.choices).toHaveLength(0);
    expect(result.excluded.some((p) => p.role === "add")).toBe(true);
  });
  it("preserves started starters and bench locks and protects reserve/taxi holdings", () => {
    const data = input([player("locked", 10, { kickoffAt: now, currentSlotId: "rb" }), player("locked-bench", 100, { kickoffAt: now }), player("taxi", 1), player("drop", 1)]);
    data.ownership.protectedPlayerIds = ["taxi"];
    const result = compareWeeklyWaivers(data, options);
    expect(result.choices.map((p) => p.dropId)).toEqual(["drop"]);
    expect(result.choices[0].lineup.assignments[0]).toMatchObject({ playerId: "locked", fixed: true });
    expect(result.choices[0].lineup.benchIds).toContain("locked-bench");
  });
  it("holds unpriced FLEX, K and bench players fixed instead of gaining by deleting unknown value", () => {
    const data = input([player("missing", null, { currentSlotId: "flex" }), player("missing-bench", null), player("k", null, { positions: ["K"], currentSlotId: "k" }), player("known", 10)]);
    data.roster.slots = [rb, flex, { id: "k", label: "K", eligiblePositions: ["K"] }];
    expect(compareWeeklyWaivers(data, options).status).toBe("blocked");
    const result = compareWeeklyWaivers(data, { ...options, compareAvailableEstimates: true });
    expect(result.choices.map((p) => p.dropId)).toEqual(["known"]);
    expect(result.choices[0].marginalPoints).toBe(2);
    expect(result.choices[0].lineup.excludedSlotIds).toEqual(result.baseline?.excludedSlotIds);
    expect(result.choices[0].lineup.excludedPlayerIds).toEqual(result.baseline?.excludedPlayerIds);
  });
  it("carries the same model/scoring provenance into candidates and requires explicit conditional consent", () => {
    const data = input(undefined, [player("conditional", 20, { projectionOrigin: "model-conditional", injuryCoverage: "unavailable", conditionalEstimate: { points: 20, condition: "active-at-kickoff", missingEvidence: "team-injury-report" } })]);
    data.roster.model = { source: "model", computedAt: now, providerUpdatedAt: null, excludedRules: ["st_ff"], warnings: ["PPR calibration only"], coverage: { requested: 4, projected: 3 } };
    const denied = compareWeeklyWaivers(data, { ...options, compareAvailableEstimates: true });
    expect(denied.status).toBe("unknown");
    expect(denied.coverage.unknownPairs).toBe(3);
    const result = compareWeeklyWaivers(data, { ...options, compareAvailableEstimates: true, allowConditionalEstimates: true });
    expect(result.status).toBe("improvement");
    expect(result.choices[0].lineup.warnings.join(" ")).toContain("st_ff");
    expect(result.choices[0].lineup.warnings.join(" ")).toContain("not availability-adjusted");
  });
  it.each([NaN, now + 1, now - WAIVER_ROSTER_MAX_AGE_MS - 1])("blocks invalid ownership timestamp %s", (retrievedAt) => {
    const data = input(); data.ownership.retrievedAt = retrievedAt;
    expect(compareWeeklyWaivers(data, options).status).toBe("blocked");
  });
  it("refuses rostered, duplicate, wrong-context candidates and mismatched ownership", () => {
    const cases = [input(undefined, [player("opponent", 100)]), input(undefined, [player("dup", 1), player("dup", 2)]), input(undefined, [player("starter", 10, { currentSlotId: "rb" })])];
    const mismatch = input(); mismatch.ownership.ownerId = "other"; cases.push(mismatch);
    const missing = input(); missing.ownership.ownPlayerIds = []; cases.push(missing);
    const stale = input(); stale.roster.refreshFailed = true; cases.push(stale);
    for (const data of cases) expect(compareWeeklyWaivers(data, options).status).toBe("blocked");
  });
  it("rejects candidate and state-space budget overflows before scoring", () => {
    const data = input(undefined, Array.from({ length: 13 }, (_, i) => player(`add${i}`, 1)));
    expect(compareWeeklyWaivers(data, options).status).toBe("blocked");
    const large = input(Array.from({ length: 25 }, (_, i) => player(`own${i}`, 1)));
    expect(compareWeeklyWaivers(large, options).status).toBe("blocked");
    const slots = input(); slots.roster.slots = Array.from({ length: 11 }, (_, i) => ({ ...rb, id: `slot${i}` }));
    expect(compareWeeklyWaivers(slots, options).status).toBe("blocked");
  });
  it("matches independent brute-force assignment for every pair over deterministic heterogeneous synthetic cases", () => {
    const brute = (players: readonly WeeklyPlayer[], slots: typeof rb[]): number => {
      const walk = (i: number, used: Set<string>): number => i === slots.length ? 0 : Math.max(walk(i + 1, used), ...players.filter((p) => !used.has(p.id) && p.positions.some((pos) => slots[i].eligiblePositions.includes(pos))).map((p) => Math.round(p.projectedPoints! * 100) + walk(i + 1, new Set([...used, p.id]))));
      return walk(0, new Set()) / 100;
    };
    for (let n = 0; n < 24; n += 1) {
      const players = Array.from({ length: 5 }, (_, i) => player(`own${i}`, ((i * 13 + n * 7) % 41 - 9) / 3, { positions: i % 2 ? ["WR"] : ["RB"] }));
      const candidates = [player("add0", n / 2, { positions: ["WR"] }), player("add1", 4.125, { positions: ["RB", "WR"] })];
      const data = input(players, candidates);
      const result = compareWeeklyWaivers(data, options);
      expect(result.baseline?.projectedPoints).toBe(brute(players, [rb, flex]));
      expect(result.choices).toHaveLength(10);
      for (const choice of result.choices) {
        const changed = [...players.filter((p) => p.id !== choice.dropId), candidates.find((p) => p.id === choice.addId)!];
        expect(choice.marginalPoints).toBeCloseTo(brute(changed, [rb, flex]) - brute(players, [rb, flex]), 8);
        const assigned = choice.lineup.assignments.map((a) => a.playerId).filter(Boolean);
        expect(new Set(assigned).size).toBe(assigned.length);
        expect(assigned).not.toContain(choice.dropId);
      }
    }
  });
});
