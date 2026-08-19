import { type LineupSolution, type RosterSlot, solveLineup } from "./optimizer";
import { coverValue } from "./draft-bench";
import {
  type ReplacementLevel,
  replacementLevels,
  unfilledSlots,
} from "./draft-replacement";
import type { PlayerRisk } from "./roster-utility";
import { type PairedOutcomeComparison, pairedOutcomeComparison } from "./stats";
import {
  type LeagueConfig,
  type TeamOutcome,
  championshipScenarios,
  sampleTeamWeeklyScores,
} from "./season-sim";

/**
 * Choosing a pick.
 *
 * The objective is the probability of winning the league, evaluated by playing the season
 * out — see `season-sim.ts` for why that is the right target and not expected points.
 * Everything that used to be a weighted term is now a consequence: a bye collision, a
 * fragile starter, an empty slot, and a boom-or-bust profile all change championship odds
 * through the simulation rather than through a constant someone picked.
 *
 * ## What is guaranteed, and what is not
 *
 * Exact optimality is unavailable. A draft is a sequential game against opponents who
 * react to what you do, over a state space exponential in the player pool. Any claim of
 * global optimality here would be false.
 *
 * Three real guarantees are available and this implements the first two:
 *
 *  1. **The inner problems are exact.** The best legal lineup for a week is a
 *     maximum-weight matching, solved exactly. Standings and the bracket are played out
 *     rather than approximated.
 *  2. **One step of policy improvement, estimated by simulation.** Every candidate is
 *     evaluated by *committing to it and then finishing the draft under an explicit base
 *     policy*, and the best is taken. The policy improvement theorem is what makes this
 *     the right shape — but the theorem needs the base policy's exact action values, and
 *     these are Monte Carlo estimates over `config.scenarios` draws. Sampling noise can
 *     put a candidate on top whose true championship probability is below the base
 *     policy's own choice, which is why every recommendation carries a standard error and
 *     why candidates inside it are reported as tied rather than ranked. The guarantee
 *     belongs to the theorem; this is an estimate of it.
 *  3. **A computable optimality gap** via a perfect-information relaxation, which would
 *     bound how much better any policy could do. Not implemented; noted so its absence is
 *     visible rather than implied.
 *
 * ## Where the approximations are
 *
 * The base policy is need-aware best-available, which is a reasonable stand-in for how the
 * remaining picks go but is not how anyone actually drafts. Opponents' completions are
 * computed once from the baseline and reused across candidates, because their behavior
 * barely depends on which player *we* take — one player fewer on a board of hundreds. That
 * is an approximation, and it is what makes evaluating candidates affordable.
 */

export interface DraftTeam {
  id: string;
  name: string;
  roster: PlayerRisk[];
  /** Overall pick numbers this team still owns, ascending. */
  remainingPicks: number[];
}

export interface DraftPolicyState {
  teams: DraftTeam[];
  /** Index into `teams` of the team being advised. */
  myTeamIndex: number;
  available: PlayerRisk[];
  /** Total roster size, starters plus bench. */
  rosterSize: number;
}

/**
 * What the policy needs to know about the league beyond who is on the board.
 *
 * One object rather than two parameters because the two are never independently meaningful,
 * and because a season length that disagrees with `LeagueConfig.weeks` is exactly the sort of
 * second copy that stays wrong quietly.
 */
export interface PolicyLeague {
  /** The starting lineup shape every team fields. */
  slots: readonly RosterSlot[];
  /**
   * The fantasy regular season's weeks, by number.
   *
   * Read only by the depth model, and only to price a bye: a player idle in one week of
   * fourteen is unavailable a fourteenth of the time, and one idle in one week of twelve more
   * often than that.
   *
   * **The weeks, not how many.** This was a count, which served the same purpose only while
   * every season ran `1..n` from week one — `expectedAboveReplacement` used it as the
   * denominator *and* as the highest week number that exists, and those are different
   * questions that happened to have the same answer. A season is now laid out from the
   * championship week, so the coincidence is worth not depending on.
   *
   * **Playoff weeks are deliberately excluded, and this is an approximation.** A bye in a
   * playoff round is real and expensive, and the *objective* prices it exactly by playing
   * the bracket out — but a team reaches the third round of a six-team bracket about a sixth
   * of the time, so counting playoff weeks here as certain would overweight them, and
   * weighting them by a qualification probability would be one more tuned constant of the
   * kind this design exists to remove. Passing the whole season was tried and measurably
   * degraded the base policy: at seventeen weeks instead of fourteen the bye term shrinks
   * against `startingGain`, and `completeDraft` began taking a second kicker over skill
   * depth — the exact failure `coverValue` was written to fix. So the shortlist may miss a
   * reserve whose only worth is covering a bye that lands in a playoff round; every
   * candidate that *does* reach it is then valued with that bye priced correctly.
   */
  weeks: readonly number[];
}

export interface ChampionshipRecommendation {
  player: PlayerRisk;
  /** Championship probability if this player is taken and the draft finishes normally. */
  championshipProbability: number;
  /**
   * Change against taking whatever the base policy would have taken.
   *
   * With one deliberate exception, and it is the honest reading rather than a special
   * case: where the market-discipline gate withheld a candidate, the comparison is
   * against the best *offerable* player instead. The base policy is ungated, so it would
   * happily take the market-absent player the panel is refusing to name — and a delta
   * measured against him tells the user their recommendation is worse than something the
   * panel will not show them and gives them no way to identify. See
   * `recommendByChampionship`.
   */
  deltaVsBaseline: number;
  playoffProbability: number;
  expectedPoints: number;
  /**
   * Standard error on this candidate's *own* championship probability.
   *
   * `sqrt(p(1-p)/n)`, the uncertainty in the absolute number — what "16.7%" is worth on its
   * own. Reported because it is frequently larger than the gap between the top few
   * candidates. A title is roughly a one-in-twelve event, so distinguishing 16.7% from
   * 15.8% needs far more scenarios than a draft clock allows.
   *
   * **This is not the uncertainty on a comparison.** Two candidates are simulated over the
   * same seasons, so the difference between them is a paired quantity with its own standard
   * error; adding two marginal ones is not it, under any circumstances. See `vsLeader`.
   */
  standardError: number;
  /**
   * How this candidate compares with the empirical leader, over the same scenarios.
   *
   * `null` for the leader himself — a candidate compared with himself has a difference of
   * exactly zero in every scenario, and reporting an interval of `[0, 0]` around it would
   * dress a tautology as a measurement.
   *
   * **Descriptive, not inferential.** The leader is chosen as the maximum of the same sample
   * these intervals are computed from, so every one of them is conditioned on a selection
   * that used the data. That biases the comparisons against the leader in a direction no
   * correction here removes: no multiple-comparison adjustment is applied and no comparison
   * was predeclared. Read them as a description of what happened in these scenarios, not as
   * a test of what would happen in new ones.
   */
  vsLeader: PairedOutcomeComparison | null;
  /**
   * True when this candidate's title odds are inside sampling noise of the leader's.
   *
   * Decided by the *paired* interval — whether zero difference is inside it — because that
   * is the uncertainty on the comparison being made. It used to be decided by the sum of the
   * two marginal standard errors, which is not the standard error of a difference between
   * anything.
   *
   * A label, not a sort key. It used to reorder: everything flagged tied was ranked by
   * playoff probability, which is how a 14.5% candidate came to wear the leader label above
   * a 16.2% runner-up in the #88 audit — the hidden key outranked the number on the card.
   * The ordering now descends by title odds throughout (see `orderRecommendations`), and
   * this flag only says which gaps these scenarios cannot resolve. The flagged rows are
   * therefore not necessarily contiguous: a candidate the scenarios do separate from the
   * leader can sit above one they cannot, which is the display being honest rather than a
   * sorting error.
   */
  tiedWithLeader: boolean;
}

