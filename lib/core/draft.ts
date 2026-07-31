import {
  type OptimizableCompetitor,
  type RosterSlot,
  solveLineup,
} from "./optimizer";

/**
 * Draft recommendation.
 *
 * The premise is deliberately narrow, because the wide version is not supportable. This
 * does **not** claim to know which players are better than the market does — measured on
 * held-out seasons, average draft position ranks players better than our projection model
 * does, and a tool that told you otherwise would be repeating the mistake the honesty
 * ledger exists to record. See `docs/draft-validation.md`.
 *
 * What ADP structurally cannot tell you is what *you* should do. It is one global
 * popularity ordering. It does not know your roster, your league's slots, how many picks
 * you have left, or how long until your next one. Those are the questions this answers,
 * and they are answerable exactly:
 *
 *  - **What a player adds** is the difference between the best legal lineup with him and
 *    the best legal lineup without him. That is a maximum-weight matching, solved exactly
 *    by `solveLineup`, not estimated.
 *  - **What waiting costs** is the value of the best player at that position who is still
 *    likely to be there at your next pick, weighted by how likely each is to survive.
 *    ADP dispersion gives that distribution directly.
 *
 * The recommendation is the difference: take the player whose position degrades most
 * before you pick again. This is the standard "value over next available" argument, made
 * exact where exactness is available.
 *
 * **Known limitation — it plans one pick ahead, not to the end of the draft.** Comparing
 * against only the next pick says "I can get one of those later" at every pick in turn,
 * and in the late rounds, where every position is abundant, every score collapses toward
 * zero and the ordering is decided by whatever remains largest in absolute terms. In a
 * simulated fourteen-round draft this left a starting slot unfilled rather than taking the
 * obvious replacement-level player for it.
 *
 * Scoring the *completed* roster instead of a single pick is the right fix and was
 * attempted; a greedy completion is not a correct approximation of it, and the version
 * tried inverted the recommendation on a case this module's own tests pin. Until that is
 * solved properly the single-pick comparison ships, because it is understood and its
 * failure mode is documented, and `docs/draft-validation.md` records that the pick
 * recommendations are not backtested at all.
 */

/** A player who can be drafted, with the market's view of when he will go. */
export interface DraftableCompetitor extends OptimizableCompetitor {
  /**
   * Average draft position, in overall picks. `null` when the market has no opinion —
   * undrafted rookies and deep bench players — which is treated as "available late"
   * rather than as a missing value that would silently score zero.
   */
  adp: number | null;
  /** Dispersion of that ADP, in picks. `null` when unknown; a default is applied. */
  adpStdev: number | null;
}

export interface DraftRosterShape {
  /** Starting slots. Valued exactly, by matching. */
  starters: readonly RosterSlot[];
  /**
   * Bench size. Bench players are valued at a discount rather than at zero, because a
   * bench is real insurance against injury and bye weeks — but valuing them at full price
   * would make the optimiser hoard depth it will never start.
   */
  benchSize: number;
}

export interface DraftState {
  /** Players still on the board. */
  available: readonly DraftableCompetitor[];
  /** Players already on my roster. */
  myRoster: readonly DraftableCompetitor[];
  shape: DraftRosterShape;
  /** Overall pick number I am on now. */
  currentPick: number;
  /**
   * The overall pick number of my next turn after this one, or `null` if this is my last
   * pick. Everything about waiting is measured against this.
   */
  nextPick: number | null;
  /**
   * Every remaining pick I own after this one, in order.
   *
   * Carried so the interface can show how many picks are left to fill each slot. It is
   * **not** currently used to score a pick — see the note on multi-round planning in the
   * module docstring, which is the honest limitation of the present model.
   */
  remainingPicks: readonly number[];
}

