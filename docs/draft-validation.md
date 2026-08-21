# Draft valuation — what was measured

The sole authority for any claim the draft board makes about ranking players.

Not all of it comes from one command, and saying so matters: a reader who runs
`pnpm draft-backtest`, finds no timing table, and reads that as drift has been misled by
this page rather than by the code.

- `pnpm draft-backtest` writes `published-draft-metrics.json` and reproduces the Spearman
  table, the top-24 and top-48 means, the blend-weight sweep, the sample size, and the edge
  against the market. `lib/nfl/draft/published-metrics.test.ts` fails if this document and
  that file disagree.
- The timing table, the variance and league-dependence measurements, and the
  order-independence figure come from the simulation and are pinned by `pnpm test` — each
  is named where it appears.
- The rookie-versus-veteran split was measured once, on an earlier universe and an earlier
  estimator, and is left as measured rather than restated. The paragraph beneath it says
  why.

The headline is negative, and it shaped the design.

## Our model does not beat the market, and the blend does not either

Held-out 2024, over the 151 players with both a market price and at least one prior game
in the two preceding seasons:

| Method | Spearman vs actual 2024 points | Mean actual points, top 24 | top 48 |
| --- | --- | --- | --- |
| **Market (ADP)** | **0.5403** | 267.4 | **243.5** |
| Our season model | 0.4433 | 244.5 | 217.9 |
| Blend, weight 0.2 | 0.5364 | **272.6** | 238.3 |

Read this plainly:

- **The market ranks players far better than our model does** — 0.5403 against 0.4433.
  That gap is not close.
- **Blending our model in made rank correlation slightly worse**, not better: 0.5364
  against 0.5403, a 0.72% decline. The improvement seen on the tuning season did not
  replicate.
- The blend's top 24 did score more (272.6 against 267.4), so the two metrics disagree.
  One evaluation season of 151 players cannot settle a disagreement that small.

**No ranking edge over the market is claimed anywhere in the interface, because none was
measured.** A draft tool that told you it knew better than average draft position would be
repeating the "+8.2 points/week" claim this project deleted.

### Why the weight is 0.2 and not 0

Chosen on the 2023 tuning season, where 0.2 was the best of the values swept, then frozen
before 2024 was looked at. Out-of-sample it did not replicate, and the honest response to
that is to report it rather than to re-tune — re-tuning against the evaluation season is
exactly what makes a published figure meaningless.

| Blend weight (0 = market only, 1 = model only) | Spearman, 2023 |
| --- | --- |
| 0 | 0.5579 |
| 0.1 | 0.5676 |
| **0.2** | **0.5741** |
| 0.3 | 0.5673 |
| 0.4 | 0.5658 |
| 0.5 | 0.5579 |
| 0.6 | 0.5520 |
| 0.8 | 0.5371 |
| 1 | 0.5151 |

Every weight in `BLEND_WEIGHTS` is listed, not a selection of them. That matters because
the text calls 0.2 the best of the values swept: an abridged table would invite the reader
to check a sweep that is not the one the script runs. Three were missing here once, and
these figures were also left stale by the tie correction below, which for a while updated
only the evaluation table.

The model keeps a small weight for a reason that does not depend on beating the market:
**it prices players the market has not.** Around two thirds of rostered skill players have
no published ADP at all, and for those the model is the only estimate there is.

### An earlier version of this document was wrong

It reported the blend beating the market by 13.5%, from a weight of 0.5. That result came
from fitting a single ADP-to-points curve across all positions pooled. Pooling is
mis-specified: quarterbacks score far more raw points than running backs drafted at the
same slot, so a pooled curve reads every quarterback as wildly overvalued. Correcting it to
one curve per position raised the market's own score from 0.4455 to roughly 0.54 — and took
most of our model's apparent value with it. (That 0.4455 was measured before the tie
correction below, so the two ends of the comparison are not on exactly the same estimator.
The size of the effect is the point and it is unaffected.)

The lesson is recorded rather than quietly fixed: **most of the edge was an artefact of
handicapping the baseline.**

## Method

- **Universe.** Players with a published ADP *and* at least one prior game. Restricting to
  the market's board is deliberate — scoring against the whole league would flatter the
  model, because separating starters from practice-squad players is easy.
- **Our model.** Exponentially weighted per-game points over the prior two seasons
  (α = 0.15, matching the weekly model), times expected games, which ramps from half a
  season to a full one with prior-season availability.
- **The market.** ADP converted to implied points by a least-squares fit on log(ADP),
  **one curve per position**, fitted on a season already finished — 2022 for the tuning
  run, 2023 for the evaluation run. Fitting on the season being projected would be reading
  the answers. Positions with fewer than 8 players fall back to a pooled curve.
- **Metric.** Spearman rank correlation against actual season PPR points, plus mean actual
  points of each method's top 24 and 48. Rank correlation is right for a draft: nobody
  cares whether a projection said 240 or 260, they care who to take first.
- **Scoring.** PPR, 12-team. ADP is league-size specific.

## What is *not* measured

