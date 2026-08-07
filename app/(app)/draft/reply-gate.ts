/**
 * Which worker replies are still worth showing.
 *
 * A draft board changes faster than a season simulation finishes. Two kinds of staleness
 * follow, and they are not the same problem.
 *
 * **A newer board.** A pick lands, then another before the first reply arrives. The old reply
 * is for a position that no longer exists, and rendering it shows advice for a board the user
 * is no longer looking at. Monotonic request ids handle this: anything older than what has
 * already been applied is dropped.
 *
 * **A different league.** The user changes the scoring format, or the roster shape, or the
 * league size. Every outstanding reply is now for a *different game* — different board,
 * different slots, different demand — and so is every reply already on screen. Request ids
 * cannot see this, because the ids keep counting up and the newest reply is still the newest.
 *
 * The second is worse than the first and was not handled. The previous league's
 * recommendations sat on screen, unmarked, until an answer for the new one arrived. They were
 * not stale in the sense the panel means by stale. They were answers to a question nobody had
 * asked.
 *
 * This used to say the window existed because changing scoring re-queried the board, which
 * was `undefined` while it loaded, so `draftState` was null and no request went out. The
 * conclusion is still true and the reason no longer is: `useStableQuery` holds the previous
 * rows, so `draftState` is not null during the reload — it describes the *old* league. What
 * withholds the request now is an explicit `if (boardPending) return` in `page.tsx`, which
 * exists precisely because this gate cannot tell a request built from a held board from a
 * current one. So the window is the same length it always was, and the guard that sets its
 * length moved from an accident to a line of code. Do not read this paragraph as a reason
 * the guard is redundant; it is the reason it is not.
 *
 * Extracted from the hook because it is a state machine over three numbers and none of it
 * needs React, and because the version that lived inside the hook could only be tested by
 * driving a component.
 */

export interface ReplyGateState {
  /** The id the next request will carry. */
  readonly nextId: number;
  /** The most recent id handed out, or -1 before the first request. */
  readonly latestSent: number;
  /** The most recent id applied to the screen, or -1. */
  readonly latestApplied: number;
  /**
   * The lowest id still allowed to be applied.
   *
   * Raised to `nextId` when the league changes, which discards every outstanding reply in
   * one step without having to know how many there are.
   */
  readonly acceptFrom: number;
  /** The league these ids are counting for. */
  readonly fingerprint: string;
}

export function initialGate(fingerprint: string): ReplyGateState {
  return { nextId: 0, latestSent: -1, latestApplied: -1, acceptFrom: 0, fingerprint };
}

/** Takes the next request id. */
export function nextRequest(gate: ReplyGateState): {
  gate: ReplyGateState;
  id: number;
} {
  const id = gate.nextId;
  return {
    id,
    gate: { ...gate, nextId: id + 1, latestSent: id },
  };
}

/**
 * Points the gate at a different league.
 *
 * Returns `changed: false` for the same fingerprint, so a caller can run this on every render
 * without clearing the screen every time. When it *is* a change, every id handed out so far
 * becomes unacceptable — including ones already applied, which is what makes the previous
 * league's answer disappear rather than linger while the new board loads.
 */
export function retarget(
  gate: ReplyGateState,
  fingerprint: string,
): { gate: ReplyGateState; changed: boolean } {
  if (gate.fingerprint === fingerprint) return { gate, changed: false };
  return {
    changed: true,
    gate: {
      ...gate,
      fingerprint,
      // `nextId`, not `latestSent + 1`: they are equal, and this is the one that stays
      // correct if a request is ever taken without being sent.
      acceptFrom: gate.nextId,
      latestApplied: gate.nextId - 1,
    },
  };
}

export type ReplyVerdict =
  /** Show it. */
  | "apply"
  /** A reply for a league that is no longer selected. */
  | "wrong-league"
  /** A reply for an older board than one already shown. */
  | "superseded";

/**
 * Whether a reply may be applied, and the reason when it may not.
 *
 * A reason rather than a boolean because the two rejections mean different things to anyone
 * reading a log: one is the ordinary churn of a fast draft and the other means a
 * configuration change raced a request.
 */
export function verdictFor(gate: ReplyGateState, replyId: number): ReplyVerdict {
  if (replyId < gate.acceptFrom) return "wrong-league";
  if (replyId < gate.latestApplied) return "superseded";
  return "apply";
}

/** Records that a reply was applied. */
export function applied(gate: ReplyGateState, replyId: number): ReplyGateState {
  return { ...gate, latestApplied: replyId };
}

/** True when what is on screen is for an older request than the newest one sent. */
export function isStale(gate: ReplyGateState, replyId: number): boolean {
  return replyId < gate.latestSent;
}

/**
 * The league a request belongs to, as one string.
 *
 * Every field that changes which board is fetched, which lineup is scored, or which season is
 * simulated. A field left out of this is a field whose change leaves the previous league's
 * answer on screen: scoring decides the board, the roster template decides the slots and
 * therefore the demand, the team count decides both, and the season decides everything.
 *
 * The playoff field and the championship week are here for the last of those reasons, and
 * they were both missing. Neither re-queries the board, so a request does go out immediately
 * and the old answer is superseded within one computation — which is why this looked like the
 * ordinary churn of a fast draft and is not. Championship probability is *the* number this
 * panel reports, and it is the probability of surviving a specific bracket over specific
 * weeks; an answer computed for a different bracket is not a stale answer to this question,
 * it is a confident answer to another one. That is the distinction this whole module exists
 * to draw, and it applies whether or not something happens to supersede it half a second
 * later.
 *
 * Serialized rather than joined on a separator. Joining is injective only while no component
 * can contain the separator, which is true of the ids this ships today and is not a property
 * of the function: `("a", "b|c")` and `("a|b", "c")` join to the same string, and two
 * different leagues sharing a fingerprint means each keeps the other's stale answers. The
 * quoting `JSON.stringify` does makes it injective for any strings at all, which is the
 * property this actually needs.
 */
export function leagueFingerprint(league: {
  season: number | null;
  scoringId: string;
  templateId: string;
  teams: number;
  rounds: number;
  playoffTeams: number;
  championshipWeek: number;
}): string {
  return JSON.stringify([
    league.season,
    league.scoringId,
    league.templateId,
    league.teams,
    league.rounds,
    league.playoffTeams,
    league.championshipWeek,
  ]);
}