/**
 * How many candidates are evaluated by simulating the league.
 *
 * Every evaluation replays a season, so the field has to be narrowed first. Ten is enough
 * that the right pick is essentially always inside it — the prefilter is a genuine
 * value estimate, not a guess — while keeping a decision inside the time a draft allows.
 */
export const CHAMPIONSHIP_CANDIDATES = 10;

/**
 * Through which round the market-discipline gate holds.
 *
 * Inside it, a player the board prices at `adp: null` is not offered as a recommendation:
 * his only price is the model's own projection, and the #88 audit measured what trusting
 * that number alone at early-round confidence produces — Kenneth Gainwell recommended and
 * taken at pick 2.06, Colby Parkinson at 6.06, both absent from the market's list, both
 * starting a roster the audit called unusable. The model's measured skill does not
 * support overruling the entire market by four-plus rounds on its own signal
 * (`docs/draft-validation.md`: the market ranks players better than the model), so
 * inside the window where that overruling is most expensive, a market-absent candidate
 * needs a market to argue with before he can be advised.
 *
 * Six rounds because that is the span the audit measured the failure in and the span
 * #91's check (a) locks; the harness's `EARLY_ROUNDS` asserts the same window and a test
 * pins the two to each other. Past the gate the model's projection may lead again —
 * pricing players the market has not is the model's documented reason to exist, and a
 * late-round flier is exactly where that stands to gain more than it risks.
 */
export const MARKET_GATE_ROUNDS = 6;

/**
 * The shortlist entries the market-discipline gate leaves standing.
 *
 * Exported for tests; `recommendByChampionship` is the caller. Three deliberate edges:
 *
 *  - **The gate holds only when the round is known.** `currentRound` is `null` for a
 *    state with no remaining picks, and a state that cannot say which round it is gets
 *    the ungated list — the gate exists to stop a measured early-round failure, not to
 *    filter states it cannot place.
 *  - **`adp` missing entirely (`undefined`) gates like `null`.** Both mean "no market
 *    price on record", and the difference between them is which caller built the object,
 *    not anything about the player.
 *  - **A gate that would empty the shortlist yields.** A panel with no recommendation at
 *    all advises nothing — worse than advising with the documented caveat — so when every
 *    candidate is market-absent the ungated list stands. On any real board the market has
 *    priced hundreds of players and this never fires; it exists for hand-built states.
 *
 * Exclusion rather than demotion, and that is forced, not stylistic: the panel's display
 * contract (#88.2, harness check (f)) is that the leader card carries the panel's highest
 * title odds. A market-absent candidate *shown* below a leader with lower odds would
 * break that contract; shown above, he is the leader and the gate did nothing. The only
 * honest place for him inside the window is off the panel, with the board itself still
 * showing his model price under its "no market price" label.
 */
export function applyMarketGate<T extends { player: PlayerRisk }>(
  scored: readonly T[],
  currentRound: number | null,
): readonly T[] {
  if (currentRound === null || currentRound > MARKET_GATE_ROUNDS) return scored;
  const priced = scored.filter((entry) => entry.player.adp != null);
  return priced.length > 0 ? priced : scored;
}

/**
 * The 1-based round the advised team's next pick falls in, or `null` without one.
 *
 * `remainingPicks` is filtered from the current pick inclusive, so its first entry *is*
 * the pick being advised — the same construction `stateAtPick` documents, and the reason
 * the *first* entry is read rather than any other: a team holding picks 12 and 29 is on
 * the clock at 12, and reading past it would gate by a round the draft has not reached.
 * Rounds are overall picks divided among the league's teams, rounded up.
 *
 * Exported for tests, like `applyMarketGate` above. Every guard here is reachable only
 * from a malformed state, and a guard no test can address is a guard nobody can check:
 * `null` where the pick number is missing or unusable, because the alternative is a
 * `NaN` round that compares false against every bound and silently gates a draft this
 * function could not place.
 */
export function currentRoundOf(state: DraftPolicyState): number | null {
  const next = state.teams[state.myTeamIndex]?.remainingPicks[0];
  // `isInteger` rather than `isFinite`, and it subsumes it: a fractional pick number is
  // not a pick that got rounded, it is a state this function does not understand — the
  // same rule `lib/sources/sleeper.ts` applies to a fractional team count, and for the
  // same reason. Rounding 1.5 up to round 1 would gate on a pick nobody holds.
  if (next === undefined || !Number.isInteger(next) || next < 1) return null;
  return Math.ceil(next / state.teams.length);
}

