import { describe, expect, it } from "vitest";

import {
  type OptimizableCompetitor,
  type RosterSlot,
  solveLineup,
  startSitAdvice,
} from "./optimizer";

const QB: RosterSlot = { id: "qb", label: "QB", eligiblePositions: ["QB"] };
const RB1: RosterSlot = { id: "rb1", label: "RB", eligiblePositions: ["RB"] };
const RB2: RosterSlot = { id: "rb2", label: "RB", eligiblePositions: ["RB"] };
const WR1: RosterSlot = { id: "wr1", label: "WR", eligiblePositions: ["WR"] };
const TE: RosterSlot = { id: "te", label: "TE", eligiblePositions: ["TE"] };
const FLEX: RosterSlot = {
  id: "flex",
  label: "FLEX",
  eligiblePositions: ["RB", "WR", "TE"],
};
const SUPERFLEX: RosterSlot = {
  id: "sflex",
  label: "SUPERFLEX",
  eligiblePositions: ["QB", "RB", "WR", "TE"],
};

function player(
  id: string,
  position: string,
  projectedPoints: number,
  overrides: Partial<OptimizableCompetitor> = {},
): OptimizableCompetitor {
  return {
    id,
    name: id,
    position,
    projectedPoints,
    availability: "active",
    ...overrides,
  };
}

/**
 * A naive greedy assigner: walk players from highest projection down, dropping each into
 * the first open slot it is eligible for. This is what simple tools do, and it is the
 * behaviour the optimizer exists to beat.
 */
function greedyAssign(
  slots: readonly RosterSlot[],
  roster: readonly OptimizableCompetitor[],
): number {
  const taken = new Set<string>();
  let total = 0;
  const ordered = [...roster].sort((a, b) => b.projectedPoints - a.projectedPoints);
  for (const p of ordered) {
    if (p.availability !== "active") continue;
    const slot = slots.find((s) => !taken.has(s.id) && s.eligiblePositions.includes(p.position));
    if (!slot) continue;
    taken.add(slot.id);
    total += p.projectedPoints;
  }
  return Math.round(total * 100) / 100;
}

describe("solveLineup — the greedy counterexample", () => {
  // FLEX is declared before WR, so greedy seats the best WR in FLEX and then has
  // nowhere to put the RB. The optimizer sees that WR belongs in WR and RB in FLEX.
  const slots = [FLEX, WR1];
  const roster = [player("wr-star", "WR", 20), player("rb-good", "RB", 19), player("wr-scrub", "WR", 5)];

  it("greedy leaves points on the bench", () => {
    expect(greedyAssign(slots, roster)).toBe(25);
  });

  it("the optimizer finds the true maximum", () => {
    const solution = solveLineup(slots, roster);
    expect(solution.totalPoints).toBe(39);
  });

  it("beats greedy by a concrete margin", () => {
    expect(solveLineup(slots, roster).totalPoints - greedyAssign(slots, roster)).toBe(14);
  });

  it("seats each player in the slot that maximises the whole lineup", () => {
    const byId = new Map(
      solveLineup(slots, roster).assignments.map((a) => [a.competitorId, a.slotId]),
    );
    expect(byId.get("wr-star")).toBe("wr1");
    expect(byId.get("rb-good")).toBe("flex");
  });
});