- **The pick recommendations have never been backtested, and have a known planning
  flaw.** Everything above is about ranking players. Whether following the recommendations
  produces a better final roster than following ADP is not something this repository has
  measured. Doing it honestly needs simulated opponents, and a simulation that assumed
  opponents draft by ADP would largely be marking its own homework.

  This paragraph used to describe a *known* planning flaw: that the recommendation compared
  taking a player now against waiting until your next pick only, so late in a draft — once
  every position is abundant — waiting looked free everywhere and a simulated season
  finished with a starting slot unfilled. That was true of the value-over-next-available
  engine, which no longer exists. `recommendByChampionship` scores the **completed** roster
  by playing the season out, which is precisely the fix that paragraph said had not been
  made, and the unfilled-slot case is now a test.

  What remains is an approximation, and a smaller one. The completion is greedy: our own
  remaining picks and every opponent's are filled by `basePolicyPick`, best available by
  value over replacement, rather than by anything that looks ahead. Opponents who draft
  differently from that produce a different board than the one each candidate was scored
  against. That is a reason the *magnitudes* are soft; it is not a reason to distrust the
  late rounds specifically, which is what this section used to say.
- **`AVAILABILITY_FLOOR` (0.5) is judgement, not measurement.** It is documented as such
  where it is defined. `BENCH_VALUE_WEIGHT` was too, and no longer exists — the objective
  that needed a bench discount was replaced by one that values depth by playing the season
  out, which is the whole reason it could be deleted.
- **Kickers and defenses are not projected by the model**, so they carry the market's price
  alone rather than a fabricated number. They *are* on the board and draftable — see
  "League rules" below. Leaving them off entirely was the previous behavior and it made
  the tool unusable for any league that starts one.
- **2025 and 2026 are not evaluated.** Fantasy Football Calculator publishes no 2025 board,
  so 2024 is the most recent season with both a market price and a finished result.

### The rank correlation was order-dependent until 2026-08-02

`spearman` assigned every player a distinct rank by sort position and used the
`1 - 6·Σd²/(n(n²−1))` shortcut, which is only valid when nothing is tied. Ties are routine
here — `seasonProjection`, `adpImpliedPoints` and `blendedSeasonValue` all round to two
decimals, so players share values — and tied players were given different ranks decided by
the order rows came out of a CSV.

Corrected to mid-ranks with Pearson correlation on the ranks, which agrees exactly with the
shortcut when there are no ties. Two of the three correlations moved, which is the proof
there were ties: the market from 0.5402 to 0.5403 and our model from 0.4434 to 0.4433. The
blend is unchanged at 0.5364 to four decimals, and the decline against the market moved
from 0.70% to 0.72% — it is a ratio of the two figures that did move.

The movement is small and it does not change any conclusion. It is recorded because the
figures above are the authority for what this product may claim, and a number that depends
on input order is not one.

## The objective, and what is guaranteed about maximizing it

Everything above measures *player ranking*, which is an input. The thing the draft
maximizes is now the probability of winning the league, computed by playing the season out
(`lib/core/season-sim.ts`).

That change removes the weighting problem rather than solving it. There is no constant
deciding what a bye collision is worth against a point of projection, or depth against a
starter: byes, injuries, weekly variance, the head-to-head schedule, and the actual
rosters your opponents have drafted all resolve into one number because the simulation
plays them out. **Opponents are observed, not assumed** — a draft board records every
team's picks, so by the middle rounds the league is largely known.

Two findings from that simulation that a points-based valuation cannot produce:

- **Weekly variance costs you wins even as an underdog.** "Underdogs want variance" holds
  in a single winner-take-all shot; a fourteen-week head-to-head season is the opposite
  regime. A matchup is won by out-scoring one opponent, so what pays is the *median* week,
  and right-skewed variance at a fixed mean lowers the median — measured at 2,000
  scenarios, identical expected points with the weekly median falling from 32.9 to 25.4
  and expected wins falling with it. Boom-or-bust players are worth less than their
  projection suggests.
- **The same roster has materially different title odds in different leagues.** Expected
  points identical, championship probability several times apart. No valuation that
  ignores opponents can express that.

### What is guaranteed

- **The inner problems are exact.** The best legal lineup for a week is a maximum-weight
  matching, solved exactly. Standings and the bracket are played out, not approximated.
- **One step of policy improvement, estimated by simulation.** The recommendation is one
  step of policy improvement over an explicit base policy: each candidate is evaluated by
  committing to it and finishing the draft under that base policy.

  What this is *not* is a proof. The policy improvement theorem needs the exact action
  values of the base policy, and these are Monte Carlo estimates over a finite number of
  scenarios — which is why every recommendation carries a standard error and why the
  interface marks candidates inside it as tied. Sampling noise can put a candidate on top
  whose true championship probability is below the base policy's own choice. This section
  previously said "provably not worse", which the estimates cannot support; the guarantee
  belongs to the theorem, not to this implementation of it.
- **Not guaranteed: global optimality.** A draft is a sequential game against opponents who
  react, over a state space exponential in the player pool. Claiming an optimal policy
  would be false. A perfect-information relaxation would give a computable upper bound on
  how much better any policy could do; it is **not implemented**, so the size of the gap is
  currently unknown.

### The estimate is noisy, and says so — in two different ways

A title is roughly a one-in-twelve event, so at the few hundred scenarios a draft clock
allows, the top candidates are frequently within sampling noise of each other — 16.7%
against 15.8% is not a real difference at n=300. Presenting an unresolved ordering as
decided would be exactly the false precision this project exists to avoid.

