/**
 * What a query surface should show while a *different* subscription loads.
 *
 * Convex keys a result by the query function and its serialized arguments, so changing an
 * argument produces a token the client has never seen and `useQuery` returns `undefined`
 * again — the same value it returns before anything has ever loaded. Those two states are
 * not the same thing, and every screen here treated them as one: changing the scoring
 * format sent the whole draft page back through its first-load branch, which unmounted the
 * board, the pool, the roster and the settings dialog the change had just been made in.
 *
 * Pure and separate from the hook so the rule can be tested, because the interesting part
 * is not the ref that holds the value — it is deciding which of four situations a caller
 * is in, and one of them is easy to get wrong: a skipped query must *drop* what it was
 * showing rather than hold it, or a board would go on being displayed for a season the
 * page has decided it no longer has.
 */

export interface StableQueryState<T> {
  /**
   * The newest value that has actually arrived, or `undefined` when none ever has.
   *
   * While `pending`, this is the *previous* subscription's value. It is deliberately not
   * presented as current — see `pending`.
   */
  data: T | undefined;
  /**
   * True when what `data` holds belongs to arguments the caller has already moved on from.
   *
   * A caller must say so. Holding the old rows on screen is what stops the page collapsing;
   * showing them *unmarked* under a heading that names the new arguments would be a set of
   * numbers this code did not produce for the state on screen, which is the one thing this
   * project refuses to render. `useRecommendations` has drawn exactly this distinction for
   * the worker since it was written; this is the same rule for the network.
   */
  pending: boolean;
}

/**
 * @param live - what `useQuery` returned this render.
 * @param previous - the last value that arrived, held across the argument change.
 * @param skipped - whether the caller passed `"skip"`, which is a decision not to ask
 *   rather than an answer that has not come back.
 */
export function stableQueryState<T>(
  live: T | undefined,
  previous: T | undefined,
  skipped: boolean,
): StableQueryState<T> {
  // A skipped query has no answer and is not waiting for one. Carrying `previous` through
  // here would keep the last league's board on screen for a page that has just decided it
  // has no season to draft for.
  if (skipped) return { data: undefined, pending: false };
  // `undefined` is the only value Convex uses for "not loaded". `null` is an ordinary
  // result — `boardFreshness` returns it for a board that has never been built — so it has
  // to settle the query rather than be mistaken for a load in progress.
  if (live !== undefined) return { data: live, pending: false };
  // Nothing has ever arrived: this is a first load, and the caller should show whatever it
  // shows before there is anything. `pending` stays false because there is nothing on
  // screen to mark as out of date.
  if (previous === undefined) return { data: undefined, pending: false };
  return { data: previous, pending: true };
}
