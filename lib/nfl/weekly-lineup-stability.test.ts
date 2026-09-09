import { describe, expect, it } from "vitest";
import { planWeeklyLineup, type WeeklyLineupSnapshot, type WeeklyPlayer } from "./weekly-lineup";
import { analyzeWeeklyLineupStability } from "./weekly-lineup-stability";

const now = 100_000;
const options = { now, maxProjectionAgeMs: 10_000, maxRosterAgeMs: 10_000 };
const rb = { id: "rb", label: "RB", eligiblePositions: ["RB"] };
const player = (id: string, points: number | null, patch: Partial<WeeklyPlayer> = {}): WeeklyPlayer => ({ id, name: id, positions: ["RB"], availability: "active", kickoffAt: now + 10_000, projectedPoints: points, currentSlotId: null, ...patch });
const snapshot = (players: WeeklyPlayer[], patch: Partial<WeeklyLineupSnapshot> = {}): WeeklyLineupSnapshot => ({ leagueId: "1", ownerId: "2", leagueName: "Test", season: 2026, week: 1, scoringId: "ppr", source: "Synthetic test inputs", retrievedAt: now, rosterRetrievedAt: now, projectionUpdatedAt: now, slots: [rb], players, ...patch });
const swap = (a = 10, b = 12) => snapshot([player("a", a, { currentSlotId: "rb" }), player("b", b)]);