**Two uncertainties are reported, and they are not interchangeable.**

- **`standardError`** is `sqrt(p(1-p)/n)` on the candidate's own title probability. It says
  what "16.7%" is worth on its own.
- **`vsLeader`** is the uncertainty on the *comparison*. Every candidate is simulated over
  the same seasons — one seed, and each player drawing from a stream keyed on his own id —
  so the informative quantity is the scenario-by-scenario difference, not the difference of
  two separately estimated rates. `pairedOutcomeComparison` in `lib/core/stats.ts` summarizes
  it: how many scenarios each candidate won and the other did not, the mean difference, and a
  Student's-t interval on that mean.

  Adding two marginal standard errors is not the standard error of their difference under
  any circumstances, and that is what the tie flag used to do.

  It is **not** claimed that the paired error is always smaller. Positively correlated
  outcomes make it smaller — the usual case here, since two rosters differing by one player
  mostly win and lose the same seasons — but negatively correlated ones make it larger, and a
  sample can land either way. `stats.test.ts` contains a fixture where it is larger.

`tiedWithLeader` is now decided by whether zero lies inside that paired interval, and it is
a label rather than a sort key. The ranking descends by title odds — which is the paired
comparison's own point estimate, since pairing changes the variance and not the mean — and
what the pairing buys is the honest flag, not a different order. Tied candidates used to
be reordered by playoff probability, and the #88 audit showed the cost: the hidden key
promoted a 14.5% candidate into the leader card above a 16.2% runner-up. The mock-draft
harness's check (f) locks the fix — the displayed leader's title odds are never below a
displayed runner-up's. One visible consequence of flag-without-reorder: the tied rows need
not be contiguous. A near candidate the scenarios *do* separate can sit above a farther
one they cannot, so an unflagged row above a flagged one is the display working, not a
sorting error.

**The leader is selected from the same sample the intervals are computed on, so they are
descriptive rather than inferential.** No multiple-comparison correction is applied and no
comparison was predeclared. They describe what happened in these scenarios; they are not a
test of what would happen in new ones, and the type says so where it is defined.

### Rookies

A rookie has no prior games, so the model has no opinion about him. That was being passed
through the blend as a *zero*, which marked every rookie down by the model's full weight —
a market-300 rookie carried at 240. Absence now means absence on both sides: no history
gives the market alone, exactly as no market already gave the model alone.

**Whether to add college production was measured rather than assumed.** On the 2024 board,
matched to season results:

| Group | n | ADP Spearman vs actual |
| --- | --- | --- |
| Rookies (no 2022–23 snaps) | 24 | 0.2009 |
| Veterans | 144 | 0.4455 |

These two figures are **not** on the same basis as the headline table above. They were
measured over a 168-player universe, under the pooled ADP curve and the pre-tie `spearman`,
both since corrected. The universes differ because the join between the ADP board and the
roster changed — `buildMarketIndex` refuses a name it cannot separate by position, where
the hand-rolled map it replaced dropped both players — and not because of any difference in
how much history a player needed. Both require the same thing: at least one prior game.

The veteran figure of 0.4455 is the same number as the pooled curve's market score quoted
earlier. That is a coincidence of two different measurements landing on the same four
decimals, not one figure appearing twice.

They are left as measured rather than restated, because the argument they support is a gap
of 0.24 against a standard error of about 0.21 at n=24 — a difference no estimator change
of this size touches. Re-running them on the corrected basis would move the third decimal
and change nothing about the conclusion.

The market is visibly worse at *ordering* rookies. But it is well calibrated on their
*level*: rookies drafted 1–50 averaged 235.1 actual points against veterans' 235.6, and
50–100 gave 174.6 against 165.3. The crowd knows draft capital, which fixes the tier, and
cannot tell which rookie hits — which nobody can.

**No college data is loaded, deliberately.** Not because it carries no signal, but because
this repository could not honestly validate that it does. There are roughly two dozen
draftable rookies with a market price in a season; the standard error on a Spearman at
n=24 is about 0.21, so the gap above is not even statistically distinguishable from the
veteran figure. Tuning on one season and evaluating on another — the discipline every other
number here is held to — would leave two dozen players per evaluation season. Any result
would be noise dressed as a finding, and the honest move is to say so rather than to ship a
feature that cannot be checked.

The bar for revisiting: several seasons of rookie outcomes, a pre-registered metric, and a
measured improvement over ADP that survives out-of-sample. Draft capital is already in ADP,
so college production has to beat the crowd's reading of it, not merely correlate with
outcomes.

### Cost, and the budget derived from it

`pnpm draft-latency` prints the distribution with the environment it was measured in. A
displayed elapsed time is not a budget: it says how long one call took on one machine, tells
nobody what the tail looks like, and cannot fail.

```text
node v24.18.0, darwin arm64, Apple M4 Max x14, 36.0 GiB
board 614 players (DST 15, K 15, QB 81, RB 147, TE 124, WR 232)
12 teams, 15 rounds, seat 9, standard (9 starters), 10 candidates, seed 20260101
percentiles by nearest rank
```

