import { type RosterSlot, solveLineup } from "./optimizer";

/**
 * What "replacement level" means in a draft that is already partly played.
 *
 * A pick is worth what it adds over the player you could have had anyway. Measuring what a
 * player adds to the lineup *as it stands* prices him against an empty slot instead, and
 * while a slot is open that is simply his whole projection — so with quarterbacks
 * outscoring every other position in raw points, every open-QB-slot state ranked eight of
 * them in a ten-candidate shortlist. Drafting a back did not change it, because the
 * quarterback slot was still open.
 *
 * Two things have to be right for the correction to be worth anything, and the first
 * attempt got both wrong.
 *
 * **Demand is what the league still needs, not what it needed at pick one.** A twelve-team
 * league does not demand twelve quarterbacks once eleven teams have one. Pricing the next
 * quarterback against the original demand keeps quoting a scarcity that has already been
 * spent. Demand here is recomputed from the rosters actually on the board: for each team,
 * the starting slots its current roster cannot fill.
 *
 * **A FLEX is an eligibility constraint, not a promise of equal shares.** Dividing a FLEX
 * evenly among RB, WR and TE assumes the three positions absorb it in equal thirds, which
 * is false whenever their value curves differ — and they always differ. A twelve-team
 * standard league whose tight ends fall away below the twelfth does not send a third of its
 * flex demand to tight end; it sends nearly all of it to backs and receivers. Equal
 * splitting assumed RB 28 / WR 28 / TE 16 where solving the assignment gives RB 30 / WR 30 /
 * TE 12.
 *
 * So the flex share is *solved* rather than assumed: which positions actually fill the
 * league's remaining flexible slots is a maximum-weight assignment against the value curves
 * of the players still on the board, and that is what `solveDemand` computes.
 */

/** A player as this module needs to see him: a position and a number. */
export interface ReplacementCandidate {
  readonly position: string;
  /** The same quantity the lineup solver ranks by — points times availability. */
  readonly value: number;
}

/** What the league still demands at one position, and what is left after it is met. */
export interface ReplacementLevel {
  /**
   * How many players at this position the league's remaining starting slots will consume.
   *
   * Zero means no starting slot anywhere in the league can still take one. That is a real
   * state — every team's kicker slot is filled, or the template has no slot for the
   * position at all — and it is the state in which a player at this position is pure
   * bench.
   */
  readonly demand: number;
  /**
   * The value of the best player at this position who is still there once that demand is
   * met, which is what a pick at this position is worth *over*.
   */
  readonly value: number;
  /**
   * True when the board runs out before the demand does.
   *
   * There is no replacement in that case, and the honest value of the last player
   * available is his whole contribution — so `value` is 0 and this says why, rather than
   * leaving a zero that reads the same as a worthless replacement.
   */
  readonly exhausted: boolean;
}

/**
 * The starting slots a roster cannot fill.
 *
 * Solved rather than counted, because which slot a player occupies is itself an assignment
 * problem: three backs and no receivers leaves the FLEX filled and both receiver slots
 * open, and counting positions against slot kinds would report the opposite.
 *
 * Every competitor is passed as `active`; this asks what the roster *can* start, not who is
 * hurt this week.
 */
export function unfilledSlots(
  roster: readonly ReplacementCandidate[],
  slots: readonly RosterSlot[],
): RosterSlot[] {
  if (roster.length === 0) return [...slots];
  const solution = solveLineup(
    slots,
    roster.map((player, index) => ({
      id: `r${index}`,
      name: `r${index}`,
      position: player.position,
      projectedPoints: player.value,
      availability: "active" as const,
    })),
  );
  const filled = new Set(
    solution.assignments
      .filter((assignment) => assignment.competitorId !== null)
      .map((assignment) => assignment.slotId),
  );
  return slots.filter((slot) => !filled.has(slot.id));
}

/**
 * Every starting slot still unfilled anywhere in the league.
 *
 * Aggregated rather than summarized: two leagues can demand the same *count* of flexible
 * slots and resolve them differently, so the slots themselves are what `solveDemand` needs.
 */
export function leagueUnfilledSlots(
  rosters: ReadonlyArray<readonly ReplacementCandidate[]>,
  slots: readonly RosterSlot[],
): RosterSlot[] {
  const out: RosterSlot[] = [];
  for (const roster of rosters) out.push(...unfilledSlots(roster, slots));
  return out;
}

/**
 * How many players at each position the league's remaining slots will actually consume.
 *
 * The problem: assign players still on the board to slots still unfilled, respecting slot
 * eligibility, maximizing total value. The *counts* of that assignment are the demand.
 *
 * A slot's worth does not depend on which slot it is — a back is worth the same in an RB
 * slot as in a FLEX — so the reachable assignments form a transversal matroid over the
 * players, and greedy by descending value is exactly optimal. That is what this is: walk
 * the board from the top, take a player whenever the set stays assignable, and stop when
 * every slot is spoken for.
 *
 * A position that fails the assignability test once can never pass it again — independence
 * is downward closed, and every player at a position is interchangeable to the test — so a
 * failure closes the position instead of being retried. That bounds the work at one test
 * per slot filled plus one per position, rather than one per player on a board of hundreds.
 */
