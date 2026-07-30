/**
 * Optimal lineup assignment.
 *
 * This is the one part of the product whose value is provable rather than statistical.
 * The projection model's measured edge over a strong baseline is about 1.3% (see
 * `docs/model-validation.md`), which is real but modest. Optimal slot assignment, by
 * contrast, is optimal by construction: given any set of projections, no arrangement
 * scores higher. Naive tools lose points here for free.
 *
 * The problem is maximum-weight bipartite matching between players and roster slots under
 * slot eligibility. Greedy assignment — take the highest projection, drop it in the first
 * slot it fits — is not merely suboptimal in theory; `optimizer.test.ts` contains a
 * concrete roster where it leaves 14 points on the bench.
 *
 * Nothing here mentions football. Slots carry eligible position codes as opaque strings,
 * so the same solver serves any sport with a slotted lineup.
 */

/** A lineup slot and the position codes it accepts. */
export interface RosterSlot {
  id: string;
  label: string;
  /** Position codes eligible for this slot. A FLEX lists several. */
  eligiblePositions: readonly string[];
}

/** Why a player may be unavailable to start. */
export type PlayerAvailability = "active" | "out" | "bye";

export interface OptimizableCompetitor {
  id: string;
  name: string;
  position: string;
  projectedPoints: number;
  availability: PlayerAvailability;
  /**
   * Set when the player's game has already kicked off. A locked player cannot be moved,
   * so the solver treats their slot as spoken for and optimises around it.
   */
  lockedToSlotId?: string | null;
}

export interface SlotAssignment {
  slotId: string;
  slotLabel: string;
  competitorId: string | null;
  projectedPoints: number;
  /** True when the player was immovable because their game had started. */
  locked: boolean;
}

export interface LineupSolution {
  assignments: SlotAssignment[];
  /** Sum of projections of started players, quantised to two decimals. */
  totalPoints: number;
  /** Players not assigned to a slot, ordered by projection descending. */
  benchedIds: string[];
}

/**
 * Costs are integers.
 *
 * Projections are quantised to two decimals, so scaling by 100 makes every cost exact.
 * That removes floating point from the solver entirely: no epsilon comparisons, and the
 * same roster always yields byte-identical output. Determinism matters here because a
 * lineup that reshuffles between page loads reads as a bug.
 */
const SCALE = 100;

/** Larger than any achievable real cost, used to forbid ineligible pairings. */
const FORBIDDEN = Number.MAX_SAFE_INTEGER / 4;

function isEligible(slot: RosterSlot, player: OptimizableCompetitor): boolean {
  return slot.eligiblePositions.includes(player.position);
}

/** Players who cannot score are never worth starting. */
function isStartable(player: OptimizableCompetitor): boolean {
  return player.availability === "active";
}

/**
 * Rectangular Hungarian algorithm (Jonker-Volgenant shortest augmenting path form).
 *
 * Finds a minimum-cost assignment of every row to a distinct column. Requires
 * `cols >= rows`, which the caller guarantees by padding with one dummy column per row.
 *
 * Returns `rowForColumn`, where entry `j` is the row assigned to column `j`, or `-1`.
 * O(rows^2 * cols), which for a fantasy roster is trivially small.
 */
function hungarian(cost: readonly number[][], rows: number, cols: number): number[] {
  // One-indexed internally, which is what makes the sentinel row 0 work cleanly.
  const u = new Array<number>(rows + 1).fill(0);
  const v = new Array<number>(cols + 1).fill(0);
  const rowForColumn = new Array<number>(cols + 1).fill(0);
  const path = new Array<number>(cols + 1).fill(0);

  for (let row = 1; row <= rows; row += 1) {
    rowForColumn[0] = row;
    let col = 0;
    const minCost = new Array<number>(cols + 1).fill(Infinity);
    const used = new Array<boolean>(cols + 1).fill(false);

    do {
      used[col] = true;
      const currentRow = rowForColumn[col];
      let delta = Infinity;
      let nextCol = 0;

      for (let j = 1; j <= cols; j += 1) {
        if (used[j]) continue;
        const candidate = cost[currentRow - 1][j - 1] - u[currentRow] - v[j];
        if (candidate < minCost[j]) {
          minCost[j] = candidate;
          path[j] = col;
        }
        if (minCost[j] < delta) {
          delta = minCost[j];
          nextCol = j;
        }
      }

      for (let j = 0; j <= cols; j += 1) {
        if (used[j]) {
          u[rowForColumn[j]] += delta;
          v[j] -= delta;
        } else {
          minCost[j] -= delta;
        }
      }

      col = nextCol;
    } while (rowForColumn[col] !== 0);

    // Walk the augmenting path back, flipping assignments.
    do {
      const previous = path[col];
      rowForColumn[col] = rowForColumn[previous];
      col = previous;
    } while (col !== 0);
  }

  return rowForColumn;
}

function round2(value: number): number {
  const scaled = Math.round(Math.abs(value) * 100 + Number.EPSILON) / 100;
  const signed = value < 0 ? -scaled : scaled;
  return signed === 0 ? 0 : signed;
}

/**
 * Produces the highest-scoring legal lineup.
 *
 * Players are pre-sorted by projection descending, then by id, before the matrix is
 * built. The solver is deterministic given a matrix, and this sort makes the matrix
 * itself deterministic, so genuinely tied alternatives resolve the same way every run.
 */