/**
 * The players a base-policy pick can possibly be.
 *
 * This replaced a window over the top forty by raw projection, which was not the cost
 * optimization it was documented as. The window is sorted by `weeklyMean * availability` —
 * the very quantity the marginal-value objective exists to correct — so a player whose
 * worth is positional rather than raw falls out of it. Measured: a roster with every slot
 * filled but quarterback, and a board of sixty backs plus one quarterback, spent all three
 * remaining picks on bench backs and started the season with the quarterback slot empty.
 * That is the baseline every improvement in this module is quoted against.
 *
 * **Two per position, not one — and this is a heuristic, not a proof.**
 *
 * It used to be a proof. `toCompetitor` valued a player at `weeklyMean * availability` and
 * nothing else, so two players at one position differed to the solver in that number alone
 * and the better of them dominated. #39 ended that: `coverValue` reads `availability` and
 * `byeWeek` **separately**, because a durable backup covers more weeks than a fragile one of
 * the same expected worth, and a backup sharing his starter's bye covers fewer. Three
 * quarterbacks with an identical `weeklyMean * availability` of 12.00 score 3.094, 2.400 and
 * 2.995. That is `draft-bench.ts` working as intended.
 *
 * So value is **not** a function of `weeklyMean * availability` alone, and the best player at
 * a position by that key no longer provably dominates the rest. Measured on the real
 * published board with a roster held: 20 of 1806 adjacent same-position pairs rank the
 * lower-key player higher, the widest being a back scoring 0.543 against one scoring 0.809.
 * The *pricing* is right in every one of those cases. What is false is any claim that the key
 * used to narrow orders candidates the same way their value does.
 *
 * Two regimes are still kept, for two different reasons. The regimes genuinely do not
 * compare — a candidate who scrapes into the lineup for a tenth of a point can be worth less
 * than a slightly worse one priced as cover. And within the **reserve** regime the ordering
 * *is* still monotone: a candidate who never reaches the lineup has no `certain` term to
 * subtract, so his value is the stochastic expectation alone, which increases with his own
 * worth. The starter regime carries no such guarantee.
 *
 * Which regime a candidate falls in is decided without solving anything. Adding one player to
 * an optimally assigned lineup improves it exactly when he beats the weakest player currently
 * seated in a slot he is eligible for — no chain can do better, because everyone already
 * seated is already optimally placed. `startThreshold` is that number per position.
 *
 * **What the hole costs, measured rather than assumed.** Over a fifteen-round completion on
 * the real board, and at three separate mid-draft roster states, `basePolicyPick` over the
 * narrowed field chose the same player as `scoreCandidates` over all 614 rows every time. The
 * gap is real and has not been observed to bite. Closing it exactly means keeping every
 * candidate whose upper bound
 *
 *     (value - startThreshold)+  +  pMax * (value - replacement)+
 *
 * beats the best actual score found so far, where `pMax` is the position's crowding-out
 * probability and the bound is monotone in the same key the scan walks. That is a change to
 * the hot path and belongs with its own benchmark rather than beside this comment.
 *
 * `narrowing the field cannot change the base policy's answer` in the tests runs both paths
 * against each other rather than trusting any argument, on a board whose availability varies
 * **independently** of projection — the only shape that can expose this. A fixture where the
 * two co-vary passes whatever the narrowing does, which is how the first version of this test
 * was green while the claim above it was false.
 */
function contendersFor(
  available: readonly PlayerRisk[],
  startThreshold: ReadonlyMap<string, number>,
): PlayerRisk[] {
  const bestStarter = new Map<string, PlayerRisk>();
  const bestReserve = new Map<string, PlayerRisk>();
  for (const candidate of available) {
    // A position with no threshold has no slot anybody could take, so every candidate at it
    // is a reserve. `Infinity` says that without a special case.
    const threshold = startThreshold.get(candidate.position) ?? Infinity;
    const bucket =
      marketValue(candidate) > threshold ? bestStarter : bestReserve;
    const held = bucket.get(candidate.position);
    // Strictly greater, so the first of several tied bests at a position is the one kept —
    // which is what evaluating the whole board in order would also have done.
    if (held === undefined || marketValue(candidate) > marketValue(held)) {
      bucket.set(candidate.position, candidate);
    }
  }
  return available.filter(
    (candidate) =>
      bestStarter.get(candidate.position) === candidate ||
      bestReserve.get(candidate.position) === candidate,
  );
}

/** The quantity both the lineup solver and the replacement model rank a player by. */
function marketValue(p: PlayerRisk): number {
  return p.weeklyMean * p.availability;
}

/** A `PlayerRisk` as the lineup solver sees him: a position and one number. */
function toCompetitor(p: PlayerRisk) {
  return {
    id: p.id,
    name: p.name,
    position: p.position,
    projectedPoints: marketValue(p),
    availability: "active" as const,
  };
}

/**
 * The replacement-level board, as competitors the lineup solver can assign.
 *
 * One stand-in per slot that could accept the position, because a lineup can want more than
 * one of them: a roster with an empty FLEX and two empty back slots can fill all three from
 * replacement, and offering a single copy would understate what is freely available by two
 * whole slots.
 *
 * A position whose demand outruns the board contributes nothing. There is no replacement to
 * offer — that is what `exhausted` means — and the empty slot it leaves is exactly the point:
 * the last player at a position the league cannot satisfy is worth his whole contribution.
 *
 * They all carry the same value, which is an approximation and a deliberate one. Taking one
 * replacement-level player leaves the next one very slightly worse, and modelling that would
 * make replacement a curve rather than a level. A level is what "value over replacement"
 * means everywhere else, and the difference is far below the noise the objective is measured
 * against.
 */
function replacementBench(
  slots: readonly RosterSlot[],
  replacement: ReadonlyMap<string, ReplacementLevel>,
) {
  const out = [];
  for (const [position, level] of replacement) {
    if (level.exhausted) continue;
    const copies = slots.filter((slot) =>
      slot.eligiblePositions.includes(position),
    ).length;
    for (let i = 0; i < copies; i += 1) {
      out.push({
        id: `${REPLACEMENT_PREFIX}${position}${REPLACEMENT_SEPARATOR}${i}`,
        name: `replacement ${position}`,
        position,
        projectedPoints: level.value,
        availability: "active" as const,
      });
    }
  }
  return out;
}

/**
 * Ids for the replacement-level stand-ins, and the position read back out of one.
 *
 * The separator has to be a sequence no position code contains, because the position is
 * recovered by splitting on it — and a stand-in whose position could not be read back would
 * be credited to the empty string and silently vanish from the slot counts that decide what
 * a reserve is worth. `null` for anything that is not a stand-in, which is every real player.
 */
const REPLACEMENT_PREFIX = "__replacement__";
const REPLACEMENT_SEPARATOR = "__#";

function replacementPositionOf(competitorId: string): string | null {
  if (!competitorId.startsWith(REPLACEMENT_PREFIX)) return null;
  const body = competitorId.slice(REPLACEMENT_PREFIX.length);
  const at = body.lastIndexOf(REPLACEMENT_SEPARATOR);
  return at === -1 ? null : body.slice(0, at);
}

/**
 * How much this player adds to a roster that can otherwise sign anybody replacement-level.
 *
 * The subtraction goes through the lineup solver rather than through the projections,
 * because whether a player displaces anyone is an assignment question: a third back is worth
 * a FLEX slot on one roster and nothing on another, and only the matching knows which.
 *
 * **The alternative is the whole replacement-level board, not one player at one position.**
 * Offering a stand-in only at the candidate's own position asks "what if I filled this slot
 * with another of him", which is the wrong question for any slot more than one position can
 * fill — and it is catastrophically wrong when a position is exhausted. A league whose tight
 * ends run out exactly at its demand prices the first tight end against nothing, correctly;
 * but it then priced the *second* one against nothing too, though he can only reach a FLEX
 * that a replacement-level back would have filled. The board hoarded the position. Against a
 * full replacement bench the second tight end is worth what he beats in the FLEX, which is
 * the honest number.
 *
 * **A player who does not reach the lineup is priced as a reserve, not discounted as one.**
 * The two halves are in the same unit — points per week — so they can be compared directly
 * rather than through a scale factor. What stood here was
 * `weeklyMean * availability * 1e-3`, a raw projection shrunk small enough not to outrank a
 * starter, and it had two defects that a scale factor cannot fix. It ranked reserves by
 * position, because quarterbacks lead on raw points, and it did not diminish, so the roster
 * kept taking more of whichever position led it. A completed fifteen-round standard roster
 * came back holding seven quarterbacks. See `draft-bench.ts` for what replaced it.
 */