export interface DraftRecommendation {
  competitor: DraftableCompetitor;
  /** The recommendation's ranking key: what taking him now is worth over waiting. */
  score: number;
  /** Points he adds to the best legal lineup, right now. */
  valueNow: number;
  /**
   * Expected points added by the best player at his position who survives to my next
   * pick. `null` when there is no next pick, where waiting is not an option.
   */
  valueIfWaited: number | null;
  /** Probability this player is still on the board at my next pick. */
  survivalToNextPick: number;
  /**
   * How far ahead of the market this pick is, in picks. Positive means reaching — taking
   * him earlier than the field would. `null` when the market has no opinion.
   */
  reachPicks: number | null;
  /** Human-readable account of the two terms above. */
  reasons: DraftReason[];
}

export interface DraftReason {
  key: string;
  label: string;
  points: number;
  detail: string;
}

/**
 * Weight applied to a player who does not improve the starting lineup.
 *
 * Judgement, not measurement — there is no backtest behind this number and it is not
 * presented as one. It exists because both extremes are visibly wrong: at zero the
 * optimiser treats a backup running back as literally worthless and will draft a kicker
 * ahead of him, and at one it hoards depth it will never start. A tenth reflects that a
 * bench player only scores for you when someone ahead of him does not.
 *
 * Scaled by how many starting slots his position can fill — see `benchWeightFor`. Without
 * that scaling, bench value is proportional to raw points, quarterbacks have the highest
 * raw points, and the optimiser drafts four of them for a league that starts one.
 */
export const BENCH_VALUE_WEIGHT = 0.1;

/**
 * Slot count a bench weight is normalised against.
 *
 * Three, because the deepest ordinary position — running back or receiver across two
 * dedicated slots plus a flex — is the case the base weight was reasoned about.
 */
const BENCH_REFERENCE_SLOTS = 3;

/**
 * How much a benched player at this position is worth, per point he scores.
 *
 * A backup only ever scores for you when a starter cannot, so his worth depends on how
 * many lineup spots his position has to fill. A second quarterback in a one-quarterback
 * league sits behind a starter who plays every week and is close to worthless; a third
 * running back covers two dedicated slots and a flex, and will start.
 *
 * Judgement rather than measurement, like the base weight, but it fixes a failure that was
 * observable rather than theoretical: without it a simulated draft took four quarterbacks
 * and no running backs at all, because a surplus quarterback's raw points beat a fifth
 * receiver's.
 */
export function benchWeightFor(
  position: string,
  starters: readonly RosterSlot[],
): number {
  const eligibleSlots = starters.filter((slot) =>
    slot.eligiblePositions.includes(position),
  ).length;
  return (BENCH_VALUE_WEIGHT * eligibleSlots) / BENCH_REFERENCE_SLOTS;
}

/**
 * How likely a player must be to survive before the plan counts on him.
 *
 * A half is the natural line: more likely than not. The alternative — weighting every
 * player's value by his survival probability and then planning as though he were certain
 * — lets a player who will almost certainly be gone dominate a plan he cannot be part of,
 * which inverts the recommendation.
 */
export const LIKELY_AVAILABLE = 0.5;

/**
 * How many of the best players at each position are always evaluated.
 *
 * Guarantees that every position stays on the table no matter what the market has priced.
 * Small because the best few are all that can plausibly win: if the third-best available
 * running back is not worth taking, the twentieth is not either.
 */
export const CANDIDATES_PER_POSITION = 5;

/** Assumed ADP dispersion when the market reports none, in picks. */
export const DEFAULT_ADP_STDEV = 12;

/**
 * Where a player with no ADP at all is assumed to go, relative to the last pick.
 *
 * Treated as "after everyone the market has an opinion about" rather than as pick zero.
 * A missing ADP that scored as 0 would make every unranked player look like the consensus
 * first overall pick.
 */
export const UNRANKED_ADP_PADDING = 24;

/** Standard normal CDF, Abramowitz & Stegun 7.1.26. Max error ~7.5e-8. */
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
  player: Pick<DraftableCompetitor, "adp" | "adpStdev">,
  pick: number,
  unrankedAdp: number,
): number {
  const adp = player.adp ?? unrankedAdp;
  const stdev = Math.max(player.adpStdev ?? DEFAULT_ADP_STDEV, 0.5);
  // P(draftSlot >= pick). The pick itself is not yet spent, so a player whose ADP equals
  // the current pick is a coin flip rather than gone.
  return 1 - normalCdf((pick - adp) / stdev);
}

