/**
 * League sizes the product offers, and where each one's market prices come from.
 *
 * Average draft position is measured in **overall picks**, so it is league-size specific by
 * construction: the same player at the same point in a draft is pick 40 in a ten-team league
 * and pick 32 in an eight-team one. `AdpProvider.forSeason` already says so and takes the
 * size as an argument. What it cannot do is invent a board the provider does not publish.
 *
 * Measured against Fantasy Football Calculator on 2026 standard, every integer size from 6 to
 * 16 (`curl .../adp/standard?teams=N&year=2026`):
 *
 *   6  HTTP 400  {"status":"Error"}        11  HTTP 400
 *   7  HTTP 400                            12  HTTP 200  201 players
 *   8  HTTP 200  201 players               13  HTTP 400
 *   9  HTTP 400                            14  HTTP 200  201 players
 *   10 HTTP 200  201 players               15  HTTP 400
 *                                          16  HTTP 400
 *
 * Four sizes, and the product offered exactly those four. That is a provider limitation
 * presented as a product one: a nine-team league is an ordinary league and there is nothing
 * about it this board cannot price.
 *
 * ## The fallback is a rescale, not a substitution
 *
 * Serving an eight-team board to a nine-team league unchanged would be the "silently
 * approximate an unsupported setting" failure this epic exists to remove. But the difference
 * between the two boards is not arbitrary — it is close to a known linear map. A player drawn
 * at overall pick `p` in a league of `s` teams went in round `p / s`; the same round in a
 * league of `t` teams is overall pick `p * t / s`. Rescaling by `t / s` preserves the round,
 * which is the thing the market actually measures, and it is exactly the quantity the
 * survival model compares against a pick number.
 *
 * So a derived board is a *transformed* board rather than another league's, the transform is
 * one number, and both the number and the size it came from are carried through to the
 * interface. It is still an approximation — real drafts are not perfectly linear in league
 * size, and no measurement here says how far off it is — and it is labelled as one
 * everywhere it is used.
 *
 * ## Which direction a tie goes, and why
 *
 * Nine teams is one away from both eight and ten. The tie goes to the **smaller** board, and
 * that is not arbitrary either. Scaling up from a smaller board multiplies by more than one
 * only after the rescale; before it, the source's raw pick numbers are compressed relative to
 * the target league — and any residual error left by the rescale therefore points toward
 * *players going earlier than they will*. Overstating scarcity costs a round; understating it
 * costs the player. For a draft tool that is not a symmetric mistake.
 *
 * Six and seven have no smaller board to fall back to, so they scale up from eight and the
 * residual error points the unsafe way. That is stated rather than hidden.
 */

/** Every league size the product offers. */
export const SUPPORTED_LEAGUE_SIZES = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

/**
 * The sizes the market publishes a board for.
 *
 * Verified by direct request rather than recalled — see the table above and
 * `docs/data-sources.md`. A size added here without a live check is a board that silently
 * fails to build for a league somebody selected.
 */
export const DIRECT_ADP_LEAGUE_SIZES = [8, 10, 12, 14] as const;

export type AdpSource =
  | {
      /** The provider publishes this size. Prices are used as measured. */
      kind: "direct";
      teams: number;
      sourceTeams: number;
      factor: 1;
    }
  | {
      /**
       * Derived from the nearest published size by rescaling every pick number.
       *
       * `factor` is `teams / sourceTeams`, and multiplying a source pick number by it gives
       * the overall pick of the same *round* in this league.
       */
      kind: "scaled";
      teams: number;
      sourceTeams: number;
      factor: number;
    };

/**
 * Where a league of this size gets its market prices.
 *
 * Throws for a size the product does not offer, rather than picking the nearest of those
 * too. A size outside 6–16 reached this from somewhere that had not been clamped, and
 * building a board for a league nobody asked for is a worse answer than failing.
 */
export function adpSourceFor(teams: number): AdpSource {
  if (
    !Number.isInteger(teams) ||
    !SUPPORTED_LEAGUE_SIZES.includes(teams as (typeof SUPPORTED_LEAGUE_SIZES)[number])
  ) {
    throw new Error(
      `No draft board is built for a ${teams}-team league. Supported sizes are ` +
        `${SUPPORTED_LEAGUE_SIZES[0]}–${SUPPORTED_LEAGUE_SIZES[SUPPORTED_LEAGUE_SIZES.length - 1]}.`,
    );
  }
  if (DIRECT_ADP_LEAGUE_SIZES.includes(teams as (typeof DIRECT_ADP_LEAGUE_SIZES)[number])) {
    return { kind: "direct", teams, sourceTeams: teams, factor: 1 };
  }
  // Nearest, and the smaller of two equals. `reduce` rather than a sort so the tie rule is
  // one visible comparison rather than a property of a comparator.
  const sourceTeams = DIRECT_ADP_LEAGUE_SIZES.reduce<number>(
    (best, candidate) => {
      const bestDistance = Math.abs(best - teams);
      const distance = Math.abs(candidate - teams);
      if (distance < bestDistance) return candidate;
      if (distance === bestDistance) return Math.min(best, candidate);
      return best;
    },
    // Seeded with the first published size rather than left to the no-seed overload, which
    // would type the accumulator as one of the literals and refuse `Math.min`'s `number`.
    DIRECT_ADP_LEAGUE_SIZES[0],
  );
  return { kind: "scaled", teams, sourceTeams, factor: teams / sourceTeams };
}

/**
 * A source pick number expressed in this league's picks.
 *
 * `null` in, `null` out: a player the market has no opinion about does not acquire one from
 * being rescaled. Rounded to one decimal, which is the precision the provider publishes at —
 * carrying more would suggest the transform is more exact than the boards it maps between.
 */
export function scalePick(value: number | null, source: AdpSource): number | null {
  if (value === null) return null;
  if (source.kind === "direct") return value;
  return Math.round(value * source.factor * 10) / 10;
}

/**
 * The distinct provider requests a set of league sizes needs.
 *
 * Eleven sizes share four boards, so a refresh that fetched one per size would make eleven
 * requests for four answers — per scoring format, three times over. The matrix is small and
 * the provider is somebody else's server; asking it for the same thing seven extra times is
 * the kind of thing that gets an application blocked rather than the kind that costs money.
 *
 * Ascending, so a refresh's request order does not depend on the order sizes were listed in.
 */
export function distinctAdpSources(teams: readonly number[]): number[] {
  return [...new Set(teams.map((size) => adpSourceFor(size).sourceTeams))].sort(
    (a, b) => a - b,
  );
}

/** How a board's provenance reads on screen. */
export function adpSourceLabel(source: AdpSource): string {
  return source.kind === "direct"
    ? `Market prices for ${source.teams}-team leagues, as published.`
    : `No market board is published for ${source.teams}-team leagues, so prices are ` +
        `derived from the ${source.sourceTeams}-team board by rescaling every pick number ` +
        `by ${source.factor.toFixed(3)}. Read them as an approximation.`;
}