function prefilterValue(
  roster: readonly PlayerRisk[],
  candidate: PlayerRisk,
  context: PrefilterContext,
): number {
  const { slots, replacement, bench, baseline, startingSlots } = context;
  const replacementValue = replacement.get(candidate.position)?.value ?? 0;
  const after = solveLineup(slots, [
    ...roster.map(toCompetitor),
    toCompetitor(candidate),
    ...bench,
  ]).totalPoints;
  const startingGain = after - baseline.totalPoints;
  const cover = coverValue(
    roster
      .filter((held) => held.position === candidate.position)
      .map((held) => ({
        value: marketValue(held),
        availability: held.availability,
        byeWeek: held.byeWeek,
      })),
    {
      value: marketValue(candidate),
      availability: candidate.availability,
      byeWeek: candidate.byeWeek,
    },
    startingSlots.get(candidate.position) ?? 0,
    replacementValue,
    context.weeks,
  );
  // Added rather than chosen between. `coverValue` returns only the part of a player's worth
  // that exists because players miss weeks, and `startingGain` is the part the all-available
  // lineup already shows, so the two do not overlap — and a candidate who improves the
  // lineup keeps his depth value instead of forfeiting it. Branching between them ordered a
  // 14.8 back above a 15.0 one at the same position, because the worse of the two was
  // credited with cover the better one also provided.
  return startingGain + cover;
}

/**
 * How many starting slots each position actually occupies, as the lineup currently solves.
 *
 * Counting the slot kinds a position is eligible for overstates it whenever a flexible slot
 * is contested: a FLEX held by a receiver is not a slot a back can walk into when one of his
 * own starters is hurt. The baseline solve already contains the answer, because it fills
 * every slot from the roster plus a replacement-level board — so the positions it seats are
 * the ones that win those slots at the margin.
 *
 * A slot nothing could reach — not even the replacement board, because the position is
 * exhausted — counts for every position eligible for it. Leaving it out would say a position
 * whose board has run dry has nowhere to play, which is the opposite of true.
 *
 * A position seated nowhere gets nothing, and a reserve behind zero slots is worth nothing.
 * That is what keeps a kicker in a league that starts no kicker from acquiring value out of
 * scarcity.
 */
function startingSlotsByPosition(
  roster: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
  baseline: LineupSolution,
): Map<string, number> {
  const bySlotId = new Map(slots.map((slot) => [slot.id, slot]));
  const positionById = new Map(roster.map((player) => [player.id, player.position]));
  const seated = new Map<string, number>();
  const credit = (position: string) =>
    seated.set(position, (seated.get(position) ?? 0) + 1);

  for (const assignment of baseline.assignments) {
    const competitorId = assignment.competitorId;
    if (competitorId === null) {
      for (const position of bySlotId.get(assignment.slotId)?.eligiblePositions ?? []) {
        credit(position);
      }
      continue;
    }
    const replacementPosition = replacementPositionOf(competitorId);
    credit(replacementPosition ?? positionById.get(competitorId) ?? "");
  }
  return seated;
}

/**
 * Replacement level per position, read off the board that is actually still available.
 *
 * The board, not the shortlist. Computing it from a narrowed field would define replacement
 * as "the best player at the position", because a field holding one player per position has
 * nobody behind him — which prices every candidate at his whole projection again and undoes
 * the entire correction.
 */
function replacementFor(
  available: readonly PlayerRisk[],
  leagueUnfilledSlots: readonly RosterSlot[],
): ReadonlyMap<string, ReplacementLevel> {
  return replacementLevels(
    leagueUnfilledSlots,
    available.map((player) => ({
      position: player.position,
      value: marketValue(player),
    })),
  );
}

/**
 * Everything a prefilter score needs that does not depend on which candidate is scored.
 *
 * Solved once per pick rather than once per player on a board of several hundred, and
 * shared with `contendersFor` so the narrowing and the scoring cannot disagree about which
 * regime a candidate is in.
 */
interface PrefilterContext {
  slots: readonly RosterSlot[];
  replacement: ReadonlyMap<string, ReplacementLevel>;
  bench: ReturnType<typeof replacementBench>;
  baseline: LineupSolution;
  startingSlots: ReadonlyMap<string, number>;
  /**
   * The fantasy regular season's weeks, by number. See `PolicyLeague.weeks`.
   *
   * Only the depth model reads it, and only to price a bye. It is a parameter rather than a
   * constant because it is already configuration everywhere else — `LeagueConfig.weeks` —
   * and a second, disagreeing copy of the season is exactly the sort of thing that stays
   * wrong quietly.
   */
  weeks: readonly number[];
  /**
   * The value a candidate has to beat at each position to reach the starting lineup.
   *
   * The weakest player seated in a slot he is eligible for, or 0 where such a slot is
   * empty. Adding one player to an optimal assignment improves it exactly when he clears
   * this: every incumbent is already optimally placed, so no chain of displacements can
   * find value that beating the weakest one does not.
   */
  startThreshold: ReadonlyMap<string, number>;
}

function prefilterContext(
  roster: readonly PlayerRisk[],
  league: PolicyLeague,
  replacement: ReadonlyMap<string, ReplacementLevel>,
): PrefilterContext {
  const { slots, weeks } = league;
  const bench = replacementBench(slots, replacement);
  const baseline = solveLineup(slots, [...roster.map(toCompetitor), ...bench]);
  const startThreshold = new Map<string, number>();
  for (const assignment of baseline.assignments) {
    const slot = slots.find((entry) => entry.id === assignment.slotId);
    if (slot === undefined) continue;
    // An empty slot is free to walk into, so the bar is zero rather than the slot's
    // (absent) occupant. Without this a position whose board is exhausted would report an
    // infinite bar and every candidate at it would be classed a reserve.
    const seated =
      assignment.competitorId === null ? 0 : assignment.projectedPoints;
    for (const position of slot.eligiblePositions) {
      const held = startThreshold.get(position);
      if (held === undefined || seated < held) startThreshold.set(position, seated);
    }
  }
  return {
    slots,
    replacement,
    bench,
    baseline,
    startingSlots: startingSlotsByPosition(roster, slots, baseline),
    weeks,
    startThreshold,
  };
}