/** Value of a roster: the best legal starting lineup, plus a discounted bench. */
export function rosterValue(
  roster: readonly DraftableCompetitor[],
  shape: DraftRosterShape,
): number {
  if (roster.length === 0) return 0;
  const solution = solveLineup(shape.starters, roster);
  const started = new Set(
    solution.assignments
      .map((a) => a.competitorId)
      .filter((id): id is string => id !== null),
  );
  // Only the bench slots that exist are worth anything. A roster carrying more players
  // than the league allows cannot bank the surplus, and the ones kept are the most
  // valuable rather than the highest-scoring — a backup at a position that starts three
  // is worth more than a higher-scoring one at a position that starts one.
  const benchValue = roster
    .filter((p) => !started.has(p.id))
    .map((p) => benchWeightFor(p.position, shape.starters) * p.projectedPoints)
    .sort((a, b) => b - a)
    .slice(0, shape.benchSize)
    .reduce((sum, value) => sum + value, 0);
  return round2(solution.totalPoints + benchValue);
}

/** What adding this player to this roster is worth, exactly. */
export function marginalValue(
  roster: readonly DraftableCompetitor[],
  player: DraftableCompetitor,
  shape: DraftRosterShape,
): number {
  return round2(rosterValue([...roster, player], shape) - rosterValue(roster, shape));
}

/**
 * Expected marginal value of the best player at a position who survives to a later pick.
 *
 * This is an expectation over *which* player is the best survivor, not the marginal value
 * of the most likely survivor. Those differ: with players ranked by value, the best
 * survivor is the first one that survives, so player `i` contributes only when he
 * survives and everyone ahead of him does not.
 *
 * Sorting is by marginal value rather than by raw projection, because at a filled slot a
 * higher-projected player can be worth strictly less than a lower-projected one at an
 * empty one.
 */
export function expectedBestAvailable(
  candidates: readonly DraftableCompetitor[],
  roster: readonly DraftableCompetitor[],
  shape: DraftRosterShape,
  pick: number,
  unrankedAdp: number,
): number {
  const ranked = candidates
    .map((c) => ({ c, value: marginalValue(roster, c, shape) }))
    .sort((a, b) => b.value - a.value);

  let expected = 0;
  let noneBetterSurvived = 1;
  for (const { c, value } of ranked) {
    const survives = survivalProbability(c, pick, unrankedAdp);
    expected += value * survives * noneBetterSurvived;
    noneBetterSurvived *= 1 - survives;
    // Once it is near-certain someone better has survived, the tail cannot move the
    // result. Stopping keeps this linear in practice on a full board.
    if (noneBetterSurvived < 1e-6) break;
  }
  return round2(expected);
}

/**
 * Ranks the available players by what taking each one now is worth over waiting.
 *
 * `limit` caps how many candidates are fully evaluated. Evaluating the whole board is
 * unnecessary — a player the market puts fifteen rounds away cannot be the right pick
 * now — and each evaluation runs the exact lineup solver twice, so the cap is what keeps
 * this interactive.
 */
