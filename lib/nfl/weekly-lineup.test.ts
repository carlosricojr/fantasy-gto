import { describe, expect, it } from "vitest";
import { planWeeklyLineup, type WeeklyLineupSnapshot, type WeeklyPlayer } from "./weekly-lineup";

const now = 100000;
const options = { now, maxProjectionAgeMs: 10000, maxRosterAgeMs: 10000 };
const rb = { id: "rb", label: "RB", eligiblePositions: ["RB"] };
const flex = { id: "flex", label: "FLEX", eligiblePositions: ["RB", "WR", "TE"] };
const player = (id: string, points: number | null, patch: Partial<WeeklyPlayer> = {}): WeeklyPlayer => ({ id, name: id, positions: ["RB"], projectedPoints: points, availability: "active", kickoffAt: now + 10000, currentSlotId: null, ...patch });
const snapshot = (players: WeeklyPlayer[], patch: Partial<WeeklyLineupSnapshot> = {}): WeeklyLineupSnapshot => ({ leagueId: "123", ownerId: "456", season: 2026, week: 1, scoringId: "test-exact-rules", leagueName: "Test", source: "Test forecast", slots: [rb, flex], players, retrievedAt: now, projectionUpdatedAt: now, rosterRetrievedAt: now, ...patch });

describe("weekly lineup decision safety", () => {
  it("keeps kicked-off starters in their actual slot and kicked-off bench players benched", () => {
    const result = planWeeklyLineup(snapshot([
      player("locked", 1, { currentSlotId: "flex", kickoffAt: now }),
      player("bench-locked", 100, { kickoffAt: now - 1 }),
      player("movable", 20),
    ]), options);
    expect(result.assignments).toEqual([
      { slotId: "rb", playerId: "movable", points: 20, fixed: false },
      { slotId: "flex", playerId: "locked", points: 1, fixed: true },
    ]);
    expect(result.benchIds).toContain("bench-locked");
  });

  it("preserves future flexibility only after maximizing expected points", () => {
    const data = snapshot([player("late", 11, { kickoffAt: now + 20000 }), player("early", 10)]);
    const result = planWeeklyLineup(data, options);
    expect(result.assignments.map((a) => a.playerId)).toEqual(["early", "late"]);
    expect(result.projectedPoints).toBe(21);
    expect(planWeeklyLineup({ ...data, players: [...data.players].reverse() }, options)).toEqual(result);
  });

  it.each(["out", "inactive", "bye", "reserve"] as const)("excludes %s before kickoff but preserves a locked occupied slot", (availability) => {
    const result = planWeeklyLineup(snapshot([player("excluded", 100, { availability }), player("active", 10)]), options);
    expect(result.benchIds).toContain("excluded");
    const locked = planWeeklyLineup(snapshot([player("excluded", 100, { availability, currentSlotId: "rb", kickoffAt: now }), player("active", 10)]), options);
    expect(locked.assignments[0]).toEqual({ slotId: "rb", playerId: "excluded", points: 0, fixed: true });
  });

  it("does not silently drop an unprojected eligible player", () => {
    const result = planWeeklyLineup(snapshot([player("missing", null), player("known", 10)]), options);
    expect(result.status).toBe("blocked");
    expect(result.problems).toContain("missing: missing exact weekly projection.");
    expect(result.projectedPoints).toBeNull();
  });

  it("an unpriced bench player cannot block a slot already occupied by a locked starter", () => {
    const data = snapshot([player("missing-qb", null, { positions: ["QB"] }), player("locked-qb", 20, { positions: ["QB"], currentSlotId: "qb", kickoffAt: now }), player("rb", 10)], { slots: [{ id: "qb", label: "QB", eligiblePositions: ["QB"] }, rb] });
    const result = planWeeklyLineup(data, options);
    expect(result.status).toBe("ready");
    expect(result.projectedPoints).toBe(30);
    expect(planWeeklyLineup({ ...data, players: [...data.players].reverse() }, options)).toEqual(result);
  });

  it("rejects oversized state spaces before solving", () => {
    expect(planWeeklyLineup(snapshot([], { slots: Array.from({ length: 13 }, (_, i) => ({ ...rb, id: `slot${i}` })) }), options).status).toBe("blocked");
    expect(planWeeklyLineup(snapshot(Array.from({ length: 33 }, (_, i) => player(`p${i}`, 10))), options).status).toBe("blocked");
  });

  it("can explicitly hold unpriced K/DST and reports only a scoped total", () => {
    const data = snapshot([player("rb", 10), player("k", null, { positions: ["K"], currentSlotId: "k" }), player("other-k", null, { positions: ["K"] })], { slots: [rb, { id: "k", label: "K", eligiblePositions: ["K"] }] });
    expect(planWeeklyLineup(data, options).status).toBe("blocked");
    const result = planWeeklyLineup(data, { ...options, holdUnpricedPositions: ["K", "DST"] });
    expect(result.status).toBe("conditional");
    expect(result.excludedSlotIds).toEqual(["k"]);
    expect(result.assignments[1]).toEqual({ slotId: "k", playerId: "k", points: null, fixed: true });
    expect(result.projectedPoints).toBe(10);
  });

  it("requires explicit consent for incomplete model scoring and preserves model freshness provenance", () => {
    const data = snapshot([player("a", 10, { projectionOrigin: "model" }), player("b", 12)], { model: { source: "nflverse", computedAt: now, providerUpdatedAt: null, excludedRules: ["st_ff"], warnings: ["PPR calibration only"], coverage: { requested: 2, projected: 1 } } });
    expect(planWeeklyLineup(data, options).status).toBe("blocked");
    const conditional = planWeeklyLineup(data, { ...options, compareAvailableEstimates: true });
    expect(conditional.status).toBe("conditional");
    expect(conditional.warnings).toContain("PPR calibration only");
    expect(conditional.warnings.some((w) => w.includes("manual date cannot establish"))).toBe(true);
    expect(planWeeklyLineup({ ...data, model: { ...data.model!, computedAt: now - 10001 } }, { ...options, compareAvailableEstimates: true }).status).toBe("blocked");
  });

  it("explicit partial comparison freezes unpriced FLEX starters and unpriced bench players", () => {
    const data = snapshot([player("unpriced-flex", null, { currentSlotId: "flex" }), player("unpriced-bench", null), player("priced", 10)]);
    const result = planWeeklyLineup(data, { ...options, compareAvailableEstimates: true });
    expect(result.status).toBe("conditional");
    expect(result.excludedPlayerIds).toEqual(["unpriced-flex", "unpriced-bench"]);
    expect(result.assignments[1]).toEqual({ slotId: "flex", playerId: "unpriced-flex", points: null, fixed: true });
    expect(result.benchIds).toContain("unpriced-bench");
    expect(result.projectedPoints).toBe(10);
    expect(result.warnings.some((w) => w.includes("unknown values could change"))).toBe(true);
  });

  it("does not report a zero-valued comparison when everything is unknown", () => {
    const result = planWeeklyLineup(snapshot([player("a", null)]), { ...options, compareAvailableEstimates: true });
    expect(result.status).toBe("blocked");
    expect(result.projectedPoints).toBeNull();
  });

  it("roster refresh does not freshen an old manual estimate", () => {
    const result = planWeeklyLineup(snapshot([player("a", 10, { projectionOrigin: "manual", projectionEnteredAt: now - 10001 })]), options);
    expect(result.status).toBe("blocked");
    expect(result.problems.some((p) => p.includes("manual estimate"))).toBe(true);
  });

  it("blocks a failed latest refresh even when the retained snapshot is within its age limit", () => {
    const result = planWeeklyLineup(snapshot([player("a", 10), player("b", 12)], { refreshFailed: true }), options);
    expect(result.status).toBe("blocked");
    expect(result.problems.some((p) => p.includes("latest roster refresh failed"))).toBe(true);
  });

  it("refuses to hide an unpriced flexible-position tradeoff", () => {
    const result = planWeeklyLineup(snapshot([player("missing", null, { currentSlotId: "flex" })]), { ...options, holdUnpricedPositions: ["RB"] });
    expect(result.status).toBe("blocked");
  });

  it("rejects malformed current assignments, nonfinite values, and unknown kickoffs/status", () => {
    for (const patch of [{ kickoffAt: null }, { projectedPoints: NaN }, { currentSlotId: "invalid" }, { availability: "unknown" as const }]) {
      expect(planWeeklyLineup(snapshot([player("p", 10, patch)]), options).status).toBe("blocked");
    }
    expect(planWeeklyLineup(snapshot([player("a", 10, { currentSlotId: "rb" }), player("b", 10, { currentSlotId: "rb" })]), options).status).toBe("blocked");
    expect(planWeeklyLineup(snapshot([player("out", 0, { availability: "out", currentSlotId: "rb", kickoffAt: null })]), options).status).toBe("blocked");
    expect(planWeeklyLineup(snapshot([player("conflict", 10, { gameContextConflict: true })]), { ...options, compareAvailableEstimates: true }).status).toBe("blocked");
  });

  it("distinguishes retrieval from source freshness and invalidates at the configured boundaries", () => {
    const data = snapshot([player("a", 10), player("b", 11)]);
    expect(planWeeklyLineup({ ...data, projectionUpdatedAt: null }, options).status).toBe("conditional");
    for (const patch of [{ projectionUpdatedAt: now - 10001 }, { rosterRetrievedAt: now - 10001 }, { retrievedAt: now + 1 }]) {
      expect(planWeeklyLineup({ ...data, ...patch }, options).status).toBe("blocked");
    }
  });

  it("retains signed scoring, supports multiple eligible positions, and measures against real starters", () => {
    const data = snapshot([player("bad", -2, { currentSlotId: "rb" }), player("te-rb", 14, { positions: ["TE", "RB"], currentSlotId: "flex" }), player("better", 10)]);
    const result = planWeeklyLineup(data, options);
    expect(result.projectedPoints).toBe(24);
    expect(result.currentProjectedPoints).toBe(12);
    expect(result.gain).toBe(12);
  });
});

it("matches an independent brute-force assignment oracle across small custom rosters", () => {
  const slots = [rb, flex, { id: "wr", label: "WR", eligiblePositions: ["WR"] }];
  const oracle = (players: WeeklyPlayer[], index = 0, used = new Set<string>()): number => {
    if (index === slots.length) return 0;
    let best = oracle(players, index + 1, used);
    for (const p of players) {
      if (used.has(p.id) || !p.positions.some((pos) => slots[index].eligiblePositions.includes(pos))) continue;
      best = Math.max(best, Math.round(p.projectedPoints! * 100) + oracle(players, index + 1, new Set([...used, p.id])));
    }
    return best;
  };
  for (let seed = 0; seed < 160; seed += 1) {
    const players = Array.from({ length: 5 }, (_, i) => player(`p${i}`, ((seed * 17 + i * 29) % 170 - 30) / 10, { positions: [(seed + i) % 3 === 0 ? "WR" : "RB"], kickoffAt: now + (i + 1) * 1000 }));
    expect(planWeeklyLineup(snapshot(players, { slots }), options).projectedPoints).toBe(oracle(players) / 100);
  }
});
