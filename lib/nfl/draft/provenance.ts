import { MODELED_POSITIONS } from "./config";

/**
 * Where a board row's number came from, at the point somebody reads it.
 *
 * The draft board carries kickers and defenses on the market's price alone: the weekly model
 * has no view of either and will not pretend to, and their weekly spread is the explicitly
 * unmeasured `PLACEHOLDER_QUANTILES` band rather than a fitted one. All of that is true, all
 * of it is documented, and none of it was visible on the row.
 *
 * A general caveat elsewhere on the page is not the same thing. A user comparing a kicker's
 * championship probability with a running back's is comparing a number built on a fitted
 * outcome distribution against one built on an assumed one, and the page said so in a
 * paragraph they had already scrolled past. The limitation has to be attached to the number
 * it limits.
 *
 * **This module labels. It does not estimate.** Nothing here invents a projection, a spread,
 * or a confidence for a position the model does not cover; a future kicker model is a
 * separate project and has to satisfy `CLAUDE.md`'s backtest rules before it replaces any of
 * these labels.
 */

/** What produced the value on a board row. */
export type ValueBasis =
  /** Both halves: the model's projection blended with the market's price. */
  | "blend"
  /** The market has no price for him — an undrafted player the model can still see. */
  | "model-only"
  /**
   * The model does not project this position at all. Kickers and defenses, permanently.
   * This is the case a reader most needs told, because it does not go away with more data.
   */
  | "market-only-position"
  /**
   * A modeled position with no prior games — a rookie. The market's price stands alone for
   * now, and will not next season. Distinct from the case above for exactly that reason.
   */
  | "market-only-history"
  /** Neither side priced him. `convex/ingest.ts` keeps these off the board. */
  | "unpriced";

/** Whether the weekly model projects this position at all. */
export function isModeledPosition(position: string): boolean {
  return MODELED_POSITIONS.includes(position as (typeof MODELED_POSITIONS)[number]);
}

/**
 * What produced this row's value.
 *
 * The position is checked before the row counts, which is the same order `convex/ingest.ts`
 * decides it in and for the same reason: a veteran kicker has a history row for every game
 * he has played and every one of them scores zero, so "has history" said the model had an
 * opinion when the position was about to overrule it. That mistake cost every veteran kicker
 * twenty percent of his market price once.
 */
export function valueBasis(row: {
  position: string;
  modelPoints: number | null;
  marketPoints: number | null;
}): ValueBasis {
  if (!isModeledPosition(row.position)) {
    return row.marketPoints === null ? "unpriced" : "market-only-position";
  }
  if (row.modelPoints === null) {
    return row.marketPoints === null ? "unpriced" : "market-only-history";
  }
  return row.marketPoints === null ? "model-only" : "blend";
}

/** True when the row's number rests on the market alone. */
export function isMarketOnly(basis: ValueBasis): boolean {
  return basis === "market-only-position" || basis === "market-only-history";
}

/**
 * The short badge shown beside the player, or `null` where there is nothing to warn about.
 *
 * `null` rather than an empty string, so a caller that renders it unconditionally produces
 * no element rather than an empty one — a badge with no text is a rendering artifact that
 * reads as a missing label.
 */
export function basisBadge(basis: ValueBasis): string | null {
  switch (basis) {
    case "market-only-position":
      return "market only";
    case "market-only-history":
      return "no history";
    case "model-only":
      return "no market price";
    case "unpriced":
      return "unpriced";
    case "blend":
      return null;
  }
}

/**
 * The sentence behind the badge.
 *
 * Written for somebody deciding whether to trust the number next to it, so each says what is
 * missing rather than what is present. None of them claims a level of accuracy for the part
 * that *is* there — the market's ranking is not measured to be good, only to be better than
 * this project's own model, which `docs/draft-validation.md` records.
 */
export function basisExplanation(basis: ValueBasis): string {
  switch (basis) {
    case "market-only-position":
      return (
        "Market price only. The projection model does not cover this position, so there is " +
        "no model estimate and no measured weekly spread behind this row — the spread used " +
        "is an assumed placeholder."
      );
    case "market-only-history":
      return (
        "Market price only. No prior games, so the projection model has no opinion yet and " +
        "the market's price stands alone."
      );
    case "model-only":
      return "No published draft position, so the model's projection stands alone.";
    case "unpriced":
      return "Neither the model nor the market has priced this player.";
    case "blend":
      return "The model's projection blended with the market's price.";
  }
}

/**
 * Whether the weekly spread behind a row was measured or assumed.
 *
 * `quantileProvenance` on the board row is the authority; this exists so a caller that only
 * has a position — a recommendation carries a `PlayerRisk`, which has the quantiles but not
 * where they came from — reaches the same answer. The two agree because `convex/ingest.ts`
 * assigns the placeholder band by position.
 */
export function hasMeasuredSpread(position: string): boolean {
  return isModeledPosition(position);
}

/**
 * The basis a caller can establish from a position alone.
 *
 * For rows that outlived the board they came from — a restored draft names a player the
 * current board may no longer carry — and for the recommendation list, which carries a
 * `PlayerRisk` rather than a board row. It reports the limitation that is a property of the
 * position and stays silent about the one that is a property of the player: a rookie is
 * indistinguishable from a veteran here, and saying "no history" without knowing would be
 * inventing the label rather than reading it.
 */
export function basisForPosition(position: string): ValueBasis {
  return isModeledPosition(position) ? "blend" : "market-only-position";
}

/**
 * The line a recommendation row shows under a player whose value the model did not produce.
 *
 * `null` for everybody else, so the common case renders nothing rather than a reassurance.
 * A row that said "model projection: measured" beside every back would train a reader to
 * stop looking, which is the failure this whole module is written against.
 */
export function recommendationCaveat(position: string): string | null {
  if (isModeledPosition(position)) return null;
  return basisExplanation("market-only-position");
}