export function solveLineup(
  slots: readonly RosterSlot[],
  roster: readonly OptimizableCompetitor[],
): LineupSolution {
  const ordered = [...roster].sort(
    (a, b) => b.projectedPoints - a.projectedPoints || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const slotById = new Map(slots.map((slot) => [slot.id, slot]));
  const assignments = new Map<string, SlotAssignment>();
  for (const slot of slots) {
    assignments.set(slot.id, {
      slotId: slot.id,
      slotLabel: slot.label,
      competitorId: null,
      projectedPoints: 0,
      locked: false,
    });
  }

  // Locked players hold their slot; the solver optimises what remains around them.
  const lockedIds = new Set<string>();
  for (const player of ordered) {
    const slotId = player.lockedToSlotId;
    if (!slotId || !slotById.has(slotId)) continue;
    const target = assignments.get(slotId);
    if (!target || target.competitorId !== null) continue;
    target.competitorId = player.id;
    target.projectedPoints = player.projectedPoints;
    target.locked = true;
    lockedIds.add(player.id);
  }

  const openSlots = slots.filter((slot) => assignments.get(slot.id)!.competitorId === null);
  const candidates = ordered.filter((p) => !lockedIds.has(p.id) && isStartable(p));

  if (openSlots.length > 0 && candidates.length > 0) {
    const rows = openSlots.length;
    // One dummy column per row guarantees a feasible assignment, letting a slot go empty
    // rather than forcing an ineligible player into it.
    const cols = candidates.length + rows;

    const cost: number[][] = [];
    for (let r = 0; r < rows; r += 1) {
      const slot = openSlots[r];
      const row = new Array<number>(cols).fill(0);
      for (let c = 0; c < candidates.length; c += 1) {
        const player = candidates[c];
        row[c] = isEligible(slot, player)
          ? -Math.round(player.projectedPoints * SCALE)
          : FORBIDDEN;
      }
      cost.push(row);
    }

    const rowForColumn = hungarian(cost, rows, cols);
    for (let col = 1; col <= cols; col += 1) {
      const row = rowForColumn[col];
      if (row === 0 || row > rows) continue;
      const playerIndex = col - 1;
      if (playerIndex >= candidates.length) continue; // matched to a dummy: slot stays empty
      const slot = openSlots[row - 1];
      const player = candidates[playerIndex];
      if (!isEligible(slot, player)) continue; // defensive: never seat an ineligible player
      const target = assignments.get(slot.id)!;
      target.competitorId = player.id;
      target.projectedPoints = player.projectedPoints;
    }
  }

  const startedIds = new Set(
    [...assignments.values()].map((a) => a.competitorId).filter((id): id is string => id !== null),
  );

  return {
    assignments: slots.map((slot) => assignments.get(slot.id)!),
    totalPoints: round2(
      [...assignments.values()].reduce((sum, a) => sum + a.projectedPoints, 0),
    ),
    benchedIds: ordered.filter((p) => !startedIds.has(p.id)).map((p) => p.id),
  };
}

/** A single actionable swap: start one player in place of another. */
export interface StartSitAdvice {
  startCompetitorId: string;
  sitCompetitorId: string;
  slotId: string;
  slotLabel: string;
  /** Points gained by making this swap. Always positive. */
  pointsGained: number;
}

/**
 * Compares a user's current lineup to the optimum and reports what to change.
 *
 * Advice is derived by diffing the two lineups rather than by scoring swaps in isolation,
 * because slot eligibility makes swaps interdependent — moving a flex player can free a
 * slot that changes what belongs elsewhere.
 */
export function startSitAdvice(
  slots: readonly RosterSlot[],
  roster: readonly OptimizableCompetitor[],
  currentLineup: ReadonlyMap<string, string | null>,
): { optimal: LineupSolution; advice: StartSitAdvice[]; pointsGained: number } {
  const optimal = solveLineup(slots, roster);
  const byId = new Map(roster.map((p) => [p.id, p]));

  let currentTotal = 0;
  for (const competitorId of currentLineup.values()) {
    if (!competitorId) continue;
    const player = byId.get(competitorId);
    if (player && isStartable(player)) currentTotal += player.projectedPoints;
  }

  const advice: StartSitAdvice[] = [];
  for (const assignment of optimal.assignments) {
    const currentId = currentLineup.get(assignment.slotId) ?? null;
    const optimalId = assignment.competitorId;
    if (!optimalId || optimalId === currentId) continue;

    const incoming = byId.get(optimalId);
    if (!incoming) continue;
    const outgoing = currentId ? byId.get(currentId) : undefined;
    const outgoingPoints = outgoing && isStartable(outgoing) ? outgoing.projectedPoints : 0;
    const gained = round2(incoming.projectedPoints - outgoingPoints);
    if (gained <= 0) continue;

    advice.push({
      startCompetitorId: optimalId,
      sitCompetitorId: currentId ?? "",
      slotId: assignment.slotId,
      slotLabel: assignment.slotLabel,
      pointsGained: gained,
    });
  }

  advice.sort((a, b) => b.pointsGained - a.pointsGained);

  return {
    optimal,
    advice,
    pointsGained: round2(optimal.totalPoints - round2(currentTotal)),
  };
}
