/**
 * Draft market model and snake-draft geometry.
 *
 * What is left here after the recommendation engine moved to `draft-policy.ts`: the two
 * things that are true regardless of how a pick is chosen.
 *
 * **When a player will go.** ADP is a mean with real dispersion, not a deadline, and
 * `survivalProbability` is the only honest reading of it. This module does *not* claim to
 * rank players better than the market — measured on held-out seasons it does not, and
 * `docs/draft-validation.md` records that. It claims only to know what the market itself
 * is saying, and how uncertain the market is when it says it.
 *
 * **Which picks are whose.** Snake order is exact arithmetic, and getting it wrong is
 * invisible rather than loud: the board still renders and picks still land somewhere, just
 * against the wrong roster. `pickOwnership` is written so that every pick in the draft is
 * owned by exactly one team, because the failure that motivated it left the user owning
 * none of them.
 *
 * The superseded value-over-next-available engine that used to live here is gone. It
 * planned one pick ahead, which collapsed to noise in the late rounds and once left a
 * starting slot unfilled; `recommendByChampionship` scores the completed roster instead
 * and had no callers left on the old path.
 */

/** The market's view of a player: when he goes, and how sure the market is. */
export interface MarketPlayer {
  /**
   * Average draft position, in overall picks. `null` when the market has no opinion —
   * undrafted rookies and deep bench players — which is treated as "available late"
   * rather than as a missing value that would silently score zero.
   */
  adp: number | null;
  /** Dispersion of that ADP, in picks. `null` when unknown; a default is applied. */
  adpStdev: number | null;
}

/** Assumed ADP dispersion when the market reports none, in picks. */
export const DEFAULT_ADP_STDEV = 12;

/** Smallest dispersion this will model, so a confident market is still not a certainty. */
export const MIN_ADP_STDEV = 0.5;

/**
 * The dispersion to use for a player, defaulting one the market did not publish.
 *
 * A published zero means "no spread was reported", not "this player goes at exactly his
 * ADP". `parseAdp` says so explicitly — it leaves a missing spread at zero rather than
 * defaulting it, on the grounds that the survival model owns that choice — and then the
 * survival model tested for `null` and never saw one, because the ingest writes the parsed
 * zero straight through.
 *
 * The effect was backwards in the worst possible direction: a player the market has said
 * least about was modelled as the one it was most certain of. Clamped to half a pick, his
 * survival curve is a step function, so the board reported him as certain to be gone or
 * certain to last, and the speculative cache prepared for exactly one future in which he
 * was taken at his ADP and no other.
 */
export function adpDispersion(adpStdev: number | null | undefined): number {
  if (adpStdev == null || adpStdev <= 0) return DEFAULT_ADP_STDEV;
  return Math.max(adpStdev, MIN_ADP_STDEV);
}

/**
 * Where a player with no ADP at all is assumed to go, relative to the last pick.
 *
 * Treated as "after everyone the market has an opinion about" rather than as pick zero.
 * A missing ADP that scored as 0 would make every unranked player look like the consensus
 * first overall pick.
 */
export const UNRANKED_ADP_PADDING = 24;
// Two rounds of a twelve-team draft, and a judgement rather than a measurement — what is
// testable is that an unranked player lands behind everyone the market has priced, which
// is asserted, and not that the gap is 24 rather than 23.

/**
 * Standard normal CDF, Abramowitz & Stegun 7.1.26. Max error ~7.5e-8.
 *
 * The tests hold it to exactly that: twelve tabulated values, each within 7.5e-8. That is
 * the strongest statement available about the six fitted constants below, and it is worth
 * knowing what it does and does not cover. A change of 1e-6 to any of them fails; a change
 * of 1e-7 to most of them fails; a change in the ninth decimal place of the largest does
 * not, because the function is not claiming that much precision. Neither does `sign`
 * treating zero as negative — the polynomial sums to one at zero, so the two branches
 * differ there by about 1e-9.
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/**
 * Probability a player is still available at a given overall pick.
 *
 * ADP is a mean with real dispersion, so this is the probability that his actual draft
 * slot falls after the pick in question. Reading ADP as a hard deadline — "he goes at 40,
 * so he is gone by 41" — is the most common way to misplay a draft board; a player with
 * ADP 40 and a spread of 12 is still there at pick 45 about a third of the time.
 */
export function survivalProbability(
  player: MarketPlayer,
  pick: number,
  unrankedAdp: number,
): number {
  const adp = player.adp ?? unrankedAdp;
  const stdev = adpDispersion(player.adpStdev);
  // P(draftSlot >= pick). The pick itself is not yet spent, so a player whose ADP equals
  // the current pick is a coin flip rather than gone.
  return 1 - normalCdf((pick - adp) / stdev);
}