function scoreAgainst(
  roster: readonly PlayerRisk[],
  candidates: readonly PlayerRisk[],
  context: PrefilterContext,
): Array<{ player: PlayerRisk; value: number }> {
  return candidates
    .map((player) => ({
      player,
      value: prefilterValue(roster, player, context),
    }))
    // Total, so the answer does not depend on the order the board arrived in. Ties were
    // previously resolved by `Array.prototype.sort` stability over board order, which is
    // deterministic only for as long as nothing upstream reorders the board.
    //
    // Raw value before id, so that when every useful starting and reserve path really is
    // exhausted — every candidate worth exactly nothing over replacement — the fallback is
    // the best player left rather than the alphabetically first one. It cannot outrank
    // anything, because it is only consulted where the values are equal.
    .sort(
      (a, b) =>
        b.value - a.value ||
        marketValue(b.player) - marketValue(a.player) ||
        (a.player.id < b.player.id ? -1 : 1),
    );
}

/**
 * Every available player scored by the prefilter, best first.
 *
 * One definition, used by the shortlist and by the base policy, so "the base policy takes
 * the best available" and "the shortlist is the best available" cannot drift apart — and so
 * that the claim `contendersFor` makes, that narrowing the field cannot change the answer,
 * is a comparison a test can actually run.
 */
export function scoreCandidates(
  roster: readonly PlayerRisk[],
  available: readonly PlayerRisk[],
  league: PolicyLeague,
  leagueUnfilledSlots: readonly RosterSlot[],
): Array<{ player: PlayerRisk; value: number }> {
  const replacement = replacementFor(available, leagueUnfilledSlots);
  return scoreAgainst(roster, available, prefilterContext(roster, league, replacement));
}

/**
 * The base policy: take the best available by value over replacement.
 *
 * Explicit because the improvement guarantee is relative to it. A vague or hidden base
 * policy would make "no worse than the base policy" an empty statement.
 *
 * `leagueUnfilledSlots` is what the whole league still has to fill, which is what decides
 * how deep a position has to run before it is free. It is a parameter rather than something
 * derived from `slots` and a team count because it changes as the draft is played: eleven
 * of twelve teams holding a quarterback leaves one QB slot of demand, not twelve, and
 * pricing the next quarterback against twelve keeps quoting a scarcity already spent.
 */
export function basePolicyPick(
  roster: readonly PlayerRisk[],
  available: readonly PlayerRisk[],
  league: PolicyLeague,
  leagueUnfilledSlots: readonly RosterSlot[],
): PlayerRisk | null {
  // Only one player per position can win a base-policy pick, so the rest are not
  // evaluated. Without this the completion solves a lineup for every one of several hundred
  // players at each of a hundred-odd remaining picks, for every candidate — which was the
  // whole cost of a recommendation.
  const replacement = replacementFor(available, leagueUnfilledSlots);
  const context = prefilterContext(roster, league, replacement);
  const contenders = contendersFor(available, context.startThreshold);
  if (contenders.length === 0) return null;
  return scoreAgainst(roster, contenders, context)[0].player;
}

/**
 * Finishes the draft from the current state under the base policy.
 *
 * Picks are taken in overall order across every team, so a team's choices depend on what
 * the teams picking before it have already taken — which is the part a per-team
 * simulation would get wrong.
 */
/**
 * Completes one team's roster, given what the rest of the league is expected to take.
 *
 * Evaluating a candidate only ever reads our own finished roster — the opponents come from
 * the baseline rollout, which is computed once. Rolling the whole league forward per
 * candidate therefore did twelve times the necessary work and discarded eleven twelfths of
 * it, and that was the dominant cost of a recommendation.
 *
 * The approximation this shares with the cached opponent scores: if we take a player an
 * opponent would have taken, that opponent's alternative is not recomputed. One player out
 * of a board of hundreds cannot move a season simulation.
 *
 * `opponentUnfilledSlots` is what the *rest* of the league still has to start, and it is
 * fixed for the length of this completion because the opponents are not moving while we
 * fill our own roster. Our own share of the demand is recomputed after every pick, because
 * it is precisely what our picks change — taking a back closes a back's slot, and the
 * quarterback we have not taken keeps its own.
 */
export function completeOwnRoster(
  roster: readonly PlayerRisk[],
  ownRemainingPicks: number,
  pool: readonly PlayerRisk[],
  league: PolicyLeague,
  forcedFirstPick: PlayerRisk | null,
  rosterSize: number | undefined,
  opponentUnfilledSlots: readonly RosterSlot[],
): PlayerRisk[] {
  const out = [...roster];
  const taken = new Set(out.map((p) => p.id));
  let available = pool.filter((p) => !taken.has(p.id));

  let picksLeft = ownRemainingPicks;
  // The forced pick goes through both bounds the loop below enforces. Seating it
  // unconditionally is the same failure the loop guard exists to prevent, on the one path
  // that bypasses the loop: a roster already at `rosterSize` came back one player longer
  // than every opponent, and `ownRemainingPicks === 0` seated a candidate anyway and left
  // `picksLeft` at -1.
  // Both bounds the loop applies, plus the identity one: a player already on the roster
  // must not be seated a second time. The forced branch skips the loop, so every check the
  // loop performs has to be repeated here or it is not performed at all.
  const roomForForced =
    picksLeft > 0 &&
    (rosterSize === undefined || out.length < rosterSize) &&
    // `?? ""` and `|| ""` agree here: the only falsy id is the empty string, which both
    // forms leave as the empty string.
    !taken.has(forcedFirstPick?.id ?? "");
  if (forcedFirstPick !== null && roomForForced) {
    out.push(forcedFirstPick);
    taken.add(forcedFirstPick.id);
    available = available.filter((p) => p.id !== forcedFirstPick.id);
    picksLeft -= 1;
  }

  for (let i = 0; i < picksLeft; i += 1) {
    // Bounded by the roster as well as by the picks, the way `completeDraft` bounds every
    // opponent. The two limits are equal in an ordinary draft, but they are supplied
    // independently, and a team holding more picks than seats would otherwise be simulated
    // with a longer roster than anyone it plays — which lifts every candidate's title odds
    // together and reads as a better board rather than as a bug.
    if (rosterSize !== undefined && out.length >= rosterSize) break;
    const pick = basePolicyPick(out, available, league, [
      ...opponentUnfilledSlots,
      ...ownUnfilledSlots(out, league.slots),
    ]);
    if (pick === null) break;
    out.push(pick);
    available = available.filter((p) => p.id !== pick.id);
  }
  return out;
}

/** Our own contribution to the league's remaining demand, at the roster we hold now. */
function ownUnfilledSlots(
  roster: readonly PlayerRisk[],
  slots: readonly RosterSlot[],
): RosterSlot[] {
  return unfilledSlots(
    roster.map((player) => ({ position: player.position, value: marketValue(player) })),
    slots,
  );
}

