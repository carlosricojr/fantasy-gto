import {
  pickOwnership,
  snakePicks,
  teamIndexForSeat,
} from "../../core/draft";

/** The source facts needed from Sleeper; kept structural so this module performs no I/O. */
export interface SleeperOwnershipTrade {
  round: number | null;
  rosterId: number | null;
  ownerId: number | null;
}

export type SleeperOwnershipResult =
  | {
      exact: true;
      owners: ReadonlyMap<number, number>;
      /** Overall squares whose current owner differs from their original snake seat. */
      reassignedPicks: readonly number[];
      unsupported: readonly [];
    }
  | {
      exact: false;
      owners: null;
      reassignedPicks: readonly [];
      /** Source facts that prevented an exact ownership map. Never replace them with guesses. */
      unsupported: readonly string[];
    };

/**
 * Resolves the manager who actually owns every Sleeper draft square.
 *
 * A traded pick remains in the original roster's snake square. `rosterId` identifies that
 * original roster and `ownerId` identifies the roster making the pick now. Sleeper's
 * `slot_to_roster_id` map is therefore the necessary bridge in both directions. Applying a
 * trade directly to a draft slot confuses roster ids with seat numbers; they happen to be
 * the same in some mock rooms and are deliberately not the same in real leagues.
 */
export function sleeperPickOwnership(input: {
  teams: number;
  rounds: number;
  userSlot: number;
  slotToRosterId: Readonly<Record<number, number>>;
  tradedPicks: readonly SleeperOwnershipTrade[];
}): SleeperOwnershipResult {
  // The ordinary ownership builder owns the league-shape guards. Reusing it also ensures
  // the no-trade case is byte-for-byte the same map the rest of the product already trusts.
  const owners = pickOwnership(input.teams, input.userSlot, input.rounds);
  if (input.tradedPicks.length === 0) {
    return { exact: true, owners, reassignedPicks: [], unsupported: [] };
  }

  const rosterToSlot = new Map<number, number>();
  const unsupported: string[] = [];
  for (let slot = 1; slot <= input.teams; slot += 1) {
    const rosterId = input.slotToRosterId[slot];
    if (!Number.isInteger(rosterId) || rosterId < 1) {
      unsupported.push(`slot_to_roster_id.${slot}`);
      continue;
    }
    const duplicate = rosterToSlot.get(rosterId);
    if (duplicate !== undefined) {
      unsupported.push(`roster ${rosterId} assigned to slots ${duplicate} and ${slot}`);
      continue;
    }
    rosterToSlot.set(rosterId, slot);
  }

  const resolved: Array<{ pick: number; originalSlot: number; ownerSlot: number }> = [];
  const seenSquares = new Set<string>();
  for (const trade of input.tradedPicks) {
    const square = `${trade.round ?? "?"}:${trade.rosterId ?? "?"}`;
    if (
      trade.round === null ||
      trade.rosterId === null ||
      trade.ownerId === null ||
      trade.round > input.rounds
    ) {
      unsupported.push(`traded pick ${square}`);
      continue;
    }
    if (seenSquares.has(square)) {
      unsupported.push(`duplicate traded pick ${square}`);
      continue;
    }
    seenSquares.add(square);
    const originalSlot = rosterToSlot.get(trade.rosterId);
    const ownerSlot = rosterToSlot.get(trade.ownerId);
    if (originalSlot === undefined) unsupported.push(`original roster ${trade.rosterId}`);
    if (ownerSlot === undefined) unsupported.push(`owner roster ${trade.ownerId}`);
    if (originalSlot === undefined || ownerSlot === undefined) continue;
    resolved.push({
      pick: snakePicks(originalSlot, input.teams, input.rounds)[trade.round - 1],
      originalSlot,
      ownerSlot,
    });
  }

  if (unsupported.length > 0) {
    return {
      exact: false,
      owners: null,
      reassignedPicks: [],
      unsupported: [...new Set(unsupported)].sort(),
    };
  }

  for (const { pick, ownerSlot } of resolved) {
    owners.set(pick, teamIndexForSeat(ownerSlot, input.userSlot));
  }
  return {
    exact: true,
    owners,
    reassignedPicks: resolved
      .filter(({ originalSlot, ownerSlot }) => originalSlot !== ownerSlot)
      .map(({ pick }) => pick)
      .sort((a, b) => a - b),
    unsupported: [],
  };
}
