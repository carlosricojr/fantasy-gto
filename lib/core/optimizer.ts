/**
 * Optimal lineup assignment.
 *
 * This is the one part of the product whose value is provable rather than statistical.
 * The projection model's measured edge over a strong baseline is 2.59% (see
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
  //
  // Two guards matter here. A player locked to a slot they are not eligible for is bad
  // input, and seating them would let the optimiser return an illegal lineup — so they are
  // skipped and the slot is optimised normally. A player who is locked but cannot score
  // (ruled out after kickoff) still occupies the slot, because a started player cannot be
  // moved, but they are credited zero rather than their projection. Crediting it would
  // overstate the lineup total and, through startSitAdvice, understate the gain from a
  // change the user can still make.
  const lockedIds = new Set<string>();
  for (const player of ordered) {
    const slotId = player.lockedToSlotId;
    if (!slotId) continue;
    const slot = slotById.get(slotId);
    if (!slot || !isEligible(slot, player)) continue;
    const target = assignments.get(slotId);
    if (!target || target.competitorId !== null) continue;
    target.competitorId = player.id;
    target.projectedPoints = isStartable(player) ? player.projectedPoints : 0;
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

/**
 * A single actionable swap: start one player in place of another.
 *
 * `sitCompetitorId` is only ever a player who leaves the lineup entirely. A player who
 * merely moves between slots is not a start/sit decision, and reporting them as one would
 * tell the user to bench somebody the optimal lineup still starts.
 *
 * Gains across the returned advice sum exactly to `pointsGained`, because a player started
 * in both lineups contributes identically to each regardless of which slot they occupy.
 */
export interface StartSitAdvice {
  startCompetitorId: string;
  /** Empty when the incoming player fills a slot that was empty. */
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

  // Compare who *occupies a slot*, not who scores. Diffing slot by slot would report a
  // player who merely shifted from FLEX to RB as someone to bench; filtering the two sides
  // by different availability rules is worse still, because the sets stop being
  // comparable and the diff between them is what the advice is derived from.
  //
  // Both sets therefore use the same rule — is this player in a slot — and availability is
  // applied afterwards, where it belongs:
  //
  //  - a player who cannot score is never *recommended* to start, and
  //  - a player who cannot score but currently occupies a slot still has to come out, so
  //    they must be nameable as the player being replaced.
  const currentOccupants = new Set<string>();
  for (const competitorId of currentLineup.values()) {
    if (!competitorId) continue;
    if (byId.has(competitorId)) currentOccupants.add(competitorId);
  }

  const optimalOccupants = new Set<string>();
  const slotForCompetitor = new Map<string, SlotAssignment>();
  for (const assignment of optimal.assignments) {
    if (!assignment.competitorId) continue;
    optimalOccupants.add(assignment.competitorId);
    slotForCompetitor.set(assignment.competitorId, assignment);
  }

  // A player who cannot score contributes nothing, whatever their projection says.
  const pointsOf = (id: string) => {
    const player = byId.get(id);
    return player && isStartable(player) ? player.projectedPoints : 0;
  };
  const byPointsDescending = (a: string, b: string) =>
    pointsOf(b) - pointsOf(a) || (a < b ? -1 : 1);

  const toStart = [...optimalOccupants]
    .filter((id) => !currentOccupants.has(id))
    // Never recommend starting somebody who is out or on bye. The solver may still seat a
    // locked one — their game has begun and they cannot be moved — but that is not advice.
    .filter((id) => {
      const player = byId.get(id);
      return player !== undefined && isStartable(player);
    })
    .sort(byPointsDescending);

  const toSit = [...currentOccupants]
    .filter((id) => !optimalOccupants.has(id))
    .sort(byPointsDescending);

  // Pair each incoming player with the player they displace.
  //
  // Preference goes to whoever currently occupies the slot the incoming player will take,
  // because "start A over B at RB" is the sentence a user can act on. When that occupant
  // is not actually being dropped — they moved slots — fall back to the next unpaired
  // player who is.
  //
  // The pairing is presentational. What matters is that the summed gains reconcile with
  // the lineup total, and they do: every player common to both lineups cancels, so the
  // sum is always (points added) − (points removed).
  const unpaired = new Set(toSit);
  const advice: StartSitAdvice[] = [];

  for (const startId of toStart) {
    const assignment = slotForCompetitor.get(startId);
    if (!assignment) continue;

    const occupant = currentLineup.get(assignment.slotId) ?? null;
    let sitId: string | null =
      occupant !== null && unpaired.has(occupant) ? occupant : null;

    if (sitId === null) {
      sitId = toSit.find((id) => unpaired.has(id)) ?? null;
    }
    if (sitId !== null) unpaired.delete(sitId);

    advice.push({
      startCompetitorId: startId,
      sitCompetitorId: sitId ?? "",
      slotId: assignment.slotId,
      slotLabel: assignment.slotLabel,
      pointsGained: round2(pointsOf(startId) - (sitId ? pointsOf(sitId) : 0)),
    });
  }

  advice.sort((a, b) => b.pointsGained - a.pointsGained);

  return {
    optimal,
    advice,
    pointsGained: round2(optimal.totalPoints - round2(currentTotal)),
  };
}