describe("solveLineup — correctness", () => {
  it("fills a standard lineup with the best eligible players", () => {
    const slots = [QB, RB1, RB2, WR1, TE, FLEX];
    const roster = [
      player("qb1", "QB", 22),
      player("qb2", "QB", 18),
      player("rb1", "RB", 17),
      player("rb2", "RB", 14),
      player("rb3", "RB", 12),
      player("wr1", "WR", 16),
      player("wr2", "WR", 15),
      player("te1", "TE", 11),
    ];
    const solution = solveLineup(slots, roster);
    // 22 + 17 + 14 + 16 + 11 + 15 (wr2 into flex, the best remaining flex-eligible)
    expect(solution.totalPoints).toBe(95);
    expect(solution.benchedIds).toEqual(["qb2", "rb3"]);
  });

  it("never seats a player in an ineligible slot", () => {
    const slots = [QB, RB1];
    const roster = [player("wr1", "WR", 30)];
    const solution = solveLineup(slots, roster);
    for (const a of solution.assignments) expect(a.competitorId).toBeNull();
    expect(solution.totalPoints).toBe(0);
  });

  it("prefers an empty slot to an ineligible player", () => {
    const slots = [QB, TE];
    const roster = [player("qb1", "QB", 20), player("wr1", "WR", 99)];
    const solution = solveLineup(slots, roster);
    expect(solution.assignments.find((a) => a.slotId === "qb")?.competitorId).toBe("qb1");
    expect(solution.assignments.find((a) => a.slotId === "te")?.competitorId).toBeNull();
    expect(solution.totalPoints).toBe(20);
  });

  it("uses SUPERFLEX for a second quarterback when that is optimal", () => {
    const slots = [QB, SUPERFLEX];
    const roster = [
      player("qb1", "QB", 24),
      player("qb2", "QB", 21),
      player("rb1", "RB", 15),
    ];
    const solution = solveLineup(slots, roster);
    expect(solution.totalPoints).toBe(45);
    expect(solution.benchedIds).toEqual(["rb1"]);
  });

  it("excludes players who are out or on bye", () => {
    const slots = [RB1];
    const roster = [
      player("rb-out", "RB", 25, { availability: "out" }),
      player("rb-bye", "RB", 24, { availability: "bye" }),
      player("rb-ok", "RB", 9),
    ];
    const solution = solveLineup(slots, roster);
    expect(solution.assignments[0].competitorId).toBe("rb-ok");
    expect(solution.totalPoints).toBe(9);
  });

  it("handles an empty roster and an empty slot list", () => {
    expect(solveLineup([QB], []).totalPoints).toBe(0);
    expect(solveLineup([], [player("qb1", "QB", 20)]).totalPoints).toBe(0);
    expect(solveLineup([], []).assignments).toEqual([]);
  });

  it("handles a roster where everyone is unavailable", () => {
    const solution = solveLineup(
      [QB, RB1],
      [player("a", "QB", 20, { availability: "out" }), player("b", "RB", 18, { availability: "bye" })],
    );
    expect(solution.totalPoints).toBe(0);
    expect(solution.benchedIds).toEqual(["a", "b"]);
  });

  it("keeps a locked player in place and optimises around them", () => {
    const slots = [RB1, FLEX];
    const roster = [
      player("rb-locked", "RB", 5, { lockedToSlotId: "rb1" }),
      player("rb-better", "RB", 20),
      player("wr1", "WR", 18),
    ];
    const solution = solveLineup(slots, roster);
    const rb1 = solution.assignments.find((a) => a.slotId === "rb1")!;
    expect(rb1.competitorId).toBe("rb-locked");
    expect(rb1.locked).toBe(true);
    // The better back cannot displace the locked one, so FLEX takes the highest
    // remaining eligible player.
    expect(solution.assignments.find((a) => a.slotId === "flex")?.competitorId).toBe(
      "rb-better",
    );
    expect(solution.totalPoints).toBe(25);
  });

  it("ignores a lock onto an ineligible slot rather than seating an illegal lineup", () => {
    const slots = [QB, RB1];
    const roster = [
      player("wr-locked", "WR", 30, { lockedToSlotId: "qb" }),
      player("qb1", "QB", 12),
      player("rb1", "RB", 9),
    ];
    const solution = solveLineup(slots, roster);
    const qb = solution.assignments.find((a) => a.slotId === "qb")!;
    expect(qb.competitorId).toBe("qb1");
    expect(qb.locked).toBe(false);
    expect(solution.benchedIds).toContain("wr-locked");
    expect(solution.totalPoints).toBe(21);
  });

  it("ignores a lock onto a slot that does not exist", () => {
    const roster = [player("rb1", "RB", 14, { lockedToSlotId: "nonexistent" })];
    const solution = solveLineup([RB1], roster);
    expect(solution.assignments[0].competitorId).toBe("rb1");
    expect(solution.assignments[0].locked).toBe(false);
  });

  it("keeps a locked-but-ruled-out player in their slot at zero points", () => {
    // Their game has started, so they cannot be moved — but they will not score, and
    // crediting the projection would overstate the lineup.
    const slots = [RB1, FLEX];
    const roster = [
      player("rb-out", "RB", 18, { availability: "out", lockedToSlotId: "rb1" }),
      player("wr1", "WR", 11),
    ];
    const solution = solveLineup(slots, roster);
    const rb1 = solution.assignments.find((a) => a.slotId === "rb1")!;
    expect(rb1.competitorId).toBe("rb-out");
    expect(rb1.locked).toBe(true);
    expect(rb1.projectedPoints).toBe(0);
    expect(solution.totalPoints).toBe(11);
  });

  it("assigns a locked player at most one slot", () => {
    const slots = [RB1, RB2];
    const roster = [player("rb1", "RB", 12, { lockedToSlotId: "rb1" })];
    const ids = solveLineup(slots, roster)
      .assignments.map((a) => a.competitorId)
      .filter(Boolean);
    expect(ids).toEqual(["rb1"]);
  });

  it("is deterministic across runs when projections tie", () => {
    const slots = [FLEX];
    const roster = [
      player("b-tie", "WR", 10),
      player("a-tie", "WR", 10),
      player("c-tie", "RB", 10),
    ];
    const first = solveLineup(slots, roster);
    for (let i = 0; i < 25; i += 1) {
      expect(solveLineup(slots, roster)).toEqual(first);
    }
    // Ties resolve by id ascending, so the same player wins every time.
    expect(first.assignments[0].competitorId).toBe("a-tie");
  });

  it("is invariant to the input order of the roster", () => {
    const slots = [QB, RB1, FLEX];
    const roster = [
      player("qb1", "QB", 21),
      player("rb1", "RB", 16),
      player("wr1", "WR", 14),
      player("te1", "TE", 9),
    ];
    const forward = solveLineup(slots, roster);
    const reversed = solveLineup(slots, [...roster].reverse());
    expect(reversed.totalPoints).toBe(forward.totalPoints);
    expect(reversed.assignments).toEqual(forward.assignments);
  });

  it("handles fractional projections without floating point drift", () => {
    const slots = [RB1, FLEX];
    const roster = [player("a", "RB", 10.05), player("b", "WR", 7.15)];
    expect(solveLineup(slots, roster).totalPoints).toBe(17.2);
  });

  it("never exceeds the theoretical maximum on a larger random roster", () => {
    const slots = [QB, RB1, RB2, WR1, TE, FLEX];
    const roster: OptimizableCompetitor[] = [];
    const positions = ["QB", "RB", "WR", "TE"];
    // Deterministic pseudo-random values; no reliance on Math.random.
    for (let i = 0; i < 30; i += 1) {
      const pos = positions[i % positions.length];
      roster.push(player(`p${String(i).padStart(2, "0")}`, pos, ((i * 37) % 25) + 1));
    }
    const solution = solveLineup(slots, roster);
    const upperBound = [...roster]
      .sort((a, b) => b.projectedPoints - a.projectedPoints)
      .slice(0, slots.length)
      .reduce((s, p) => s + p.projectedPoints, 0);
    expect(solution.totalPoints).toBeLessThanOrEqual(upperBound);
    expect(solution.totalPoints).toBeGreaterThanOrEqual(greedyAssign(slots, roster));
  });

  it("assigns each player at most once", () => {
    const slots = [RB1, RB2, FLEX];
    const roster = [player("rb1", "RB", 20), player("rb2", "RB", 18)];
    const ids = solveLineup(slots, roster)
      .assignments.map((a) => a.competitorId)
      .filter((id): id is string => id !== null);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Cross-checks the solver against an exhaustive search.
 *
 * The Hungarian implementation forbids ineligible pairings with a large sentinel cost and
 * relies on one dummy column per slot to keep the problem feasible. That is the part of
 * the design most worth doubting: if the sentinel were ever selected, or if it perturbed
 * the potentials, results would be silently wrong rather than obviously broken. Brute
 * force over small rosters settles it by construction.
 */
describe("optimality, verified against brute force", () => {
  /** Deterministic generator; no reliance on Math.random. */
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;
  }

  /** Exhaustive best total, allowing slots to be left empty. */
  function bruteForce(
    slots: readonly RosterSlot[],
    roster: readonly OptimizableCompetitor[],
  ): number {
    let best = 0;
    const used = new Array(roster.length).fill(false);
    const recurse = (index: number, total: number) => {
      if (index === slots.length) {
        best = Math.max(best, total);
        return;
      }
      recurse(index + 1, total); // leave this slot empty
      for (let j = 0; j < roster.length; j += 1) {
        if (used[j]) continue;
        if (roster[j].availability !== "active") continue;
        if (!slots[index].eligiblePositions.includes(roster[j].position)) continue;
        used[j] = true;
        recurse(index + 1, total + roster[j].projectedPoints);
        used[j] = false;
      }
    };
    recurse(0, 0);
    return Math.round(best * 100) / 100;
  }

  it("matches the exhaustive optimum on 300 random rosters", () => {
    const random = rng(12345);
    const positions = ["QB", "RB", "WR", "TE"];

    for (let trial = 0; trial < 300; trial += 1) {
      const slotCount = 1 + Math.floor(random() * 4);
      const slots: RosterSlot[] = Array.from({ length: slotCount }, (_, i) => {
        const kind = Math.floor(random() * 3);
        const eligible =
          kind === 0
            ? [positions[Math.floor(random() * positions.length)]]
            : kind === 1
              ? ["RB", "WR", "TE"]
              : ["QB", "RB", "WR", "TE"];
        return { id: `s${i}`, label: `S${i}`, eligiblePositions: eligible };
      });

      const roster = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) =>
        player(
          `p${i}`,
          positions[Math.floor(random() * positions.length)],
          Math.round(random() * 3000) / 100,
        ),
      );

      expect(solveLineup(slots, roster).totalPoints, `trial ${trial}`).toBeCloseTo(
        bruteForce(slots, roster),
        2,
      );
    }
  });

  it("stays finite when every player is ineligible for every slot", () => {
    const slots: RosterSlot[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      label: `S${i}`,
      eligiblePositions: [`POS${i}`],
    }));
    const roster = Array.from({ length: 30 }, (_, i) => player(`p${i}`, "NONE", 20 + i));

    const solution = solveLineup(slots, roster);
    expect(Number.isFinite(solution.totalPoints)).toBe(true);
    expect(solution.totalPoints).toBe(0);
    expect(solution.assignments.every((a) => a.competitorId === null)).toBe(true);
  });

  it("ignores high-scoring ineligible players entirely", () => {
    const slots: RosterSlot[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      label: `S${i}`,
      eligiblePositions: [`P${i}`],
    }));
    const roster = [
      ...Array.from({ length: 12 }, (_, i) => player(`fit${i}`, `P${i}`, 10 + i)),
      ...Array.from({ length: 30 }, (_, i) => player(`junk${i}`, "NONE", 99)),
    ];
    // Only the twelve eligible players may be seated: 10 + 11 + … + 21.
    expect(solveLineup(slots, roster).totalPoints).toBe(186);
  });

  it("never seats an ineligible player on a large roster", () => {
    const random = rng(999);
    const slots: RosterSlot[] = [
      QB,
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `f${i}`,
        label: "FLEX",
        eligiblePositions: ["RB", "WR", "TE"],
      })),
    ];
    const roster = Array.from({ length: 200 }, (_, i) =>
      player(
        `p${i}`,
        ["QB", "RB", "WR", "TE", "DST"][Math.floor(random() * 5)],
        Math.round(random() * 4000) / 100,
      ),
    );

    const solution = solveLineup(slots, roster);
    expect(Number.isFinite(solution.totalPoints)).toBe(true);
    for (const assignment of solution.assignments) {
      if (!assignment.competitorId) continue;
      const seated = roster.find((p) => p.id === assignment.competitorId)!;
      const slot = slots.find((s) => s.id === assignment.slotId)!;
      expect(slot.eligiblePositions).toContain(seated.position);
    }
  });
});