| Scenarios | cold p50 | cold p95 | warm p95 | spec prepare p95 | spec hit p95 | spec miss p95 |
| --- | --- | --- | --- | --- | --- | --- |
| 150 | 632 ms | 665 ms | 1 ms | 2514 ms | 0 ms | 631 ms |
| 300 | 1202 ms | 1235 ms | 0 ms | 4809 ms | 0 ms | 1203 ms |
| 600 | 2350 ms | 2429 ms | 0 ms | 9523 ms | 0 ms | 2355 ms |
| 1000 | 3816 ms | 3949 ms | 0 ms | 15355 ms | 0 ms | 3916 ms |

Twelve samples per row except `prepare`, which is three — each of those solves four positions
from scratch. Every row prints its own `n`.

**The budget is the worst cold p95: 3949 ms at 1000 scenarios, against a two-minute pick
clock. That is 3.29% of the clock — a margin of 30×.** At the shipped default of 600 it is
2429 ms, or 2.02%. Read off the measurement rather than chosen before it, which is why the
row it comes from is in the table.

#### What the speculative rows say about whether to wire it

Preparing four futures costs **4.9× a cold computation**, which is what it should cost: it is
four of them. A wrong guess therefore does 19.3 seconds of work at 1000 scenarios where not
speculating does 3.9.

That is not the same as 19.3 seconds of waiting, and the distinction is the whole decision.
The preparation runs while an opponent is on the clock, so a *hit* takes the user's wait from
2.4 seconds to nothing and a *miss* leaves it exactly where it was — the fallback measures the
same as cold. From the user's side speculation is strictly better.

What it costs is the client's CPU, five times over, on a phone, and what it risks is
contention: preparation that has not finished when the turn arrives queues the fallback behind
itself, turning a 2.4-second wait into a longer one. That risk is not measured here and it is
the thing a production implementation would have to bound — by budget, by cancellation, or by
preparing fewer futures.

The board is synthetic and deterministic, sized and shaped like the real published one. A
benchmark that depended on a live provider would measure the provider, and one that depended
on a cached download would not run at all on a machine that has never fetched it.

An earlier version of this table read 0.56 / 0.97 / 1.9 / 3.1 seconds with no environment
recorded. Those were measured on different hardware and are not comparable to anything here.

At either count the leading candidates are usually tied within noise from the middle
rounds on — #89.C measured the top of the board statistically tied at 600 from round 2 of
a real league shape, and an earlier version of this paragraph claimed the opposite. The
ranking therefore descends by title odds with the unresolved gaps flagged rather than
re-ordered, and 600 is a draft-clock budget: more scenarios narrow the intervals but cost
seconds a pick does not have.

Two optimizations got the cold path from 7.8s. The rollout was completing all twelve teams
for every candidate while only ever reading our own — the other eleven come from the
baseline, which is computed once. And the base policy was re-solving the roster's own lineup
for every one of forty contenders at every remaining pick, when that value does not depend on
the contender.

#### What is wired, and what is not

**Wired.** The recommendation runs off the main thread in a Web Worker
(`app/(app)/draft/recommend.worker.ts`), so a second of synchronous work cannot freeze the
interface. It recomputes for the current board on every change, including while opponents are
on the clock, so the answer for a position is usually already there when the turn arrives.
Repeated states are served from an LRU memo keyed on the full league configuration
(`lib/core/draft-memo.ts`) — the `warm` row above. Replies are gated on request id and on a
league fingerprint (`app/(app)/draft/reply-gate.ts`), so neither an older board's answer nor
a previous scoring format's can replace a newer one.

**Not wired.** `lib/core/draft-speculation.ts` — precomputing answers for the *futures* a
board might reach while an opponent is picking, and serving one only on an exact signature
match — has no production caller. The `speculative hit` and `speculative miss` rows above are
measurements of the primitives, not of the product.

This section previously said otherwise: that "the board requests a recommendation
speculatively while opponents are on the clock" and "takes a precomputed answer only when the
board that arrives matches one of them exactly". The first half described the ordinary
recompute and the second described code nothing calls. Wiring it is #58, and the numbers
above are the reason it is not urgent: a 30× margin on the path that *is* wired.

### League rules

**Handled.** Roster shape is arbitrary — any combination of slot kinds and counts, including
superflex — and the simulation uses it directly for every team. League size, playoff field
and the week the final is played are all set on the setup screen, and the season's weeks
follow from the last two: `fantasySeasonWeeks` places the bracket immediately before the
championship week and gives the regular season everything ahead of it. Kickers and defenses
are on the board and draftable.

This section previously read "League size, playoff field, bracket length and season length
are all configuration", which was true of `LeagueConfig` and false of the product. The
interface offered no control for either and the board wrote out two literals — a fourteen-
week regular season and a three-week bracket in weeks 15 to 17 — for every league. Two
things followed, and neither announced itself:

- **A league that ends early was advised about a season it does not play.** Byes run
  through week 14, so under a week-17 final no bye can reach a playoff round at all. Move
  the final to week 15 and week 14 becomes the semi-final, which no surviving team sits out.
  On a synthetic twelve-team league — same roster, same seed, the star's bye week the only
  thing changed, and the streams keyed per player so the two runs draw identical numbers —
  a bye in a round you have to play takes **at least 30%** off the owner's championship
  probability, where the same bye in the regular season takes under 20%. Those two bounds
  are what `season-sim.test.ts` asserts and therefore all this document claims: the point
  estimates behind them are properties of one synthetic roster and are not published, and
  the relation is what survives changing it. The first round of a six-team bracket costs
  much less than a semi-final, because seeds one and two sit it out — also asserted, and
  also a thing no per-week weighting could express.