export function completeDraft(
  state: DraftPolicyState,
  league: PolicyLeague,
  forcedFirstPick: PlayerRisk | null,
): PlayerRisk[][] {
  const { slots } = league;
  const rosters = state.teams.map((t) => [...t.roster]);
  const taken = new Set(rosters.flat().map((p) => p.id));
  // Same three checks as `completeOwnRoster`, for the same reason: this branch bypasses
  // the loop below, so nothing else applies them. Seating a player who is already on a
  // roster would put him on two teams; seating one into a full roster would field a team
  // larger than everyone it plays.
  if (
    forcedFirstPick !== null &&
    !taken.has(forcedFirstPick.id) &&
    rosters[state.myTeamIndex].length < state.rosterSize
  ) {
    rosters[state.myTeamIndex].push(forcedFirstPick);
    taken.add(forcedFirstPick.id);
  }

  // Every remaining pick in the draft, in order, tagged with the team that owns it.
  const order: Array<{ pick: number; team: number }> = [];
  state.teams.forEach((team, index) => {
    for (const pick of team.remainingPicks) order.push({ pick, team: index });
  });
  order.sort((a, b) => a.pick - b.pick);

  let pool = state.available.filter((p) => !taken.has(p.id));
  // Per-team remaining starter demand, kept up to date as the draft is played rather than
  // recomputed from scratch for the whole league at every one of a hundred-odd picks. Only
  // the team that just picked can have changed.
  const unfilledByTeam = rosters.map((roster) => ownUnfilledSlots(roster, slots));
  for (const { team } of order) {
    if (rosters[team].length >= state.rosterSize) continue;
    if (pool.length === 0) break;
    const pick = basePolicyPick(rosters[team], pool, league, unfilledByTeam.flat());
    if (pick === null) break;
    rosters[team].push(pick);
    unfilledByTeam[team] = ownUnfilledSlots(rosters[team], slots);
    pool = pool.filter((p) => p.id !== pick.id);
  }
  return rosters;
}

/**
 * Ranks candidate picks by the championship probability they lead to.
 *
 * Every candidate is judged against identical scenarios: `seed` is passed unchanged into
 * `sampleTeamWeeklyScores` for each one, and each player's stream is derived from his own
 * id, so the same player draws the same numbers whichever candidate roster he sits in.
 * Without that the differences between candidates — often a fraction of a percentage
 * point — would be buried in sampling noise.
 */