describe("baseline-specific weekly sensitivity", () => {
  it("counts BOTH sides of an actual starter change, not all roster estimates", () => {
    const input = swap();
    expect(analyzeWeeklyLineupStability(input, planWeeklyLineup(input, options))).toEqual({ status: "compared", includedGain: 2, variablePlayerIds: ["a", "b"], stressPoints: 1, adverseMargin: 0, eraseAdvantagePoints: 1 });
  });

  it.each([1, 2, 5] as const)("uses the explicit ±%s radius with the same unmodified plan", (radius) => {
    const input = swap(10, 15);
    const plan = planWeeklyLineup(input, options);
    const before = JSON.stringify({ input, plan });
    expect(analyzeWeeklyLineupStability(input, plan, radius)).toMatchObject({ includedGain: 5, adverseMargin: 5 - 2 * radius, eraseAdvantagePoints: 2.5 });
    expect(JSON.stringify({ input, plan })).toBe(before);
  });

  it("rounds the erase threshold upward, never displaying a too-small sufficient stress", () => {
    const input = swap(10, 10.01);
    expect(analyzeWeeklyLineupStability(input, planWeeklyLineup(input, options))).toMatchObject({ includedGain: 0.01, eraseAdvantagePoints: 0.01, adverseMargin: -1.99 });
    const larger = swap(10, 12.01);
    expect(analyzeWeeklyLineupStability(larger, planWeeklyLineup(larger, options))).toMatchObject({ eraseAdvantagePoints: 1.01 });
  });

  it("uses the solver's cent-rounded values, not sub-cent input differences", () => {
    const input = swap(10.004, 12.004);
    expect(analyzeWeeklyLineupStability(input, planWeeklyLineup(input, options))).toMatchObject({ includedGain: 2, eraseAdvantagePoints: 1 });
  });

  it.each(["out", "inactive", "bye", "reserve"] as const)("keeps a current %s zero fixed, regardless of supplied estimate", (availability) => {
    const input = snapshot([player("a", 99, { currentSlotId: "rb", availability }), player("b", 3)]);
    expect(analyzeWeeklyLineupStability(input, planWeeklyLineup(input, options))).toMatchObject({ includedGain: 3, variablePlayerIds: ["b"], adverseMargin: 2, eraseAdvantagePoints: 3 });
  });

  it("does not confuse a genuine zero-valued active estimate with an unavailable zero", () => {
    const input = swap(0, 3);
    expect(analyzeWeeklyLineupStability(input, planWeeklyLineup(input, options))).toMatchObject({ variablePlayerIds: ["a", "b"], eraseAdvantagePoints: 1.5 });
  });

  it("allows an empty proposed slot and negative supplied values without a false two-player denominator", () => {
    const input = snapshot([player("a", -2, { currentSlotId: "rb" })]);
    expect(analyzeWeeklyLineupStability(input, planWeeklyLineup(input, options))).toMatchObject({ includedGain: 2, variablePlayerIds: ["a"], adverseMargin: 1, eraseAdvantagePoints: 2 });
  });

  it("cancels common, locked and held unpriced players without imputing their values", () => {
    const input = snapshot([
      ...swap().players,
      player("common", 30, { positions: ["WR"], currentSlotId: "wr" }),
      player("locked", 25, { positions: ["QB"], currentSlotId: "qb", kickoffAt: now }),
      player("held", null, { positions: ["K"], currentSlotId: "k" }),
      player("held-bench", null, { positions: ["K"] }),
    ], { slots: [rb, ...["WR", "QB", "K"].map((pos) => ({ id: pos.toLowerCase(), label: pos, eligiblePositions: [pos] }))] });
    const plan = planWeeklyLineup(input, { ...options, holdUnpricedPositions: ["K"] });
    expect(plan.status).toBe("conditional");
    expect(analyzeWeeklyLineupStability(input, plan)).toMatchObject({ includedGain: 2, variablePlayerIds: ["a", "b"], adverseMargin: 0 });
  });

  it("does not analyze blocked, missing, empty-baseline, or mismatched comparisons", () => {
    const input = swap(); const plan = planWeeklyLineup(input, options);
    for (const result of [
      analyzeWeeklyLineupStability(null, null),
      analyzeWeeklyLineupStability(input, { ...plan, status: "blocked" }),
      analyzeWeeklyLineupStability(input, { ...plan, gain: null }),
      analyzeWeeklyLineupStability(input, { ...plan, currentProjectedPoints: null }),
      analyzeWeeklyLineupStability(swap(11, 12), plan),
      analyzeWeeklyLineupStability(input, { ...plan, assignments: [] }),
      analyzeWeeklyLineupStability(input, { ...plan, gain: Number.NaN }),
    ]) expect(result.status).toBe("unavailable");
    const empty = snapshot([player("a", 10)]);
    expect(analyzeWeeklyLineupStability(empty, planWeeklyLineup(empty, options)).status).toBe("unavailable");
  });

  it("reports no membership change for a legal FLEX rearrangement", () => {
    const input = snapshot([player("late", 10, { currentSlotId: "rb", kickoffAt: now + 20_000 }), player("early", 10, { currentSlotId: "flex" })], { slots: [rb, { id: "flex", label: "FLEX", eligiblePositions: ["RB", "WR", "TE"] }] });
    const plan = planWeeklyLineup(input, options);
    expect(plan.assignments.map((a) => a.playerId)).toEqual(["early", "late"]);
    expect(analyzeWeeklyLineupStability(input, plan).status).toBe("no-starter-change");
  });

  it("states zero threshold when the solver picks different starters on an included-points tie", () => {
    const input = snapshot([player("early", 10), player("late", 10, { currentSlotId: "rb", kickoffAt: now + 20_000 })]);
    const plan = planWeeklyLineup(input, options);
    expect(plan.assignments[0].playerId).toBe("early");
    expect(analyzeWeeklyLineupStability(input, plan)).toMatchObject({ includedGain: 0, eraseAdvantagePoints: 0, adverseMargin: -2 });
  });

  it("matches independent exhaustive corner enumeration for multi-player starter sets", () => {
    const input = snapshot([player("a", 5, { currentSlotId: "rb" }), player("b", 6, { currentSlotId: "rb2" }), player("c", 9), player("d", 10), player("common", 30, { positions: ["QB"], currentSlotId: "qb" })], { slots: [rb, { ...rb, id: "rb2" }, { id: "qb", label: "QB", eligiblePositions: ["QB"] }] });
    const plan = planWeeklyLineup(input, options);
    const result = analyzeWeeklyLineupStability(input, plan, 2);
    expect(result.status).toBe("compared");
    if (result.status !== "compared") throw new Error("Expected comparison");
    const next = new Set(plan.assignments.map((a) => a.playerId));
    // All 2^5 corners include the common player: its arbitrary error must cancel.
    const margins = Array.from({ length: 2 ** input.players.length }, (_, mask) => input.players.reduce((sum, p, index) => {
      const perturbed = p.projectedPoints! + ((mask & (1 << index)) ? 2 : -2);
      return sum + (next.has(p.id) ? perturbed : 0) - (p.currentSlotId !== null ? perturbed : 0);
    }, 0));
    expect(result.adverseMargin).toBe(Math.min(...margins));
    expect(result.variablePlayerIds).toEqual(["a", "b", "c", "d"]);
  });

  it("is a bounded explanation even at the maximum supported roster and slot counts", () => {
    const input = snapshot(Array.from({ length: 32 }, (_, i) => player(`p${i}`, i, { currentSlotId: i < 12 ? `s${i}` : null })), { slots: Array.from({ length: 12 }, (_, i) => ({ ...rb, id: `s${i}` })) });
    const plan = planWeeklyLineup(input, options);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) expect(analyzeWeeklyLineupStability(input, plan).status).toBe("compared");
    // Coarse regression ceiling, not a browser latency promise; no solver in loop.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