/**
 * Picks a manager owns in a snake draft, as overall pick numbers.
 *
 * `slot` must be within the league. Outside it the arithmetic still produces numbers — a
 * slot of 12 in a ten-team league yields the pick set of seat 9 — and those numbers look
 * entirely plausible, which is how an out-of-range slot silently handed a manager's whole
 * draft to somebody else. Rejecting it here is the only place that cannot be forgotten.
 */
export function snakePicks(
  slot: number,
  teams: number,
  rounds: number,
): number[] {
  // All three, for the reason the docstring gives about `slot`. A fractional `teams`
  // passes any `slot <= teams` check and then produces fractional overall pick numbers —
  // and `pickOwnership` keys a Map on those, so they never match the integer pick counter
  // the board increments and every pick in the draft ends up owned by nobody. Same silent
  // failure: the board renders, and the advice is computed against the wrong roster.
  if (!Number.isInteger(teams) || teams < 1) {
    throw new Error(`A league cannot have ${teams} teams.`);
  }
  if (!Number.isInteger(rounds) || rounds < 0) {
    throw new Error(`A draft cannot have ${rounds} rounds.`);
  }
  if (!Number.isInteger(slot) || slot < 1 || slot > teams) {
    throw new Error(
      `Draft slot ${slot} is outside a ${teams}-team league. The pick numbers this ` +
        `produces belong to a different seat.`,
    );
  }

  const picks: number[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const positionInRound = round % 2 === 1 ? slot : teams - slot + 1;
    picks.push((round - 1) * teams + positionInRound);
  }
  return picks;
}

export interface LeagueSetup {
  teams: number;
  slot: number;
  rounds: number;
}

/**
 * Coerces a partially-typed league setup into one that is actually draftable.
 *
 * Every field here counts whole things — seats, rounds — and the controls that feed them
 * are number inputs, which yield strings like `"1.5"`, `""` and `"abc"` as a matter of
 * course. Clamping alone is not enough: a fractional slot sits happily inside `1..teams`
 * and then fails the whole-seat requirement further down, where the failure is no longer
 * recoverable. A decimal typed into a draft slot took the page down that way.
 *
 * Rounding rather than rejecting, because this runs on every keystroke. A setup screen that
 * refuses input mid-type is worse than one that settles on the nearest sensible value.
 */
export function normalizeLeagueSetup(
  raw: Partial<Record<keyof LeagueSetup, unknown>>,
  bounds: { minTeams?: number; maxTeams?: number; maxRounds?: number } = {},
): LeagueSetup {
  const minTeams = bounds.minTeams ?? 2;
  const maxTeams = bounds.maxTeams ?? 32;
  const maxRounds = bounds.maxRounds ?? 40;

  const teams = clampWhole(raw.teams, minTeams, maxTeams, minTeams);
  return {
    teams,
    // Bounded by the league it sits in, so shrinking the league cannot leave a slot
    // pointing at a seat that no longer exists.
    slot: clampWhole(raw.slot, 1, teams, 1),
    rounds: clampWhole(raw.rounds, 1, maxRounds, 1),
  };
}

/** Nearest whole number inside the range, or `fallback` for anything unreadable. */
function clampWhole(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/**
 * Which team owns each pick, with the manager being advised always at index 0.
 *
 * Index 0 is not a cosmetic convention — `championshipProbability` evaluates the first team
 * in the array, so "us" has to be first, and every other manager shifts up one. Getting
 * that mapping wrong is invisible: the board still renders, picks still land somewhere, and
 * the only symptom is that the advice is computed for the wrong roster.
 *
 * It threw away the user's entire draft once. With `slot` left above `teams`, the snake
 * arithmetic produced another seat's pick numbers, and because the map is written index-0
 * first with last-write-wins, that seat overwrote all of them — the user owned nothing, was
 * never on the clock, and every recommendation was computed for a team that could not pick.
 * The invariant worth asserting is not "it looks right" but that **every pick in the draft
 * is owned by exactly one team**.
 */
export function pickOwnership(
  teams: number,
  slot: number,
  rounds: number,
): Map<number, number> {
  // Checked here rather than left to `snakePicks`, which only runs if the loop body does.
  // A `teams` below 1 skips the loop entirely and returns an empty map — every pick in the
  // draft owned by nobody, which is the exact failure this function's docstring is about,
  // reached by the one path that never calls the function doing the validating.
  if (!Number.isInteger(teams) || teams < 1) {
    throw new Error(`A league cannot have ${teams} teams.`);
  }

  const owners = new Map<number, number>();
  for (let index = 0; index < teams; index += 1) {
    for (const pick of snakePicks(seatForTeamIndex(index, slot), teams, rounds)) {
      owners.set(pick, index);
    }
  }
  return owners;
}

/**
 * The seat a team index occupies.
 *
 * Index 0 is the user, sitting at their chosen slot; everyone else fills the remaining
 * seats in order. Announcing a manager by their array index instead named every seat below
 * the user's one higher than it really is.
 */
export function seatForTeamIndex(index: number, slot: number): number {
  if (index === 0) return slot;
  return index < slot ? index : index + 1;
}

