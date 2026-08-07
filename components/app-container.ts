/**
 * How wide the signed-in app is, in one place.
 *
 * The header, the footer and `PageShell` all carry this class, and it resolves to
 * `--app-shell-max` — a variable the *page* sets, through the rules in `app/globals.css`.
 * The chrome therefore cannot be inset differently from the content it frames: they are
 * literally the same number. A first pass gave the header its own widening steps and left
 * the three narrow app pages alone, which put the brand 448px to the left of the page it
 * sat above on a 1920px display. Two independent reviews found it immediately, which is
 * the point — a header capped at one width over a page capped at another is visible at a
 * glance. `lib/shell-width.test.ts` is what stops it coming back.
 *
 * `app/globals.css` owns the numbers and says why they step rather than growing without
 * limit.
 */
export const APP_CONTAINER = "mx-auto w-full max-w-[var(--app-shell-max,72rem)]";

/**
 * The marketing shell, which does not vary.
 *
 * A constant for the same reason the app has one: this width is written into a header and
 * a footer that have to agree, and the two were separate literals kept in step by hand.
 * Marketing is deliberately never wide — it is prose, capped far narrower than the draft
 * board, and a 104rem bar above a 48rem article reads as a mistake rather than as a frame.
 */
export const MARKETING_CONTAINER = "mx-auto w-full max-w-6xl";