- **A four-team field got a bracket it does not play.** Two rounds were configured as three.
  `playBracket` consumes the bracket from the front and stops once the field is down to one,
  so with fourteen regular weeks and a bracket in 15-17 that field played rounds in weeks 15
  and 16 and never reached 17. Two things were wrong at once: week 15 was spent as a playoff
  round when it should have been the last week of the regular season, and week 17 — the week
  the league had named as its final — was not played at all. Deriving the bracket length from
  the field size makes that pair impossible to write down.

### What is guaranteed about a season that ends early

A fantasy season is a **proper prefix** of the NFL one. Finals are played in week 15, 16 or
17 and never 18, so there is always a tail of real NFL weeks the league does not score. That
was implicit while the board wrote out one hardcoded season and became load-bearing the
moment the final became a setting, because several modules now derive something from where a
league stops and a disagreement between any two of them is a wrong number rather than a
crash. It is therefore asserted as invariants rather than as examples.

Over a few hundred season shapes, well beyond the six the interface offers
(`season-sim.test.ts`):

- the two week lists **partition** weeks 1 to the final — no gap, no overlap, no repeat, in
  order. `sampleTeamWeeklyScores` concatenates them and `playBracket` indexes the result by
  position, so anything else scores the wrong week silently;
- the bracket is **exactly** `bracketRoundsRequired(playoffTeams)` long. Too few and
  `simulateLeague` refuses outright. Too many is quieter: the bracket is consumed from the
  front and `playBracket` stops once the field is down to one, so the last week the pair
  named is never reached — which is how a hand-written four-team bracket over weeks 15-17
  decided its title in week 16, left week 17 unplayed, and spent week 15 on a playoff round
  that should have closed the regular season;
- moving the final one week later slides every playoff round by one and adds exactly one
  regular-season week — the bracket **moves rigidly**, it does not resize;
- a larger field that needs another round takes that week from the regular season, and one
  that fits in the same number of rounds changes nothing.

Over every league the two controls can actually produce (`season-invariants.test.ts`), end
to end: it ends before the NFL season does and leaves week `championshipWeek + 1` onward
unplayed; every week it does play is a real NFL week; it round-trips through session storage;
a payload written before the setting existed restores at the default final of week 17, which
reproduces the old season exactly for a six-team field and deliberately does not for a
four-team one — the old pair gave that field a three-week bracket it does not play, so
restoring it unchanged would preserve the defect rather than the league; the sentence on
screen names week counts *equal* to the ones simulated rather than a golden string; no two
shapes share a recommendation memo key or a reply-gate fingerprint; and the regular season
handed to the depth model is contiguous from week 1.

That last one is not a precondition — `expectedAboveReplacement` tests each bye for
*membership* in the week list and works for any list at all. It is the premise of a claim
made in `draft-bench.ts`: that changing that argument from a count to a list left every
number identical, because `played.has(13)` rejects exactly the weeks `13 <= 12` rejected.
That equivalence holds only while the weeks run `1..n` from one. They do, and now something
fails if they ever stop, rather than the comment quietly becoming false.

And the conservation laws, for every shape: exactly one champion is crowned, exactly
`playoffTeams` berths are filled, no team's title rate exceeds its berth rate, and total wins
equal the games the league's own schedule holds. A season that quietly dropped a week, played
a round twice, or crowned nobody fails arithmetic rather than returning plausible odds.

Two consequences worth stating because they are easy to misread:

- **A bye after the final costs exactly nothing** — not approximately nothing. Each player's
  random stream is keyed on his own id and `simulateAvailability` consumes it identically
  whatever his bye is, so an out-of-season bye cannot perturb the draw at all. The test
  compares whole scenario tables rather than a probability, because a probability could agree
  by luck.
- **`TeamOutcome.expectedPoints` is regular-season points**, the seeding tiebreak, not the
  season total. So a bye in a playoff round leaves it untouched while changing who wins the
  title. That is correct for what it is for and the wrong quantity to reach for if the
  question is what a roster is worth over every week it plays. Nothing reports that today:
  `rosterUtility` sums whatever week list it is handed, and a `LeagueConfig` hands it the
  regular season alone, so reaching for it returns the same weeks all over again.

**Not handled: a two-week championship.** `playBracket` plays one round per week, so a
final decided on the combined score of two weeks cannot be expressed. Leagues that do this
should set the championship week to the *last* of the two; the bracket is then right and
the final is scored over one week instead of two.

**The prefilter prices byes over the regular season only.** `PolicyLeague.weeks` is the
regular season's weeks, so the depth model that narrows several hundred players to a
shortlist of ten does not see a bye that lands in a playoff round. The objective does, and
prices it exactly — but a reserve whose only worth is covering such a bye can be narrowed
out before the simulation ever values him. This binds on the two configurations where a
real NFL bye reaches a bracket at all: a final in week 15, and a final in week 16 with a
six-team field.

