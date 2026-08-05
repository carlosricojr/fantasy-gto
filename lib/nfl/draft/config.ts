/**
 * Frozen draft-valuation constants.
 *
 * Selected on the 2023 season and then evaluated once, unchanged, on 2024 — the same
 * discipline the weekly model follows. `pnpm draft-backtest` reproduces both runs.
 * Retuning these against 2024 would destroy the property that makes the published figure
 * mean anything.
 *
 * `docs/draft-validation.md` records what was measured.
 */

/**
 * Weight on our own season projection when blended with the market's.
 *
 * Small, and the measurement behind it is negative. **Average draft position ranks
 * players substantially better than our model does**: on held-out 2024 the market scored
 * a Spearman correlation of 0.5403 against actual season points and our model 0.4433.
 * Blending at this weight scored 0.5364 — very slightly *worse* than the market alone.
 * The improvement seen on the tuning season did not replicate.
 *
 * It is 0.2 because that is what the 2023 tuning season chose, and it is frozen because
 * re-tuning against the season used to evaluate it is what makes a published figure
 * meaningless. Reporting that it failed to replicate is the honest response, not quietly
 * moving it to zero.
 *
 * The model keeps a weight for a reason that does not depend on beating the market: it
 * prices the roughly two thirds of rostered skill players who have no published ADP at
 * all, where it is the only estimate available.
 *
 * **No ranking edge over the market may be claimed in the interface**, because none was
 * measured. See `docs/draft-validation.md`, including the note on how an earlier pooled
 * ADP curve made the market look far worse than it is.
 */
export const MODEL_BLEND_WEIGHT = 0.2;

/**
 * Smoothing on per-game fantasy points across a player's prior two seasons.
 *
 * Matches `EMA_ALPHA` in the weekly model, deliberately. A draft projection that weighted
 * recent games differently from the in-season model would mean the two disagreed about
 * the same player on the same evidence.
 */
export const SEASON_EMA_ALPHA = 0.15;

/** Games in an NFL regular season for one team. */
export const GAMES_IN_SEASON = 17;

/**
 * Floor on the fraction of a season a player is assumed to play.
 *
 * A player's prior-season availability is the only durable evidence we have about future
 * availability, but it cannot be the whole story: someone who missed most of last year
 * with a broken bone is not therefore a half-time player this year. Expected games ramps
 * from this floor to a full season as prior availability rises, which keeps a returning
 * starter from being written off while still discounting the chronically unavailable.
 *
 * Judgement, not measurement. It is here rather than inline so it is visible as a choice.
 */
export const AVAILABILITY_FLOOR = 0.5;

/**
 * Positions the model projects.
 *
 * Kickers and defences are not among them and will not be: the weekly model has no view
 * of either, and inventing one would be fabricating a number.
 */
export const MODELLED_POSITIONS = ["QB", "RB", "WR", "TE"] as const;

/**
 * Positions the board carries.
 *
 * Wider than the modelled set, because a league that starts a kicker needs to draft one.
 * Leaving them off the board did not make the tool cautious — it made it unusable for
 * such a league: the slot could never be filled, every simulated roster carried a
 * permanent hole, and a user following the recommendations would finish the draft without
 * a kicker.
 *
 * They are carried on the market's valuation alone. That is not a compromise but the same
 * rule every other player follows: where the model has no opinion, the market's stands by
 * itself, exactly as it does for a rookie with no prior games.
 */
export const DRAFTABLE_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;

export type DraftablePosition = (typeof DRAFTABLE_POSITIONS)[number];

/**
 * How the market names positions we spell differently.
 *
 * Fantasy Football Calculator publishes kickers as `PK` and defences as `DEF`. Matching on
 * our own spelling silently drops both.
 */
export const MARKET_POSITION_ALIASES: Readonly<Record<string, string>> = {
  PK: "K",
  DEF: "DST",
  "D/ST": "DST",
};

/** Normalises a market position code to ours. */
export function normalizeMarketPosition(raw: string): string {
  const code = raw.trim().toUpperCase();
  // `??` and `||` agree: an alias is a non-empty string, so the only way this can be falsy
  // is by being absent, which is the fallback. Kept as `??` because it is the form that
  // stays correct if an alias ever maps to something falsy.
  return MARKET_POSITION_ALIASES[code] ?? code;
}
