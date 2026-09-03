/**
 * What the board grid draws, and what the status line says.
 *
 * Separated from the components for the reason `panel-order.ts` was: this is where the
 * mistakes are. Every one of these functions answers a question about *whose pick is
 * where*, and getting one wrong is invisible — the grid still fills, every cell still
 * holds a number, and the only symptom is a pick drawn under the wrong manager or a
 * countdown to a turn that is not yours.
 *
 * The snake arithmetic itself is not here. It lives in `lib/core/draft.ts` and is proven
 * against `snakePicks` there, so the grid cannot invent a second version of it.
 */

import { pickCoordinates, seatForTeamIndex, teamIndexForSeat } from "@/lib/core/draft";

/** One cell of the grid. */
export interface BoardCell {
  /** Overall pick number. */
  pick: number;
  round: number;
  /** 1-based column, left to right. */
  seat: number;
  /** Index into the roster array; 0 is always the manager being advised. */
  teamIndex: number;
}

/** One column heading. */
export interface BoardColumn {
  seat: number;
  teamIndex: number;
  /** "You" or the seat number, which is how every other surface names a manager. */
  label: string;
}

/**
 * The columns of the board, left to right.
 *
 * Seats rather than team indices, so the grid reads the way the room is sat: your column
 * is wherever your slot is, not pinned to the left. Pinning it to the left was tried and
 * is wrong — the whole value of watching the board is knowing how many picks separate you
 * from the turn, and that is a distance along the row.
 */
export function boardColumns(teams: number, slot: number): BoardColumn[] {
  return Array.from({ length: teams }, (_, index) => {
    const seat = index + 1;
    const teamIndex = teamIndexForSeat(seat, slot);
    return { seat, teamIndex, label: teamIndex === 0 ? "You" : `Seat ${seat}` };
  });
}

/**
 * The grid, one array per round, each in column order.
 *
 * Column order rather than pick order, so that a row can be rendered straight into a CSS
 * grid without the caller re-deriving where an even round's picks go. An even round runs
 * right to left; the cells still come back left to right, carrying the pick numbers that
 * belong there.
 */
export function boardGrid(teams: number, slot: number, rounds: number): BoardCell[][] {
  const columns = boardColumns(teams, slot);
  return Array.from({ length: rounds }, (_, roundIndex) => {
    const round = roundIndex + 1;
    return columns.map(({ seat, teamIndex }) => ({
      // The inverse of `pickCoordinates`, and asserted against it: the pick whose
      // coordinates are (round, seat).
      pick: (round - 1) * teams + (round % 2 === 1 ? seat : teams - seat + 1),
      round,
      seat,
      teamIndex,
    }));
  });
}

/** "3.07" — the way every draft room in the world refers to a pick. */
export function pickLabel(pick: number, teams: number): string {
  const { round } = pickCoordinates(pick, teams);
  const positionInRound = pick - (round - 1) * teams;
  return `${round}.${String(positionInRound).padStart(2, "0")}`;
}

/**
 * A provider-verified owner for one board square, or `null` while ownership is unknown.
 *
 * The cell's physical snake column is not a fallback owner: a traded pick stays in its
 * original column, so substituting that column while a provider poll is unavailable makes
 * an unverified claim look exact.
 */
export function boardPickOwner(
  owners: ReadonlyMap<number, number>,
  pick: number,
  userSlot: number,
): { teamIndex: number; seat: number } | null {
  const teamIndex = owners.get(pick);
  return teamIndex === undefined
    ? null
    : { teamIndex, seat: seatForTeamIndex(teamIndex, userSlot) };
}

/**
 * The next pick a team owns at or after the pick on the clock, or `null` when they are
 * done.
 *
 * Takes the ownership map rather than a slot so that it cannot disagree with the map the
 * board is drawn from — the two were derived separately once, and a countdown that
 * disagrees with the grid is worse than no countdown.
 */
export function nextPickFor(
  owners: ReadonlyMap<number, number>,
  teamIndex: number,
  fromPick: number,
): number | null {
  let best: number | null = null;
  for (const [pick, owner] of owners) {
    if (owner !== teamIndex || pick < fromPick) continue;
    if (best === null || pick < best) best = pick;
  }
  return best;
}

/**
 * How many picks will be made before a team's next turn, counting from the clock.
 *
 * Zero means they are on the clock now. `null` means they have no picks left. This is the
 * number that decides whether to take a player now or wait, and it is the one thing the
 * old board could not tell you at all.
 */
export function picksUntilTurn(
  owners: ReadonlyMap<number, number>,
  teamIndex: number,
  fromPick: number,
): number | null {
  const next = nextPickFor(owners, teamIndex, fromPick);
  if (next === null) return null;
  // `owners` may omit locked keeper squares. Count the picks that are actually still open
  // rather than subtracting overall numbers, which would call an already-filled keeper a
  // pick the room still has to make and overstate both the wait and the simulation horizon.
  let count = 0;
  for (const pick of owners.keys()) {
    if (pick >= fromPick && pick < next) count += 1;
  }
  return count;
}

export interface TurnState {
  /** The pick on the clock. One past the last pick when the draft is over. */
  readonly currentPick: number;
  readonly totalPicks: number;
  readonly teams: number;
  readonly slot: number;
  /** Team index that owns the pick on the clock, or `undefined` past the end. */
  readonly owner: number | undefined;
}

export interface TurnDescription {
  /** "You", or "Seat 7", or "Nobody". */
  readonly who: string;
  /** True when the pick on the clock is the user's. */
  readonly mine: boolean;
  readonly complete: boolean;
  /** One sentence, used for both the visible status and the live region. */
  readonly summary: string;
  /** The action this screen is asking for, as a button would phrase it. */
  readonly action: string;
}

/**
 * What the screen says about whose turn it is.
 *
 * One function for the heading, the live region and the primary button, because those
 * three drifted apart: the heading named a seat, the button said "Draft", and a manager
 * recording an opponent's pick pressed a button that read as though it were taking the
 * player for themselves. Eleven picks in twelve belong to somebody else, so the wording
 * for that case is the wording that matters most.
 */
export function describeTurn(state: TurnState): TurnDescription {
  if (state.currentPick > state.totalPicks || state.owner === undefined) {
    return {
      who: "Nobody",
      mine: false,
      complete: true,
      summary: "Draft complete — every pick is recorded.",
      action: "Draft complete",
    };
  }
  const mine = state.owner === 0;
  const who = mine ? "You" : `Seat ${seatForTeamIndex(state.owner, state.slot)}`;
  const label = pickLabel(state.currentPick, state.teams);
  return {
    who,
    mine,
    complete: false,
    summary: mine
      ? `Pick ${label} — you are on the clock.`
      : // Not "Pick 2.03 — Seat 3.", which states a fact and asks for nothing. During
        // somebody else's turn the only thing this screen can do is be told what they
        // took, and the sentence should say so.
        `Pick ${label} — ${who} on the clock. Record their pick.`,
    action: mine ? "Take" : `Record for ${who}`,
  };
}