Passing the whole season instead was tried and is worse. The bye term is a per-week average
and `startingGain` is not, so lengthening the season from fourteen weeks to seventeen shrinks
depth against starter upgrades — and `completeDraft` began spending a late pick on a second
kicker in a league that starts one, which is the exact failure `coverValue` was written to
fix and which `draft-policy.test.ts` pins. Weighting playoff weeks by the chance of reaching
them would be one more tuned constant of the kind simulating to the terminal outcome exists
to remove. So the approximation is deliberate and recorded here rather than closed.

**Kickers and defenses carry the market's price only.** The model does not project either
and will not pretend to. They were previously left off the board entirely, which did not
make the tool cautious — it made it unusable for any league that starts one: the slot could
never be filled, every simulated roster carried a permanent hole, and a user following the
recommendations would finish the draft without a kicker. They are now valued exactly as a
rookie is, by the same rule: where the model is silent, the market's price stands alone.
Their weekly spread is the `placeholder` band in `OUTCOME_QUANTILES`, not a measured one.

**Not handled: custom scoring.** Only PPR, half-PPR, and standard are supported. This is a
harder limit than it looks, because it binds on both halves of the valuation at once — the
projection would need re-scoring, and the market half simply does not exist, since ADP is
only published for those three formats. A league with six-point passing touchdowns or a
tight-end premium is *approximated* by the nearest preset, and the interface should say so
rather than imply the board was built for it.

### Cost of repeated positions

A draft position is a pure input: the same board, rosters, rules and seed give the same
answer every time. Two caches exploit that, and both are built so that a wrong hit is
impossible rather than unlikely — a memo that answers quickly and incorrectly is worse than
no memo.

- **Memoization** (`draft-memo.ts`) keys on a league fingerprint plus a state signature.
  The fingerprint covers slot eligibility — not just slot ids, because a hand-assembled
  `flex` that accepts quarterbacks is a different league — along with the playoff shape,
  season length, scenario count, injury model, and seed.
- **Speculation** (`draft-speculation.ts`) precomputes answers for the futures most likely
  to occur while opponents are on the clock. You know your pick *number* in advance but not
  the state at it, so there is no single answer to precompute; instead opponent picks are
  sampled from the same ADP dispersion the survival model uses, states are deduplicated,
  and the likeliest are solved in order until the budget runs out.

States are canonicalized before either cache sees them, so that two ways of writing down
the same position produce the same signature and therefore the same cache key. It is a
hit-rate measure, not a correctness one: this paragraph used to say that roster order
determines the order random draws are consumed and so changes the result, which stopped
being true when each player got a stream keyed on his own id. Measured — the same roster
forwards, reversed and shuffled returns 560.2807 points every time — and now asserted, so
the claim fails rather than rots if the streams ever change.

A cached answer is served **only on an exact signature match**, which is verified rather
than assumed. Anything else is `approximate` (and labeled, with what differs) or `miss`.
An approximation is never returned unless the caller explicitly asks for one.

Both contracts are mutation-tested. Removing roster canonicalization, dropping the pool
digest from the signature, removing the hash separator, serving a near-miss as exact,
dropping the seed or scenario count from the fingerprint, and evicting by insertion rather
than by use each break at least one test. An earlier version of the superflex test passed
against a broken fingerprint — `buildSlots` happens to give a superflex a different slot
id, so id alone separated them — and was replaced with one that exercises the collision it
claimed to.

### Defects found and fixed in review

An adversarial sweep over the draft code found nine, four of which changed shipped numbers.
Recorded because several are the *same mistake in different clothes*, and the pattern is
worth more than the individual fixes.

- **Common random numbers were not working.** Draws came from one stream shared across a
  roster, so how much randomness a player consumed depended on how many players preceded
  him and whether they happened to be fit. Adding a candidate shifted everyone else's
  numbers, and two rosters being compared differed by far more than the player under test.
  Measured: a player projected at *zero* points scored between −8.4 and +12.7 depending
  only on the seed. Each player now has his own stream keyed on his id, and draws happen
  for every week regardless of availability — a worthless player now measures exactly 0.00
  at every seed.
- **Every veteran kicker was 20% below his market price.** `scoreOffense` scores a kicking
  line as zero, so kickers had history that produced a real zero rather than a null, and
  the blend marked them down by the model's full weight. This is the rookie markdown
  reappearing for a different population — the fix is that "does the model have an opinion"
  is a question about the position, not the row count.
- **Kickers and defenses were dragging the pooled curve down.** The market spells them
  `PK` and `DEF` while the lookups used `K` and `DST`, so no per-position curve was ever
  found for them — and, worse, their rows were in the pooled fit. `scoreOffense` scores a
  kicking line as zero, so that fit was being pulled toward false zeros for every other
  position that falls back to it.

  Only that half is fixed. They are excluded from the fit and no longer contaminate it, and
  they are still *priced* off the pooled curve, deliberately: a curve fitted from their own
  rows would be fitted from those same false zeros. The pooled curve remains the
  mis-specification this document records as measurably wrong, and for a position the model
  cannot value it is the honest treatment rather than a defect left standing.
- **Our own team won every tie.** The circle-method schedule holds team 0 fixed, so it
  occupied the home position in all fourteen weeks, and ties went to the home side. In a
  fully tied league that gave team 0 fourteen wins to everyone else's six — and, since
  seeding also broke ties by array position and our team is always index 0, a championship
  probability of exactly 1.0. Ties split now, and seeding breaks on a
  scenario-derived key uncorrelated with position.
