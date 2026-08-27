import { OUTCOME_QUANTILES, PLACEHOLDER_QUANTILES } from "../model/config";
import { MODELED_POSITIONS } from "./config";
import type { MarketValueBasis } from "./value";

/**
 * Where a board row's number came from, at the point somebody reads it.
 *
 * The draft board carries kickers and defenses on the market's price alone: the weekly model
 * has no view of either and will not pretend to. That is true, it is documented, and none of
 * it was visible on the row.
 *
 * A general caveat elsewhere on the page is not the same thing. A user comparing a kicker's
 * championship probability with a running back's is comparing a number the model had no
 * hand in against one it helped produce, and the page said so in a paragraph they had
 * already scrolled past. The limitation has to be attached to the number it limits.
 *
 * Note what "no hand in" does and does not mean. The market half of a row is our own
 * per-position fit of historical points on log(ADP) (`lib/nfl/draft/value.ts`), so it is
 * not somebody else's number handed through untouched — `marketEstimateExplanation` says
 * as much on the same panel. What the model contributes nothing to is the *projection*,
 * and that is the claim these labels make.
 *
 * One clause this module used to carry is gone, because it stopped being true: the weekly
 * spread behind a kicker or a defense is now measured, against the entity's own
 * prior-season points per game (`lib/nfl/model/outcome-band.ts`). Note what that denominator
 * is *not* — the market's price plays no part in the measurement, which is worth keeping
 * straight because the market's price is exactly what the band is later applied to. What
 * was measured and what it multiplies are two different quantities. Measuring a spread is
 * also not projecting a player, so the labels below still fire — what they say is that the
 * value is the market's, not that the range around it was invented.
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
  /** A blend whose market half is a flat position curve and therefore only a mean. */
  | "blend-position-mean"
  /** A blend whose market half is a flat pooled fallback and therefore only a mean. */
  | "blend-pooled-mean"
  /** No model history, and the market contributes a position mean without ADP ordering. */
  | "market-only-history-position-mean"
  /** No model history, and the market contributes a pooled mean without ADP ordering. */
  | "market-only-history-pooled-mean"
  /** An unmodeled position priced by a flat position curve. */
  | "market-only-position-position-mean"
  /** An unmodeled position priced by a flat pooled fallback. */
  | "market-only-position-pooled-mean"
  /** Neither side priced him. `convex/ingest.ts` keeps these off the board. */
  | "unpriced";

type PricedValueBasis = "blend" | "market-only-history" | "market-only-position";

function withMarketBasis(
  basis: PricedValueBasis,
  marketBasis: MarketValueBasis | null | undefined,
): ValueBasis {
  if (marketBasis === "position-mean") return `${basis}-position-mean`;
  if (marketBasis === "pooled-mean") return `${basis}-pooled-mean`;
  return basis;
}

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
  marketValueBasis?: MarketValueBasis | null;
}): ValueBasis {
  if (!isModeledPosition(row.position)) {
    return row.marketPoints === null
      ? "unpriced"
      : withMarketBasis("market-only-position", row.marketValueBasis);
  }
  if (row.modelPoints === null) {
    return row.marketPoints === null
      ? "unpriced"
      : withMarketBasis("market-only-history", row.marketValueBasis);
  }
  return row.marketPoints === null
    ? "model-only"
    : withMarketBasis("blend", row.marketValueBasis);
}

/** True when the row's number rests on the market alone. */
export function isMarketOnly(basis: ValueBasis): boolean {
  return basis.startsWith("market-only-");
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
    case "blend-position-mean":
    case "market-only-history-position-mean":
    case "market-only-position-position-mean":
      return "position mean";
    case "blend-pooled-mean":
    case "market-only-history-pooled-mean":
    case "market-only-position-pooled-mean":
      return "pooled mean";
  }
}