export function recommendByChampionship(
  state: DraftPolicyState,
  config: LeagueConfig,
  seed: number,
  candidateLimit = CHAMPIONSHIP_CANDIDATES,
): ChampionshipRecommendation[] {
  // Checked here, because the state arrives from the worker through `postMessage` and no
  // local type carries across that boundary. Unvalidated, an out-of-range index makes `me`
  // undefined and the failure surfaces as a TypeError from inside the simulation rather
  // than at whatever built the state. `sampleFuture` applies the same rule to seat indices.
  if (
    !Number.isInteger(state.myTeamIndex) ||
    state.myTeamIndex < 0 ||
    state.myTeamIndex >= state.teams.length
  ) {
    throw new Error(
      `Advising team index ${state.myTeamIndex}, which is not one of the ` +
        `${state.teams.length} teams in this draft.`,
    );
  }
  const me = state.teams[state.myTeamIndex];
  if (state.available.length === 0) return [];

  // Narrow the field cheaply, then judge what is left properly. The demand this prices
  // against is the whole live league's — every team's unfilled starting slots as they stand
  // right now, which is what decides how deep a position runs before it is free.
  // The regular season's actual week numbers, from the same config the simulation runs on.
  //
  // Not `config.weeks.length`, which is what this used to pass. `expectedAboveReplacement`
  // reads its season argument twice — as the denominator *and* as the bound a bye must fall
  // under — and a count only serves the second job while the weeks happen to be `1..n`
  // starting at one. They are today, but nothing said so, and the two readings had already
  // diverged in meaning: a length test is a different question from "is this week played".
  //
  // Not the playoff weeks either, and that is a deliberate approximation rather than an
  // oversight — see `PolicyLeague.weeks`.
  const league: PolicyLeague = { slots: config.slots, weeks: config.weeks };
  const leagueUnfilled = state.teams.flatMap((team) =>
    ownUnfilledSlots(team.roster, config.slots),
  );
  // The market-discipline gate stands between the scoring and the shortlist, and only
  // here: the base policy, the opponent completions, and our own rollout all stay
  // ungated. Gating them would change what every simulated roster looks like — a
  // different measurement, not a discipline on the advice — and the base policy taking a
  // market-absent player *later, at his value* is exactly the outcome the gate is
  // steering toward. Filtered before the slice, so the gate promotes the next priced
  // candidate into the field rather than shortening it.
  const scored = scoreCandidates(me.roster, state.available, league, leagueUnfilled);
  const gated = applyMarketGate(scored, currentRoundOf(state));
  const shortlist = gated
    .slice(0, Math.max(candidateLimit, 1))
    .map((entry) => entry.player);
  // Whether the gate actually withheld anyone, which decides what "vs. best available"
  // can honestly mean below.
  const gateWithheld = gated.length !== scored.length;

  // Opponents are completed once. Their behavior changes by at most one player depending
  // on what we take, which cannot move a season simulation meaningfully, and recomputing
  // eleven rosters per candidate would dominate the cost.
  const baselineRosters = completeDraft(state, league, null);
  const opponentRosters = baselineRosters.filter(
    (_, index) => index !== state.myTeamIndex,
  );
  // One definition, used by both places that sample an opponent. The baseline samples every
  // opponent once and a candidate held by an opponent resamples that one team; the two must
  // draw from the same stream, or the comparison between them carries a change to an
  // opponent that has nothing to do with the pick. Nothing enforced that when the offset was
  // written out twice — and an offset that disagrees produces plausible numbers, not an
  // error.
  const opponentSeed = (index: number) => seed + 1000 + index;
  const baselineOpponentScores = opponentRosters.map((roster, index) =>
    sampleTeamWeeklyScores(roster, config, opponentSeed(index)),
  );

  // What the rest of the league is expected to take, so our own rollout draws from the
  // board they leave behind rather than from the whole pool.
  const claimedByOthers = new Set(opponentRosters.flat().map((p) => p.id));
  const poolForUs = state.available.filter((p) => !claimedByOthers.has(p.id));
  const ownPicksLeft = me.remainingPicks.length;

  /**
   * Opponent scores for a world in which we take `forced`.
   *
   * The shortlist is drawn from `state.available`, and the baseline completion may already
   * have given one of those players to an opponent — so scoring a candidate against the
   * untouched baseline played him on two teams at once, adding his points to ours without
   * removing them from theirs. That inflates exactly the candidates an opponent wanted,
   * which is the ordering this function exists to get right.
   *
   * At most one opponent can hold him, since `completeDraft` never deals a player twice.
   * That opponent is re-completed with the next player the base policy would have taken,
   * because leaving the hole open would understate them by a whole roster spot — the
   * mirror of the same error.
   */
  const opponentScoresFor = (
    forced: PlayerRisk | null,
  ): { scores: number[][][]; replacementId: string | null } => {
    if (forced === null) {
      return { scores: baselineOpponentScores, replacementId: null };
    }
    const owner = opponentRosters.findIndex((roster) =>
      roster.some((p) => p.id === forced.id),
    );
    if (owner === -1) return { scores: baselineOpponentScores, replacementId: null };

    // `forced` is on an opponent roster in this branch, so `claimedByOthers` already kept
    // it out of `poolForUs` and no further filtering is needed here.
    const without = opponentRosters[owner].filter((p) => p.id !== forced.id);
    // That opponent's own remaining demand, not the league's. Every other team in the
    // baseline is already complete, and this one is short exactly the player we took, so
    // the slot he was filling is the demand the substitute is chosen against.
    const replacement = basePolicyPick(
      without,
      poolForUs,
      league,
      ownUnfilledSlots(without, config.slots),
    );
    const scores = [...baselineOpponentScores];
    scores[owner] = sampleTeamWeeklyScores(
      replacement === null ? without : [...without, replacement],
      config,
      opponentSeed(owner),
    );
    // `??` rather than `||`, and the two do differ — for a player whose id is the empty
    // string, `||` would report "no replacement" and leave him in our pool as well as on
    // the opponent's roster, which is the double-count this branch exists to remove.
    // Nothing on a real board carries an empty id, so no test separates them; `??` is the
    // form that stays correct if one ever does.
    return { scores, replacementId: replacement?.id ?? null };
  };

  const evaluate = (
    forced: PlayerRisk | null,
  ): { outcome: TeamOutcome; titleByScenario: boolean[] } => {
    const { scores, replacementId } = opponentScoresFor(forced);
    // The replacement has to leave our pool as well. Both selections run `basePolicyPick`
    // over the same `poolForUs`, so they routinely land on the same player — which put him
    // on the opponent's roster and ours in one scenario. That is the very double-count
    // this branch was added to remove, reintroduced one step later, and it fires only for
    // candidates an opponent held, which is precisely the set the branch exists for.
    const mineRoster = completeOwnRoster(
      me.roster,
      ownPicksLeft,
      replacementId === null
        ? poolForUs
        : poolForUs.filter((p) => p.id !== replacementId),
      league,
      forced,
      state.rosterSize,
      // The opponents are complete by this point, so whatever they still cannot start is a
      // hole they will carry into the season rather than demand they can spend. Their
      // remaining slots stay in the total because a slot nobody can fill is still a slot
      // nobody filled — dropping them would price the last rounds against a league that has
      // stopped drafting.
      opponentRosters.flatMap((roster) => ownUnfilledSlots(roster, config.slots)),
    );
    const mine = sampleTeamWeeklyScores(mineRoster, config, seed);
    // Scenario by scenario, not only the rate. Every candidate is evaluated over the same
    // seasons, so which of them a candidate wins is the informative quantity and it is only
    // visible before the sum.
    return championshipScenarios(mine, scores, config);
  };

  const evaluated = shortlist.map((player) => ({ player, ...evaluate(player) }));

  // What `deltaVsBaseline` is measured against — and the gate moves it.
  //
  // `evaluate(null)` is the base policy left to its own devices, which is the right
  // baseline while every candidate it might take is also a candidate we might recommend.
  // Once the gate withholds someone, it stops being: the base policy still takes the
  // market-absent player the panel refuses to name, so every displayed delta would be
  // measured against a row the user cannot see, cannot take, and is not told about. The
  // panel labels this figure "title odds vs. best available", and best available has to
  // mean the best thing on offer.
  //
  // So where the gate withheld a candidate, the baseline is the best *offerable* one —
  // `gated[0]`, the top of the prefilter's own ordering, which is exactly what the base
  // policy would have taken had it been subject to the same discipline. That entry is
  // already evaluated, so this costs no extra simulation. Nothing about the ordering
  // changes either way: `orderRecommendations` never reads this field.
  //
  // The length test is defensive rather than load-bearing, and a mutation run reports
  // `>= 0` as a survivor for exactly that reason: `state.available` is non-empty by the
  // early return above, `scoreCandidates` scores every available player, and the slice
  // keeps at least one — so `evaluated` provably cannot be empty here. Kept because the
  // index below would otherwise be an unguarded read of a possibly-empty array, which is
  // a worse thing to leave to a future edit than a branch no input reaches.
  const baseline =
    gateWithheld && evaluated.length > 0 ? evaluated[0] : evaluate(null);

  // The leader is the empirical maximum over these same scenarios. That is a choice made
  // *with* the data, and it is why every `vsLeader` interval is labelled descriptive rather
  // than inferential — see `ChampionshipRecommendation.vsLeader`.
  //
  // On the *raw* probability, with ties broken by exactly the residual keys
  // `orderRecommendations` sorts by — playoff probability, expected points, lower id — so
  // the entry carrying `vsLeader: null` is provably the entry the ordering puts first.
  // The proof leans on `meanDifference` being the raw rate difference against this leader:
  // rounding is monotone, so no rounded probability outranks the leader's, and within the
  // leader's rounded class every other entry's mean difference is at most the leader's
  // zero, with exact raw ties falling to the same residual keys this selection used. When
  // the leader was chosen on the rounded probability instead, two candidates 5e-5 apart
  // could put the `vsLeader: null` entry second, with its own baseline displayed below it.
  // A mutation run reports survivors on this selection, triaged: the id arm's `<` has no
  // `<=` to disagree with (two entries never share a player id), and the reduce's `> 0`
  // cannot see `>= 0` because `leadsOver` never returns zero — the id arm is ±1. The
  // `||` joins are genuine gaps rather than equivalences: turned into `&&`, a residual
  // key outvotes the championship rate wherever the two disagree at the top of a
  // shortlist, and no deterministic fixture in the suite produces that disagreement on
  // an exact budget. What bounds the damage is that the displayed ordering never
  // consults this selection: `orderRecommendations`' mean-difference key is offset by a
  // constant whichever leader is chosen, so a wrong leader can mislabel which row
  // carries the null comparison and anchors the tie flags — never which row displays
  // the higher number.
  const leadsOver = (a: (typeof evaluated)[number], b: (typeof evaluated)[number]) =>
    a.outcome.championshipProbability - b.outcome.championshipProbability ||
    a.outcome.playoffProbability - b.outcome.playoffProbability ||
    a.outcome.expectedPoints - b.outcome.expectedPoints ||
    (a.player.id < b.player.id ? 1 : -1);
  const leader = evaluated.reduce((best, entry) =>
    leadsOver(entry, best) > 0 ? entry : best,
  );

  const ranked = evaluated
    .map(({ player, outcome, titleByScenario }) => {
      const p = outcome.championshipProbability;
      return {
        player,
        // Both rounded, so `delta <= probability` is exact rather than nearly exact. With
        // an unrounded probability and a rounded delta, a zero baseline makes the delta
        // `round4(p)`, which can exceed `p` by 5e-5 — and the test asserting that relation
        // holds today only because the fixture never produces a zero baseline.
        championshipProbability: round4(p),
        deltaVsBaseline: round4(p - baseline.outcome.championshipProbability),
        playoffProbability: outcome.playoffProbability,
        expectedPoints: outcome.expectedPoints,
        standardError: round4(Math.sqrt((p * (1 - p)) / config.scenarios)),
        // `null` rather than a self-comparison. A candidate against himself disagrees in no
        // scenario, so the interval would be [0, 0] — a tautology wearing a measurement.
        vsLeader:
          player.id === leader.player.id
            ? null
            : pairedOutcomeComparison(titleByScenario, leader.titleByScenario),
      };
    });

  return orderRecommendations(ranked);
}