- **A six-team bracket gave no first-round bye.** All six played, leaving three, and the
  bye then fell in round two on whoever survived — so the second seed got one only if the
  first seed lost. Byes now land in round one, reducing the field to a power of two.
- **A bracket with too few weeks crowned the highest remaining seed** without playing the
  deciding game, silently. Six qualifiers over two weeks named a different champion than
  the same six over three. It now refuses to run.
- **The recommendation comparator was intransitive.** "Within noise, prefer the smoother
  signal" is not a valid ordering: 12%, 14% and 16% give A~B, B~C, A<C. `Array.sort` on a
  cycle may return anything. First fixed by establishing the leader before sorting; the
  comparator is now a plain lexicographic descent on title odds, which cannot cycle, and
  the leader anchors only the tie flag.
- **The memo key omitted the shortlist length and the identity of the weeks.** Two leagues
  with playoffs in weeks 15-17 and 14-16 were both "3" and shared a memo, though a bye
  lands inside one and outside the other. An answer for three candidates could be served to
  a request for twelve.
- **A near-match could serve one manager's answer to another.** The approximate branch
  compared only whether its own recommendations were still available — true of an answer
  computed for a different team, a different roster size, or a different set of opponents.
  It now requires the position to match and reports what genuinely differs; previously the
  `differences` field was unreachable and always reported that nothing did.

Two tests were also passing for the wrong reason and were rewritten: one asserted Jensen's
inequality on a roster where every player started every week, so no truncation was possible
and it passed on the noise the CRN fix removed; another claimed to separate a superflex
league from a standard one but was satisfied by the slot *id* differing.

### What the base policy is

The completion that every candidate is scored through, and therefore the thing that decides
what a recommendation is worth. It is best-available, and what "best" means is two terms in
the same unit — points per week — added together.

- **What he adds to the starting lineup**, against a roster that can otherwise sign anybody
  replacement-level at any position. Solved by the lineup matcher, so FLEX and SUPERFLEX
  eligibility is handled by the code that already knows the rules.
- **What he adds in the weeks somebody is missing** (`lib/core/draft-bench.ts`). A position
  occupies some number of starting slots; a player is needed in the weeks fewer than that
  many of the players above him are available. Availabilities are per player, so a fragile
  starter raises his own backup's value, and byes are counted per week, so a backup sharing
  his starter's bye is worth less than one who does not.

Replacement level is solved rather than assumed (`lib/core/draft-replacement.ts`). Demand is
the starting slots the league has not filled *from the rosters it holds* — eleven of twelve
teams with a quarterback leaves one slot of demand, not twelve — and which positions fill
the flexible slots is a maximum-weight assignment against the board's own value curves, not
an equal share to each eligible position.

**Why this is written down at all:** the term it replaced was
`weeklyMean * availability * 1e-3`, a raw projection scaled small, and it ranked reserves by
position. A fifteen-round completion in a one-quarterback league came back holding seven
quarterbacks. The same call now returns two, and a SUPERFLEX league returns three.

### Still unmodeled

Stated so their absence is visible: correlation between players (a quarterback and his own
receiver score together), correlated absence (injuries cluster, which the season simulation
models and the base policy does not), cross-position cover in the depth model (a back covers
a FLEX a receiver vacates), and opponents who adapt their draft strategy rather than
following the base policy.

**Waiver-wire replacement level** used to be on that list and now has a crude term instead,
because the consequence stopped being hypothetical. Depth you could stream is worth less
than depth you must draft, and the gap is not the same at every position: a twelve-team
league rosters twelve kickers and around sixty backs, so the best undrafted kicker is nearly
as good as the best drafted one while the best undrafted back is nowhere near. Without that
term the depth model overstated reserves at shallow, streamable positions. Measured on a
synthetic twelve-team fixture: after fifteen rounds the best remaining kicker priced at
0.109 points a week against 0.022 for the best remaining skill reserve, so a sixteenth pick
would go on a backup kicker. The #88 audit then drafted two kickers, two defenses, five
tight ends and two wide receivers over sixteen rounds.

The existing **waiver-wire share** now governs both sides of the prefilter. In
`draft-replacement.ts`, the raw replacement remains the best player left after league demand,
but the hypothetical player seated into an otherwise-empty slot is worth only that raw value
times `wireCover`. `coverValue` uses the same covered level for an absent starter and scales
the drafted cover term by what remains. The table is `WAIVER_WIRE_COVER` in
`lib/nfl/roster.ts`, which is where it has to live: the argument for each entry names
positions, and `lib/core` may not. Kicker and defense are one, tight end is three quarters,
and back and receiver are zero. Quarterback's zero is fail-closed: product callers replace
it with `waiverWireCover`'s league-aware result.

