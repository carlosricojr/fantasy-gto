/**
 * How wide the signed-in app is allowed to be, in one place.
 *
 * The header, the footer and every `PageShell size="wide"` read this, because the header
 * inset and the content inset have to be the same number at every breakpoint — a header
 * capped at one width above a page capped at another is visible immediately, and it is the
 * kind of thing that drifts the moment the two are written separately.
 *
 * It steps rather than growing without limit. A draft board is scanned, not read, so it
 * genuinely wants width — a fourteen-team board needs 14 × 5.5rem plus the round gutter,
 * which does not fit in 72rem and used to scroll sideways on a desktop with half its width
 * empty. But an unbounded column is not better: past roughly 104rem the eye travel between
 * the recommendation on the left and the roster on the right costs more than the extra
 * columns are worth, and the draft page reflows to three columns at that point instead of
 * stretching two.
 *
 * The marketing pages deliberately do not use this. They are prose, they are capped far
 * narrower than the app, and a header spanning 104rem above a 48rem article reads as a
 * mistake rather than as an app shell.
 */
export const APP_CONTAINER = "mx-auto w-full max-w-6xl 2xl:max-w-[88rem] 3xl:max-w-[104rem]";