/**
 * Marks what is statistically level with the leader, then orders the board.
 *
 * Separated from the simulation above so it can be tested on its own. Reaching these
 * branches through `recommendByChampionship` means finding a roster and a seed whose
 * simulated title odds happen to land in the arrangement under test, which is neither
 * reliable nor readable; the ordering itself is a pure function of a few numbers per
 * candidate and belongs in one.
 *
 * ## The ordering descends by title odds, and the tie flag no longer reorders
 *
 * It used to: everything flagged tied with the leader was ranked by playoff probability,
 * on the argument that title odds inside the noise band carried no information and the
 * smoother signal did. The #88 audit showed what that costs — the "leader" card read
 * 14.5% above a runner-up's 16.2%, because the hidden playoff key promoted a lower title
 * number into the top slot — and #89.C identified the instrument the argument overlooked:
 * the *paired* vs-leader comparison. Candidates are simulated over the same seasons, so
 * the difference between two of them is measured far more tightly than the two marginal
 * probabilities suggest. Its point estimate is exactly the difference of the title rates
 * — pairing changes the variance, not the mean (`stats.ts` says so at length) — so
 * "rank by the paired comparison" and "rank by title odds" are the same ordering, and
 * what the pairing buys is the honest tie flag, not a different order. The argument the
 * old tiebreak rested on was measuring the wrong uncertainty: the marginal bands overlap
 * long after the paired comparison has an unambiguous sign.
 *
 * So the sort is: displayed title odds first, then the paired mean difference, and
 * playoff probability, expected points and id only where the scenarios genuinely cannot
 * tell two candidates apart — an exactly equal rate difference. The mean-difference key
 * deserves honesty about its own weight: at the page's 600 scenarios adjacent title rates
 * differ by at least 1/600, far above the display's 1e-4 rounding grain, so a rounded tie
 * is always an exact tie and the key never separates anything today. It is kept because
 * it costs one comparison and keeps the ordering exact for any scenario count that
 * *does* outrun the rounding grain, rather than quietly re-introducing a residual-key
 * decision there. Rounding is monotone, so neither it nor any residual key can put a
 * lower displayed probability above a higher one. The top card therefore always carries
 * the panel's highest title odds, which is what "best available" has to mean.
 * `tiedWithLeader` still says which gaps are inside sampling noise; it just says it
 * without resorting the list.
 */
export function orderRecommendations(
  ranked: ReadonlyArray<Omit<ChampionshipRecommendation, "tiedWithLeader">>,
): ChampionshipRecommendation[] {
  if (ranked.length === 0) return [];

  // Copied, because this is exported: it used to write `tiedWithLeader` onto the caller's
  // objects and sort the caller's array. `recommendByChampionship` hands it a freshly built
  // list so nothing was affected, but a function whose whole job is to order a list should
  // not also edit one.
  // The flag's value here is arbitrary — the loop below assigns every entry
  // unconditionally — and it is present only because the type requires it before `best` is
  // known. `true` would behave identically.
  const ordered: ChampionshipRecommendation[] = ranked.map((entry) => ({
    ...entry,
    tiedWithLeader: false,
  }));

  // The reference for the tie flag's fallback rule below, established against the true
  // maximum rather than pairwise: "within noise of the neighbor" is not transitive, and a
  // flag measured against whoever happened to sit above would call 12% tied through a
  // chain of overlapping bands.
  //
  // Which of several equal-probability entries `reduce` settles on is broken on the player
  // id rather than on argument order, so the flags do not depend on the order the entries
  // arrived in.
  const best = ordered.reduce((a, b) =>
    b.championshipProbability > a.championshipProbability ||
    (b.championshipProbability === a.championshipProbability && b.player.id < a.player.id)
      ? b
      : a,
  );
  for (const entry of ordered) {
    // The paired interval where there is one, because that is the uncertainty on the
    // comparison actually being made. Zero inside it means these scenarios do not separate
    // the two candidates.
    //
    // The fallback covers two cases. The leader has no paired comparison because comparing
    // him with himself is a tautology, and he is tied with himself by definition. And
    // `orderRecommendations` is exported and reachable with hand-built numbers that carry no
    // paired vector at all. The rule there is the old one — the sum of two marginal standard
    // errors — which is *not* the standard error of a difference between anything. It is a
    // deliberately conservative stand-in that marks more candidates tied rather than fewer,
    // which is the safe direction for a flag whose whole purpose is to stop an unresolved
    // ordering from reading as decided.
    entry.tiedWithLeader =
      entry.vsLeader === null
        ? entry.player.id === best.player.id ||
          best.championshipProbability - entry.championshipProbability <=
            best.standardError + entry.standardError
        : entry.vsLeader.interval[0] <= 0 && entry.vsLeader.interval[1] >= 0;
  }

  // Displayed title odds first, so no row can sit above a higher number than its own —
  // the #88.2 contract. The paired mean difference is the raw rate difference against
  // the leader, computed from the scenario counts, so it restores whatever resolution
  // the display's rounding dropped and cannot disagree with the display's ordering —
  // though at the page's scenario count it never fires (see the docstring: a rounded tie
  // there is an exact tie). `?? 0` covers the leader — a zero difference with himself,
  // by definition — and hand-built entries reaching this exported function with no
  // paired vector at all, which then order on the remaining keys alone. (A mutation run
  // reports `??`→`||` here as a survivor, correctly: the only falsy mean difference is
  // zero, which both forms send to zero.) Playoff
  // probability and expected points decide only exact rate ties, where any deterministic
  // order is as honest as any other and the likelier playoff team is the more useful row
  // to read first.
  //
  // The final clause never compares a candidate with itself — `ranked` holds one entry
  // per player — so the `1` arm is only ever reached as "greater", and
  // `Array.prototype.sort` needs no more than the "strictly less" signal.
  return ordered.sort(
    (a, b) =>
      b.championshipProbability - a.championshipProbability ||
      (b.vsLeader?.meanDifference ?? 0) - (a.vsLeader?.meanDifference ?? 0) ||
      b.playoffProbability - a.playoffProbability ||
      b.expectedPoints - a.expectedPoints ||
      (a.player.id < b.player.id ? -1 : 1),
  );
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