describe("startSitAdvice", () => {
  const slots = [RB1, FLEX];

  it("recommends the swap that gains points", () => {
    const roster = [player("rb-good", "RB", 20), player("rb-bad", "RB", 6), player("wr1", "WR", 15)];
    const current = new Map([
      ["rb1", "rb-bad"],
      ["flex", "wr1"],
    ]);
    const result = startSitAdvice(slots, roster, current);
    expect(result.pointsGained).toBe(14);
    expect(result.advice).toHaveLength(1);
    expect(result.advice[0]).toMatchObject({
      startCompetitorId: "rb-good",
      sitCompetitorId: "rb-bad",
      slotId: "rb1",
      pointsGained: 14,
    });
  });

  it("returns no advice when the lineup is already optimal", () => {
    const roster = [player("rb-good", "RB", 20), player("wr1", "WR", 15)];
    const current = new Map([
      ["rb1", "rb-good"],
      ["flex", "wr1"],
    ]);
    const result = startSitAdvice(slots, roster, current);
    expect(result.advice).toEqual([]);
    expect(result.pointsGained).toBe(0);
  });

  it("recommends filling an empty slot", () => {
    const roster = [player("rb-good", "RB", 20), player("wr1", "WR", 15)];
    const current = new Map<string, string | null>([
      ["rb1", "rb-good"],
      ["flex", null],
    ]);
    const result = startSitAdvice(slots, roster, current);
    expect(result.advice).toHaveLength(1);
    expect(result.advice[0].startCompetitorId).toBe("wr1");
    expect(result.advice[0].sitCompetitorId).toBe("");
  });

  it("orders advice by points gained, descending", () => {
    const roster = [
      player("rb-good", "RB", 22),
      player("rb-bad", "RB", 4),
      player("wr-good", "WR", 19),
      player("wr-bad", "WR", 16),
    ];
    const current = new Map([
      ["rb1", "rb-bad"],
      ["flex", "wr-bad"],
    ]);
    const result = startSitAdvice(slots, roster, current);
    expect(result.advice.map((a) => a.pointsGained)).toEqual([18, 3]);
  });

  it("never recommends starting an unavailable player", () => {
    const roster = [
      player("rb-out", "RB", 40, { availability: "out" }),
      player("rb-ok", "RB", 10),
    ];
    const current = new Map([["rb1", "rb-ok"]]);
    const result = startSitAdvice([RB1], roster, current);
    expect(result.advice).toEqual([]);
  });
});