**This is judgement, not measurement, and is marked as such** — the same status
`meanAbsenceWeeks` carries. What would settle it is the weekly value of the best free agent
at each position, which nothing here measures; the K/D-ST weekly spread is still the
`placeholder` band (#90.4). Quarterback is the measurable exception: one startable QB per
current NFL team, against demand from the fantasy league's actual QB-eligible slots.
Coverage is `min(1, (32 - demand) / demand)` — free startable bodies per demanded starter.
A 10-team 1-QB league derives **1.00**; SUPERFLEX/2QB derives **0.60**. All three producers
call the same function, and `wireCover` remains in the memo fingerprint.

The distinction between raw and covered replacement matters. League demand is still solved
against the real board, so the same players are consumed by FLEX and dedicated slots. What
changes is what can be obtained for free after that demand: at WR/RB the covered level is
zero, at K/D-ST it is the whole raw level, at TE it is three quarters, and at QB it is the
league-derived share. A drafted player's own starting value is still the lineup solver's
answer.

### Streamable-position discipline

`applyStreamableDiscipline` is keyed separately to positions the weekly model does not
project — K and D/ST — and applies two rules on the recommendation shortlist only. It does
not infer this policy from cover: a 1-QB league now has full QB cover while QB remains a
modeled position, so applying K/D-ST discipline there would conflate valuation with
projection provenance.

- **Not before the market's own round.** The model does not project kickers or defenses;
  their whole price is the market's and their spread is a placeholder, so an engine taking
  one ahead of the market is overruling the only price it has using no signal of its own.
  The permitted lead is zero rounds (`STREAMABLE_MARKET_LEAD_ROUNDS`), against a harness
  check that tolerates two.
- **Never a second before the closing rounds.** Pricing puts a second kicker at zero, which
  orders him last among candidates worth something and says nothing about a late round where
  everything is worth zero. The cap is what makes "at most one" true rather than likely.

`applyOutbidDiscipline` is the third rule and answers a different finding (#89.A): past the
starting slots a position dedicates, a candidate who outranks somebody already held there is
withheld, because he was on the board at the turn the lesser player was taken and nothing
since is information about him. A player the board does not price is exempt while the market
gate itself withholds him. The exemption ends when the gate lifts: otherwise the first
newly-offerable upgrade can immediately bench the position bought one turn earlier, which
the replacement-consistency replay exposed as Pollard 6.06 → Gainwell 7.05.

All three filter the shortlist and nothing else. The base policy, the opponents' completions
and our own rollout stay ungated, because the outcome being steered toward is the base policy
taking the kicker *later*, at his market round.

### Replacement consistency and playable rosters

PR #97 left a measured inconsistency: the objective scores an unfillable slot at zero, while
the prefilter seated the full best remaining player at every position even where
`WAIVER_WIRE_COVER` was zero. Once opponents had spent the league's receiver demand, that
made every late WR worth exactly zero over the best WR still on the board. Frozen mode ended
with three receivers and four quarterbacks; schedule-byes ended with two receivers and six
tight ends.

The reconciled prefilter uses the covered replacement described above in both its starting
lineup and absence terms. No roster-shape floor and no new parameter was added. Measured in
both harness modes, check (e) now passes with four receivers, while checks (a)–(d) and (f)
remain green.

The harness also carries the stronger check (g): for every configured regular-season and
playoff week, players on bye are removed and `solveLineup` must fill every starting slot.
The check adds hypothetical waiver players only at positions whose existing wire share is
positive; a zero-cover WR, RB, or QB hole cannot be hidden. This is the same exact matching
the objective uses and catches excess-at-one-position rosters that a WR count cannot,
including the four-QB and six-TE finishes above. Both replay modes pass. Check (e) is retained
as the narrower historical regression lock rather than retired.

### League-aware QB replacement

The seven-check harness still allowed three QBs in a 1-QB roster. With QB cover at zero,
replacement `lineupValue` was zero, so the prefilter compared QBs at roughly 255 raw points
against RB/WR replacement deltas around 170. At 2.06 its top eight candidates were QBs.

After the 1.00 derivation, frozen carries exactly one QB (Justin Herbert, 11.05, market round
11) and schedule-byes carries one (Bo Nix, 12.06, market round 12). Frozen changes from
`3 QB / 6 RB / 4 WR / 1 TE / 1 K / 1 D/ST` to `1 / 6 / 4 / 3 / 1 / 1`; schedule-byes
changes from `3 / 5 / 4 / 2 / 1 / 1` to `1 / 7 / 5 / 1 / 1 / 1`.

Checks (h) and (i) close the blind spot. (h) rejects a priced skill player more than six
rounds early: six is the smallest bound both corrected modes pass, while the old scheduled
replay failed at seven. (i) caps a position at its startable slots plus one reserve per
dedicated modeled starter and one shared reserve if it participates in FLEX. The latter is
measured by scheduled mode's seven RBs against four RB/FLEX starts; market-only K/D/ST get
no reserve. The former three-QB roster exceeds one QB start plus one reserve.

## The part that is provable

None of the above is what the draft board's value rests on. Two things it does are exact
rather than estimated, and neither requires beating the market at anything:

- **What a player adds to your roster** is the best legal lineup with him minus the best
  legal lineup without him — a maximum-weight bipartite matching, solved exactly by
  `lib/core/optimizer.ts`. Raw projection cannot express this: a 250-point quarterback is
  worth 250 to an empty roster and almost nothing to a roster that already has a better one.
- **What waiting costs** follows from ADP dispersion by direct computation. The expected
  best survivor at a position is `Σ value(i) × P(i survives) × Π(1 − P(j survives))` over
  better players `j` — an exact expectation, not a simulation.

ADP is one global ordering. It does not know your roster, your league's slots, or when you
pick next. **That gap is the entire product**, and it is why the measurement above being
negative does not undermine it.