/**
 * The disclosure attached directly to the market estimate.
 *
 * Written as an exhaustive match on the three states the board actually records, with
 * everything else falling to *unknown* rather than to the ADP-ordered sentence. That last
 * clause is the whole point of the shape. `marketValueBasis` is optional on the schema
 * precisely so a row written before the disclosure existed can say nothing, and the schema
 * says in as many words that readers treat an absent value as unknown rather than guessing
 * — but this function used to end at the ADP-ordered sentence, so an absent basis was
 * described to the reader as a per-position fit that nothing had checked. That is the
 * failure the schema comment and the README ledger row both exist to prevent, arriving
 * through the one path neither was looking at.
 */
export function marketEstimateExplanation(
  marketPoints: number | null,
  basis: MarketValueBasis | null | undefined,
): string {
  if (marketPoints === null) {
    return "No published draft position, so no market estimate is available.";
  }
  if (basis === "position-mean") {
    return (
      "The fitted market curve is flat, so this is the position’s historical " +
      "mean and carries no within-position ADP ordering."
    );
  }
  if (basis === "pooled-mean") {
    return (
      "The fitted fallback curve is flat, so this is the pooled historical " +
      "mean and carries no within-position ADP ordering."
    );
  }
  if (basis === "adp-ordered") {
    return "What this player’s average draft position has historically been worth, fitted per position.";
  }
  return (
    "What this player’s average draft position has historically been worth. This row " +
    "predates the record of which curve produced it, so whether it carries the market’s " +
    "ordering or only a position mean is unknown."
  );
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
        "Market price only. The projection model does not cover this position, so there " +
        "is no model estimate here — the number is what this player's draft position has " +
        "historically been worth. The weekly spread applied to it is measured, from years " +
        "of actual scoring at the position rather than from any projection of this player."
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
    case "blend-position-mean":
      return (
        "The model's projection blended with the market's position mean. The market half " +
        "carries no within-position ADP ordering."
      );
    case "blend-pooled-mean":
      return (
        "The model's projection blended with the market's pooled mean. The market half " +
        "carries no within-position ADP ordering."
      );
    case "market-only-history-position-mean":
      return (
        "No prior games, so the projection model has no opinion. The market contributes " +
        "only the position mean, with no within-position ADP ordering."
      );
    case "market-only-history-pooled-mean":
      return (
        "No prior games, so the projection model has no opinion. The market contributes " +
        "only the pooled mean, with no within-position ADP ordering."
      );
    case "market-only-position-position-mean":
      return (
        "The projection model does not cover this position. The market contributes only " +
        "the position mean, with no within-position ADP ordering."
      );
    case "market-only-position-pooled-mean":
      return (
        "The projection model does not cover this position. The market contributes only " +
        "the pooled mean, with no within-position ADP ordering."
      );
  }
}

/**
 * Whether the weekly spread behind a row was measured or assumed.
 *
 * `quantileProvenance` on the board row is the authority; this exists so a caller that only
 * has a position — a recommendation carries a `PlayerRisk`, which has the quantiles but not
 * where they came from — reaches the same answer. It reads the same table `convex/ingest.ts`
 * writes from, and falls back the same way, so the two agree by derivation rather than by a
 * coincidence somebody has to maintain.
 *
 * It used to answer `isModeledPosition`, which was right only while the two sets happened to
 * coincide. They no longer do: a kicker and a defense carry measured bands and are still not
 * projected, so keying on projection would have made this function contradict the row it
 * describes.
 */
export function hasMeasuredSpread(position: string): boolean {
  // `??` here reads in a mutation report as a survivor against `||`, and the two genuinely
  // cannot disagree: the lookup is either a band object, which is always truthy, or
  // `undefined`. Kept as `??` because the question being asked is "was there an entry",
  // not "was the entry usable".
  const band =
    OUTCOME_QUANTILES[position as keyof typeof OUTCOME_QUANTILES] ?? PLACEHOLDER_QUANTILES;
  return band.provenance === "measured";
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
