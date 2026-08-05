/**
 * Which of the draft column's two panels leads, and when a change of lead should be
 * shown to the reader.
 *
 * This is separated from the component because it is where the bugs were. Three
 * successive attempts got it wrong in three different ways — scrolling the page when the
 * draft ended, scrolling it while restoring a board after a crash, and failing to scroll
 * on the one transition that most needed it — and every one of them was a mistake about
 * *this* decision, not about refs or effects.
 *
 * All four functions are total, and between them they hold the whole decision: which
 * panel leads, what order that puts the two in, whether a change should be shown, and
 * what to remember for next time. The last of those matters as much as the rest — two of
 * the three bugs above were in *when to remember*, not in what to show — so it lives here
 * rather than inline in the component, where a test could only re-implement it.
 */

export type Panel = "record" | "recommendations";

export interface TurnState {
  /** The pick on the clock belongs to the user. */
  readonly onTheClock: boolean;
  /** Every pick is in. */
  readonly draftComplete: boolean;
}

/**
 * The panel that goes first.
 *
 * On your turn the recommendations *are* the decision and each row carries its own Draft
 * button, so they lead. On anyone else's, the only thing this screen can do is be told
 * what that person took, so recording leads. Once the draft is over there is nothing left
 * to record, so the recommendations column — which by then holds the "draft is over"
 * notice — leads again.
 */
export function leadingPanel({ onTheClock, draftComplete }: TurnState): Panel {
  return onTheClock || draftComplete ? "recommendations" : "record";
}

/** Both panels, lead first. */
export function panelOrder(state: TurnState): readonly [Panel, Panel] {
  return leadingPanel(state) === "record"
    ? (["record", "recommendations"] as const)
    : (["recommendations", "record"] as const);
}

/**
 * Whether a render should bring the leading panel into view.
 *
 * Reordering the DOM moves the panel; it does not move the reader. You tap Draft partway
 * down the candidate list and the panel you now need slides to the top of a page you are
 * still scrolled into the middle of, off-screen above you, with nothing to say it moved.
 *
 * `previous === null` is the arming render, not a transition. Without that distinction,
 * restoring a stored board looked identical to a turn passing: the defaults say pick one
 * is yours, the restored board says an opponent is on the clock, and recovering from a
 * crash scrolled the page before the user had seen it.
 *
 * `settled` is false until the stored draft has been read back, so the restore commit
 * cannot arm on a lead the user was never shown.
 */
export function shouldRevealLead(input: {
  readonly settled: boolean;
  readonly previous: Panel | null;
  readonly current: Panel;
}): boolean {
  if (!input.settled) return false;
  if (input.previous === null) return false;
  return input.previous !== input.current;
}

/**
 * What to remember as the previous lead.
 *
 * Only a settled render arms it. Mounting shows the defaults — slot one, so the first
 * pick is yours — and the stored board lands a tick later, possibly with an opponent on
 * the clock. Arming on the unsettled render makes that restore indistinguishable from a
 * turn passing, and the page scroll-jumps while recovering from a crash.
 *
 * A fold rather than a line in the effect, so the tests exercise the same code the
 * component runs. When this was `if (settled) previous = current` in one place and again
 * in the test helper, dropping the guard left all the tests passing.
 */
export function nextArmed(input: {
  readonly settled: boolean;
  readonly previous: Panel | null;
  readonly current: Panel;
}): Panel | null {
  return input.settled ? input.current : input.previous;
}
