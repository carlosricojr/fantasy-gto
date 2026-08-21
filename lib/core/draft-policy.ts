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
  /**
   * The share of an absence the waiver wire covers for free, by position — the depth
   * model's `wireCover`.
   *
   * Read twice, for related valuation purposes:
   *
   *  - **As the value of a hypothetical signing** in the replacement baseline: an empty
   *    slot receives only the share the wire can actually supply.
   *  - **As a discount** on `coverValue`, at every position: the part of an absence the
   *    wire covers is not something a drafted reserve sells you.
   * A position absent from the map reads as zero — the wire covers nothing there — which
   * is the behaviour every caller had before this existed. See `LeagueConfig.wireCover`
   * for why the field is required upstream anyway.
   */
  wireCover: ReadonlyMap<string, number>;
}

export interface ChampionshipRecommendation {
  player: PlayerRisk;
  /** Championship probability if this player is taken and the draft finishes normally. */
  championshipProbability: number;
  /**
   * Change against taking whatever the base policy would have taken.
   *
   * With one deliberate exception, and it is the honest reading rather than a special
   * case: where a gate withheld a candidate — the market-discipline gate or the
   * streamable-position discipline — the comparison is against the best *offerable*
   * player instead. The base policy is ungated, so it would happily take the player the
   * panel is refusing to name — and a delta measured against him tells the user their
   * recommendation is worse than something the panel will not show them and gives them no
   * way to identify. See `recommendByChampionship`.
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
 * How many rounds before its own market round a streamable position may be taken.
 *
 * **Zero: not before the market's own round.** For these two positions the model is
 * silent — `docs/draft-validation.md` says so outright, their entire price is the
 * market's, and their weekly spread is still the `placeholder` band rather than a
 * measured one — so the engine holds no information the market does not, and every round
 * of lead is a pick spent on a claim nothing is making. The audit's Seattle D/ST went at
 * 5.05 against a round-nine market and its first kicker at 9.05 against a round-fifteen
 * one: four and six rounds of lead, and the roster paid for both.
 *
 * Named rather than inlined as `- 0`, because the number is the whole stance and because
 * it has to be *compared* with something: the harness's check (d) tolerates
 * `MARKET_ROUND_TOLERANCE` rounds of lead, and `mock.test.ts` pins this at or below it —
 * an inequality rather than the equality `MARKET_GATE_ROUNDS` and `EARLY_ROUNDS` carry.
 * A policy stricter than its check still enforces it; a policy looser than its check
 * leaves the check asserting a discipline nothing implements, which is the failure the
 * pin exists to catch.
 *
 * The measured cost of the two rounds this used to allow, on the frozen fixture: at a
 * lead of two the defence went at 7.05, the earliest round the rule permitted, and the
 * pick came out of the receiver the roster finished three short of (harness check (e)).
 * At a lead of zero it went at 16.06 and the receiver was taken.
 */
export const STREAMABLE_MARKET_LEAD_ROUNDS = 0;

/**
 * The closing rounds, in which the streamable discipline stands down entirely.
 *
 * A second defence in the last round costs nothing better — there is nothing better left
 * to spend the pick on — so both rules below are lifted there. This is the same exemption
 * the harness's check (b) grants, and `mock.test.ts` pins the two constants together.
 */
export const STREAMABLE_CLOSING_ROUNDS = 2;

/**
 * What the streamable discipline needs to know beyond the shortlist itself.
 *
 * One object because none of the five is meaningful without the others, and because a
 * caller assembling them separately is a caller who can pass a round from one draft and a
 * roster from another.
 */
export interface StreamableContext {
  /** The 1-based round of the pick being advised, or `null` when the state cannot say. */
  currentRound: number | null;
  /** Teams in the league — what turns an overall market pick into a market round. */
  teams: number;
  /**
   * Picks each team makes, which is the draft's last round.
   *
   * `DraftPolicyState.rosterSize` — the roster is filled by the draft, so its size is the
   * round count. The two are supplied independently elsewhere in this module
   * (`completeOwnRoster` bounds by both), and where they disagree this rule follows the
   * roster, because "the closing rounds" means the end of *this team's* drafting.
   */
  rounds: number;
  /** The advised team's roster as it stands, for the reserve cap. */
  roster: readonly PlayerRisk[];
  /** Positions whose weekly output the model does not project. */
  unprojectedPositions: ReadonlySet<string>;
}

/**
 * The market round a player is drafted in, or `null` where the board does not price him.
 *
 * Rounds are overall picks divided among the league's teams, rounded up, floored at one —
 * the same arithmetic `currentRoundOf` applies to our own pick, so "his round" and "this
 * round" are comparable numbers rather than two conventions. A non-finite or negative ADP
 * is not a market round that got rounded; it is a board this function does not understand,
 * and it reads as unpriced.
 */
function marketRoundOf(player: PlayerRisk, teams: number): number | null {
  const adp = player.adp;
  // Three mutants survive on this line and all three are equivalences at the exported
  // surface, argued rather than papered over with fixtures nobody would draft in.
  //
  // `teams < 1` read as `teams <= 1` or as `teams < 0` changes only a one-team or
  // zero-team league: at zero the division is `Infinity`, which no round ever reaches,
  // and at one the market round is the ADP itself, which no draft this long reaches
  // either — so the candidate is withheld outside the closing rounds under every
  // variant. The guard is here to keep a division by zero from producing a *number*, not
  // to price a league with one team in it.
  //
  // The first `||` read as `&&` is equivalent for both inputs it can see. A null ADP
  // still returns null, because `Number.isFinite(null)` is false and the negation makes
  // the conjunction true. A `NaN` ADP no longer returns null — and then produces a `NaN`
  // market round, which fails the `>=` below, so the candidate is withheld exactly as
  // the null answer would have withheld him. The explicit return is the readable form of
  // an answer arithmetic would reach anyway.
  if (adp == null || !Number.isFinite(adp) || adp < 0 || teams < 1) return null;
  // The floor's `1` also survives, and equivalently: it can only bind for an ADP under
  // one, whose unfloored round is zero or less, and `currentRound >= 0` is true at every
  // round a draft has. It is here so the two sides of the comparison are the same kind
  // of number — rounds are 1-based on our side of it — not to change an answer.
  return Math.max(1, Math.ceil(adp / teams));
}

/**
 * The shortlist entries the streamable-position discipline leaves standing.
 *
 * The NFL adapter applies this to positions the weekly model does not project: kicker and
 * defence. This is deliberately separate from `wireCover`. League-aware coverage can reach
 * one for quarterback in a shallow 1-QB league, but the model still projects quarterbacks;
 * extending K/D-ST discipline to them would conflate valuation with projection provenance.
 *
 *  - **The reserve cap.** With one already on the roster, a second is withheld. Pricing
 *    puts him at zero, which orders him last among candidates worth something and says
 *    nothing at all about a late round where everything is worth zero and the residual
 *    key is raw projection. The cap is what makes "at most one" true rather than likely.
 *  - **The market-round rule.** A candidate is withheld until the draft is within
 *    `STREAMABLE_MARKET_LEAD_ROUNDS` of *his own* market round. This is the half pricing
 *    cannot reach at all: the first kicker is a starter, his starting gain is real, and
 *    nothing in a myopic best-available prefilter knows that the same gain is available
 *    six rounds later. The market knows, and for these two positions the market is the
 *    only source there is — `docs/draft-validation.md`: the model does not project either,
 *    their entire price is the market's, and their weekly spread is still a placeholder.
 *    So a recommendation to take one six rounds early is the engine overruling the only
 *    price it has, using no information of its own.
 *
 * Three edges, deliberately matching `applyMarketGate`'s so the two gates read alike:
 *
 *  - **A state that cannot say which round it is gets the ungated list.** Both rules are
 *    about *when*, and there is no honest way to apply them to an unplaceable state.
 *  - **A candidate the board does not price has no market round**, and is withheld until
 *    the closing rounds. That is the same treatment the harness's check (d) gives an
 *    unpriced pick — priced behind the whole draft — rather than a separate convention.
 *  - **A discipline that would empty the shortlist yields.** A panel with no
 *    recommendation advises nothing, which is worse than advising with the caveat. On a
 *    real board hundreds of skill players are offerable and this never fires.
 *
 * Not applied to the base policy, the opponent completions, or our own rollout — the same
 * boundary `applyMarketGate` draws, and for the same reason: the outcome being steered
 * toward is the base policy taking the kicker *later*, at his market round, and a rollout
 * that could not take one at all would be a different measurement rather than a
 * discipline on the advice.
 */
export function applyStreamableDiscipline<T extends { player: PlayerRisk }>(
  scored: readonly T[],
  context: StreamableContext,
): readonly T[] {
  const { currentRound, teams, rounds, roster, unprojectedPositions } = context;
  if (currentRound === null) return scored;
  // The closing rounds are exempt outright, so the whole filter is skipped there rather
  // than tested per candidate.
  if (currentRound >= rounds - STREAMABLE_CLOSING_ROUNDS + 1) return scored;
  const held = new Set(roster.map((player) => player.position));
  const kept = scored.filter((entry) => {
    const position = entry.player.position;
    if (!unprojectedPositions.has(position)) return true;
    if (held.has(position)) return false;
    const marketRound = marketRoundOf(entry.player, teams);
    if (marketRound === null) return false;
    // The subtraction survives as an addition, and it is an equivalence *because the
    // lead is currently zero* rather than because the arithmetic does not matter — the
    // one kind of survivor worth naming, since it stops being equivalent the moment
    // somebody edits the constant. `mock.test.ts` pins the constant's value, so that
    // edit cannot land quietly.
    return currentRound >= marketRound - STREAMABLE_MARKET_LEAD_ROUNDS;
  });
  return kept.length > 0 ? kept : scored;
}

/**
 * The shortlist entries left standing once the engine is stopped from outbidding itself.
 *
 * #89.A, and the finding states its own remedy: "a recommendation whose player loses his
 * starting job to the *next round's recommendation at the same position* is a wasted pick
 * by the engine's own lineup solver". The audit's pair was Goff at 10.06 and Nix at
 * 11.05; the deterministic replay produced Kraft then Kittle then Parkinson at tight end
 * and Bryce Young then Brissett at quarterback. Every one of them is the same shape: the
 * later pick is the better player at a position the earlier pick had just filled, so the
 * earlier pick is spent and benched by the engine's own next recommendation.
 *
 * The rule: **a candidate is withheld while our roster holds a player at his position he
 * outranks**, ranked on `marketValue` — points times availability, the key the lineup
 * solver and the replacement model both rank by.
 *
 * ## Why this is not simply refusing a player who fell
 *
 * He is on the board now, and a draft only removes players from it, so he was on the
 * board at every turn we have already taken — including the one where we took the lesser
 * player at his own position. We had him in front of us and preferred the other one.
 * Nothing since is information about *him*: the opponents' picks only shrink the board,
 * and our own roster gained the player he is now redundant with, which lowers his
 * marginal worth rather than raising it. So preferring him now is the estimator changing
 * its mind rather than a fact arriving — and this fires exactly where #89.C measured the
 * estimator to be saturated, with every candidate's title odds inside a standard error of
 * every other's.
 *
 * ## What it costs, stated rather than implied
 *
 * The argument above is strong and is not a proof, in two places, and both are real:
 *
 *  - **Higher `marketValue` at a position does not provably mean the prefilter would have
 *    ranked him higher.** `coverValue` reads availability and bye separately, so two
 *    players with the same key are not interchangeable — `contendersFor` measured 20 of
 *    1806 adjacent same-position pairs ranking the lower-key player higher. In those the
 *    rule withholds a candidate we would not in fact have passed on, and the panel offers
 *    the next one instead.
 *  - **A roster we did not choose makes "we passed on him" false.** A user who overrules
 *    the panel, or a draft joined in progress, leaves players on the roster the engine
 *    never preferred anything to. The discipline still applies, because the alternative is
 *    a rule that reads the panel's own history and cannot be computed from the state.
 *
 * The stand-down below bounds both: a discipline that would empty the shortlist yields.
 *
 * ## Where it switches on
 *
 * Only once we hold as many at the position as the league *dedicates* starting slots to
 * it — two backs and two receivers in a two-flex league, one tight end, one quarterback,
 * one kicker, one defence. Below that count the lineup still has a hole at the position
 * and an upgrade is filling it, so the rule stays out of the way. At it and past it every
 * further body is depth or a flex contest, and an upgrade to that is exactly the wasted
 * pick #89.A names.
 *
 * Counted from the template, not from the lineup as it currently solves: the latter is
 * `startingSlotsByPosition`, which measures how many slots a roster's *own* hoarding has
 * already won at a position — so a rule against hoarding that read it would relax itself
 * every time it was disobeyed.
 *
 * The threshold is load-bearing and both settings were measured. One higher — firing only
 * once we hold *more* than the dedicated slots — the `--schedule-byes` replay took Josh
 * Jacobs at 2.06 and Kyren Williams, the better back, at 3.05: two dedicated back slots,
 * two backs held, and the rule silent for exactly the pair it exists to stop. At the
 * threshold as written, the same pair is refused. What made the lower threshold look
 * wrong first was a different case, and it has its own exemption below rather than a
 * looser rule: the frozen replay refused Kenneth Gainwell at 7.05, whom the prefilter
 * valued at eight times the rest of the board, and Gainwell is a player we had never been
 * offered.
 *
 * ## The one candidate we provably did not decline
 *
 * The market-discipline gate holds an unpriced player off the panel through
 * `MARKET_GATE_ROUNDS`, so for those rounds "he was in front of us and we took the other
 * one" is simply false about him. He is exempt inside that window. On the first turn past
 * it the gate no longer withholds him, but an upgrade that immediately benches the player
 * just drafted is still the exact waste this rule prevents; the replacement-consistency
 * replay exposed that boundary as Pollard 6.06 then Gainwell 7.05.
 *
 * The bound is not decoration. Exempting him outright was measured too, and it reopened
 * the very churn this rule exists to stop: the frozen replay took Hunter Henry at 11.05
 * and Colby Parkinson — no ADP, four rounds after the gate lifted, and the better player
 * — at 12.06.
 *
 * ## Order-free on purpose
 *
 * "The player we took last turn" would be the narrower rule and is not available:
 * `canonicalizeState` sorts every roster by id before the policy sees it, so that two
 * paths to the same roster share a memo entry, and the array's order is therefore not the
 * draft's. This reads the roster as a set — which is exactly what canonicalization
 * guarantees is stable — so the memo key needs nothing added to stay correct.
 */
export function applyOutbidDiscipline<T extends { player: PlayerRisk }>(
  scored: readonly T[],
  /** The advised team's roster, read as a set: the order it arrives in is not the draft's. */
  roster: readonly PlayerRisk[],
  /** The league's starting slots, for the dedicated-slot count the rule switches on. */
  slots: readonly RosterSlot[],
  /**
   * The round being advised, for the market-absent exemption above. `null` — a state
   * that cannot say which round it is — exempts, which is the same direction every other
   * unplaceable case takes: refuse less.
   */
  currentRound: number | null,
): readonly T[] {
  if (roster.length === 0) return scored;
  const dedicated = dedicatedSlotsByPosition(slots);
  // Per position: how many we hold, and the weakest of them. The weakest is the bar,
  // not the strongest — the strongest would refuse every upgrade at a position we hold
  // anything at, which is a different and much blunter rule.
  const count = new Map<string, number>();
  const weakest = new Map<string, number>();
  for (const player of roster) {
    // Both accumulators report `??`-as-`||` survivors, and both are equivalences for the
    // same reason as above: the falsy value is the default. The `<` here reports a `<=`
    // survivor too, equivalently — keeping the later of two equal values stores the same
    // number, and the bar is a number rather than a player.
    count.set(player.position, (count.get(player.position) ?? 0) + 1);
    const value = marketValue(player);
    const held = weakest.get(player.position);
    if (held === undefined || value < held) weakest.set(player.position, value);
  }
  const kept = scored.filter((entry) => {
    const position = entry.player.position;
    // The `?? 0` default survives as `|| 0` and as `?? 1`, both equivalently: this is
    // read only for a position the roster holds somebody at — a position absent from the
    // map has no bar below either, so the filter keeps the candidate whichever number
    // the default is.
    const held = count.get(position) ?? 0;
    // Below what the position certainly starts, every body is still filling the lineup
    // and an upgrade is filling it better, so the rule stays out of the way. A position
    // with no dedicated slot at all — flex-only, in some templates — is therefore
    // constrained from its first body, which is the same rule with the same count.
    // The `?? 0` default here reports two survivors and both are equivalences: `|| 0`
    // agrees because zero is the falsy value, and `?? 1` because this line is only
    // reached with at least one held — a position absent from `count` has no bar below
    // either — so `held < 0` and `held < 1` can only disagree at a count of zero that
    // cannot occur here.
    if (held < (dedicated.get(position) ?? 0)) return true;
    // The candidate the gate is still withholding — see the docstring. The exemption ends
    // with the gate because the first newly-offerable upgrade can already bench the
    // position bought on the preceding turn.
    if (
      entry.player.adp == null &&
      (currentRound === null || currentRound <= MARKET_GATE_ROUNDS)
    ) {
      return true;
    }
    const bar = weakest.get(position);
    // Strictly greater: an exact tie is not an upgrade, and refusing it would turn two
    // interchangeable players into a rule about which arrived first.
    return bar === undefined || marketValue(entry.player) <= bar;
  });
  // The same stand-down the other two gates apply: a panel with nothing on it advises
  // nothing, which is worse than advising with the caveat.
  return kept.length > 0 ? kept : scored;
}

/**
 * How many starting slots at each position accept nothing else.
 *
 * The count of slots this position is *certainly* buying, as opposed to contesting: a
 * two-flex league dedicates two slots to backs and one to tight ends, and the flexible
 * slots belong to whoever wins them. Counted from the template rather than from the
 * lineup as it currently solves, deliberately — `startingSlotsByPosition` measures what
 * a roster's own hoarding has already achieved, and a rule against hoarding that reads
 * it would widen every time it was disobeyed.
 */
function dedicatedSlotsByPosition(
  slots: readonly RosterSlot[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const slot of slots) {
    if (slot.eligiblePositions.length !== 1) continue;
    const position = slot.eligiblePositions[0];
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  return counts;
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
 * **Two per position in each regime, not one — and this is a heuristic, not a proof.**
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
  type ContenderPair = { best: PlayerRisk; alternative: PlayerRisk | null };
  const bestStarters = new Map<string, ContenderPair>();
  const bestReserves = new Map<string, ContenderPair>();
  for (const candidate of available) {
    // A position with no threshold has no slot anybody could take, so every candidate at it
    // is a reserve. `Infinity` says that without a special case.
    const threshold = startThreshold.get(candidate.position) ?? Infinity;
    const bucket = marketValue(candidate) > threshold ? bestStarters : bestReserves;
    const held = bucket.get(candidate.position);
    // The documented pair used to arise accidentally as one starter and one reserve. At
    // a zero-cover position with an open slot every candidate is a starter, which collapsed
    // the pair to one and discarded the durability/bye alternative it exists to preserve.
    if (held === undefined) {
      bucket.set(candidate.position, { best: candidate, alternative: null });
    } else if (marketValue(candidate) > marketValue(held.best)) {
      bucket.set(candidate.position, { best: candidate, alternative: held.best });
    } else if (
      held.alternative === null ||
      marketValue(candidate) > marketValue(held.alternative)
    ) {
      bucket.set(candidate.position, { best: held.best, alternative: candidate });
    }
  }
  return available.filter(
    (candidate) => {
      const starters = bestStarters.get(candidate.position);
      const reserves = bestReserves.get(candidate.position);
      return (
        starters?.best === candidate ||
        starters?.alternative === candidate ||
        reserves?.best === candidate ||
        reserves?.alternative === candidate
      );
    },
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
 * They all carry the same wire-covered value, which is an approximation and a deliberate
 * one. Taking one replacement-level player leaves the next one very slightly worse, and
 * modelling that would make replacement a curve rather than a level. The covered value is
 * the raw level times the league's existing wire share: zero-cover positions leave a real
 * empty slot, matching the objective, while fully streamable positions keep full replacement.
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
        // A remaining player is not automatically a free weekly signing. The raw level
        // still prices depth; only the share the wire can actually supply may occupy an
        // otherwise-empty slot in this baseline.
        projectedPoints: level.lineupValue,
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
  // The same baseline must govern an open starter and an absent starter. Using the raw
  // best-remaining value here would restore the inconsistency the lineup baseline just
  // removed: at wire cover zero a WR hole would be worth zero in `startingGain`, but a WR
  // absence would still be backfilled by the whole hypothetical replacement.
  // `replacement` is built from this same available board, so every candidate has an entry;
  // the fallback only keeps the helper total for defensive callers. Its only falsy value is
  // zero, making `??` and `||` deliberately equivalent here.
  const replacementValue = replacement.get(candidate.position)?.lineupValue ?? 0;
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
    // Absent reads as zero — the wire covers nothing at a position nobody described.
    // `??` rather than `||`, and they differ on the value that matters most: a share of
    // zero is "the wire covers nothing here", and `||` would send it to the same default
    // an absent position gets, which happens to be zero today and would stop being the
    // day the default changes.
    context.wireCover.get(candidate.position) ?? 0,
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
  wireCover: ReadonlyMap<string, number>,
): ReadonlyMap<string, ReplacementLevel> {
  return replacementLevels(
    leagueUnfilledSlots,
    available.map((player) => ({
      position: player.position,
      value: marketValue(player),
    })),
    wireCover,
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
  /** See `PolicyLeague.wireCover`. Threaded through so it is read once per pick. */
  wireCover: ReadonlyMap<string, number>;
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
  const { slots, weeks, wireCover } = league;
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
    wireCover,
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
  const replacement = replacementFor(available, leagueUnfilledSlots, league.wireCover);
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
  const replacement = replacementFor(available, leagueUnfilledSlots, league.wireCover);
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
  const league: PolicyLeague = {
    slots: config.slots,
    weeks: config.weeks,
    wireCover: config.wireCover,
  };
  const leagueUnfilled = state.teams.flatMap((team) =>
    ownUnfilledSlots(team.roster, config.slots),
  );
  // Two gates stand between the scoring and the shortlist, and only here: the base
  // policy, the opponent completions, and our own rollout all stay ungated. Gating them
  // would change what every simulated roster looks like — a different measurement, not a
  // discipline on the advice — and the base policy taking a withheld player *later, at
  // his value* is exactly the outcome both gates steer toward. Filtered before the slice,
  // so a gate promotes the next offerable candidate into the field rather than shortening
  // it.
  //
  // Three of them, and the order does not change the result — they are filters over one
  // list, and each yields whole rather than partially when it would empty the panel, so
  // the only thing composition order could change is which one gets to stand down. They
  // are written widest first: the market gate applies to every position inside the
  // audited window, the streamable rules to the two positions the model does not project,
  // and the outbid rule to one position at one turn.
  const scored = scoreCandidates(me.roster, state.available, league, leagueUnfilled);
  const round = currentRoundOf(state);
  const gated = applyOutbidDiscipline(
    applyStreamableDiscipline(applyMarketGate(scored, round), {
      currentRound: round,
      teams: state.teams.length,
      rounds: state.rosterSize,
      roster: me.roster,
      unprojectedPositions: config.unprojectedPositions,
    }),
    me.roster,
    config.slots,
    round,
  );
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
  // Once a gate withholds someone, it stops being: the base policy still takes the player
  // the panel refuses to name, so every displayed delta would be measured against a row
  // the user cannot see, cannot take, and is not told about. The panel labels this figure
  // "title odds vs. best available", and best available has to mean the best thing on
  // offer.
  //
  // So where a gate withheld a candidate, the baseline is the best *offerable* one —
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