export function solveDemand(
  unfilled: readonly RosterSlot[],
  available: readonly ReplacementCandidate[],
): Map<string, number> {
  const demand = new Map<string, number>();
  if (unfilled.length === 0 || available.length === 0) return demand;

  // Slots collapse to kinds: distinct eligibility sets with a capacity each. A league of
  // sixteen teams has under a dozen even before deduplication, so every search below runs
  // over a graph small enough that its size is not a cost.
  const kindKeys: string[] = [];
  const kindPositions: Array<readonly string[]> = [];
  const capacity: number[] = [];
  const kindByKey = new Map<string, number>();
  for (const slot of unfilled) {
    // Sorted, so two slots accepting the same positions in a different order are one kind.
    const key = [...slot.eligiblePositions].sort().join("|");
    const existing = kindByKey.get(key);
    if (existing === undefined) {
      kindByKey.set(key, kindKeys.length);
      kindKeys.push(key);
      kindPositions.push(slot.eligiblePositions);
      capacity.push(1);
    } else {
      capacity[existing] += 1;
    }
  }

  const positions = [...new Set(available.map((player) => player.position))];
  const positionIndex = new Map(positions.map((position, index) => [position, index]));
  // `flow[p][k]` — how many players at position `p` are currently assigned to kind `k`.
  const flow = positions.map(() => new Array<number>(kindKeys.length).fill(0));
  const used = new Array<number>(kindKeys.length).fill(0);
  const eligibleKinds = positions.map((position) =>
    kindPositions
      .map((accepted, index) => (accepted.includes(position) ? index : -1))
      .filter((index) => index >= 0),
  );

  /**
   * Seats one more player at `position`, rerouting existing assignments if it takes that.
   *
   * A kind that is full is not a dead end: whoever is in it may be eligible elsewhere, and
   * moving him frees the seat. Without the reroute a superflex filled by quarterbacks
   * would refuse a back who could have taken it while a quarterback moved to the QB slot.
   */
  const seat = (position: number, visited: boolean[]): boolean => {
    for (const kind of eligibleKinds[position]) {
      if (visited[kind]) continue;
      visited[kind] = true;
      if (used[kind] < capacity[kind]) {
        flow[position][kind] += 1;
        used[kind] += 1;
        return true;
      }
      for (let other = 0; other < positions.length; other += 1) {
        if (other === position || flow[other][kind] === 0) continue;
        if (seat(other, visited)) {
          flow[other][kind] -= 1;
          flow[position][kind] += 1;
          return true;
        }
      }
    }
    return false;
  };

  const ordered = [...available].sort(
    (a, b) => b.value - a.value || (a.position < b.position ? -1 : 1),
  );
  const closed = new Set<string>();
  let seated = 0;
  for (const player of ordered) {
    if (seated === unfilled.length) break;
    if (closed.has(player.position)) continue;
    const index = positionIndex.get(player.position);
    if (index === undefined) continue;
    if (seat(index, new Array<boolean>(kindKeys.length).fill(false))) {
      demand.set(player.position, (demand.get(player.position) ?? 0) + 1);
      seated += 1;
    } else {
      closed.add(player.position);
    }
  }
  return demand;
}

/**
 * Replacement level at every position on the board.
 *
 * The index is stated rather than implied: with demand `d` at a position, the league
 * consumes the top `d` players there, so the replacement is the one at zero-based index
 * `d` — the best player still available once the demand is met. Three boundaries and what
 * each does:
 *
 *  - **Demand 0.** No starting slot in the league can take one. The replacement is the best
 *    player at the position, because that is what is freely available, and a pick there is
 *    therefore worth nothing over it as a starter. It is bench value or it is nothing.
 *  - **Demand at or past the end of the board.** There is no replacement. The value is 0
 *    and `exhausted` says so, which makes the last player at a scarce position worth his
 *    whole contribution — the honest reading, and distinguishable from a replacement who
 *    happens to be worth nothing.
 *  - **A position with no players available.** Absent from the map. Callers read a missing
 *    entry as "nothing to price".
 */
export function replacementLevels(
  unfilled: readonly RosterSlot[],
  available: readonly ReplacementCandidate[],
): Map<string, ReplacementLevel> {
  const byPosition = new Map<string, number[]>();
  for (const player of available) {
    const list = byPosition.get(player.position);
    if (list === undefined) byPosition.set(player.position, [player.value]);
    else list.push(player.value);
  }
  const demand = solveDemand(unfilled, available);

  const levels = new Map<string, ReplacementLevel>();
  for (const [position, values] of byPosition) {
    values.sort((a, b) => b - a);
    const needed = demand.get(position) ?? 0;
    const replacement = values[needed];
    levels.set(position, {
      demand: needed,
      value: replacement ?? 0,
      exhausted: replacement === undefined,
    });
  }
  return levels;
}