export function recommendDraftPicks(
  state: DraftState,
  limit = 40,
): DraftRecommendation[] {
  const { available, myRoster, shape, currentPick, nextPick } = state;
  if (available.length === 0) return [];

  const unrankedAdp = maxAdp(available) + UNRANKED_ADP_PADDING;

  const byPosition = new Map<string, DraftableCompetitor[]>();
  for (const player of available) {
    const bucket = byPosition.get(player.position);
    if (bucket) bucket.push(player);
    else byPosition.set(player.position, [player]);
  }

  // The candidate set is the market's front of board *plus* the best few at every
  // position, and it must be both.
  //
  // Capping by ADP alone is not enough, and fails in the worst possible way. Most
  // rostered players have no ADP at all — the market only prices a couple of hundred — so
  // an ADP-ordered cap silently excludes every unranked player. Once the ranked players
  // at a position are gone, that position stops being considered entirely, even when its
  // starting slots are empty and any warm body there is worth a hundred points more than
  // a fifth receiver. Left alone it drafts a roster it cannot legally start.
  const consideredById = new Map<string, DraftableCompetitor>();
  for (const player of [...available]
    .sort((a, b) => (a.adp ?? unrankedAdp) - (b.adp ?? unrankedAdp))
    .slice(0, Math.max(limit, 1))) {
    consideredById.set(player.id, player);
  }
  for (const players of byPosition.values()) {
    for (const player of [...players]
      .sort((a, b) => b.projectedPoints - a.projectedPoints)
      .slice(0, CANDIDATES_PER_POSITION)) {
      consideredById.set(player.id, player);
    }
  }
  const considered = [...consideredById.values()];

  // One expectation per position, not per candidate: what waiting costs depends on the
  // position, not on which player at it is under consideration.
  const waitValueByPosition = new Map<string, number>();
  if (nextPick !== null) {
    for (const [position, players] of byPosition) {
      waitValueByPosition.set(
        position,
        expectedBestAvailable(players, myRoster, shape, nextPick, unrankedAdp),
      );
    }
  }

  const recommendations = considered.map((competitor) => {
    const valueNow = marginalValue(myRoster, competitor, shape);
    const valueIfWaited =
      nextPick === null ? null : (waitValueByPosition.get(competitor.position) ?? 0);
    const score = round2(valueNow - (valueIfWaited ?? 0));
    const survival =
      nextPick === null
        ? 0
        : survivalProbability(competitor, nextPick, unrankedAdp);

    // Positive means he would still be there later by market consensus, so taking him now
    // spends a pick earlier than the field would. That is often correct — it is exactly
    // what a positional cliff justifies — but it should be visible rather than implicit.
    const reachPicks =
      competitor.adp === null ? null : round2(competitor.adp - currentPick);

    const reasons: DraftReason[] = [
      {
        key: "value.now",
        label: "Adds to your lineup",
        points: valueNow,
        detail:
          `Best legal lineup with him, minus best legal lineup without him. ` +
          `Solved exactly, not estimated.`,
      },
    ];
    if (valueIfWaited !== null) {
      reasons.push({
        key: "value.wait",
        label: `Best ${competitor.position} likely left at pick ${nextPick}`,
        points: -valueIfWaited,
        detail:
          `Expected value of the best ${competitor.position} who survives to your next ` +
          `pick, weighted by how likely each is to last. This is what waiting costs.`,
      });
      reasons.push({
        key: "survival",
        label: "Chance he lasts to your next pick",
        points: 0,
        detail: `${(survival * 100).toFixed(0)}%, from ADP ${
          competitor.adp === null ? "unavailable" : competitor.adp.toFixed(1)
        } and its spread.`,
      });
    }

    if (reachPicks !== null && reachPicks > 0) {
      reasons.push({
        key: "market.reach",
        label: "Ahead of the market",
        points: 0,
        detail:
          `The field takes him around pick ${competitor.adp?.toFixed(1)}, and you are at ` +
          `${currentPick}. Taking him now is ${reachPicks.toFixed(1)} picks early — worth ` +
          `it only if waiting really would cost you the position.`,
      });
    }

    return {
      competitor,
      score,
      valueNow,
      valueIfWaited,
      survivalToNextPick: survival,
      reachPicks,
      reasons,
    };
  });

  return recommendations.sort(
    (a, b) =>
      b.score - a.score ||
      b.valueNow - a.valueNow ||
      (a.competitor.id < b.competitor.id ? -1 : 1),
  );
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

function maxAdp(players: readonly DraftableCompetitor[]): number {
  let max = 0;
  for (const p of players) if (p.adp !== null && p.adp > max) max = p.adp;
  return max;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
