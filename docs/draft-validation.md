# Draft valuation — what was measured

The sole authority for any claim the draft board makes about ranking players. Reproduce it
all with `pnpm draft-backtest`.

The headline is negative, and it shaped the design.

## Our model does not beat the market, and the blend does not either

Held-out 2024, over the 151 players with both a market price and two prior seasons of
production:

| Method | Spearman vs actual 2024 points | Mean actual points, top 24 | top 48 |
| --- | --- | --- | --- |
| **Market (ADP)** | **0.5402** | 267.4 | **243.5** |
| Our season model | 0.4434 | 244.5 | 217.9 |
| Blend, weight 0.2 | 0.5364 | **272.6** | 238.3 |

Read this plainly:

- **The market ranks players far better than our model does** — 0.5402 against 0.4434.
  That gap is not close.
- **Blending our model in made rank correlation slightly worse**, not better: 0.5364
  against 0.5402, a 0.7% decline. The improvement seen on the tuning season did not
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
| 0 | 0.5578 |
| 0.1 | 0.5674 |
| **0.2** | **0.5739** |
| 0.3 | 0.5671 |
| 0.5 | 0.5579 |
| 1 | 0.5151 |

The model keeps a small weight for a reason that does not depend on beating the market:
**it prices players the market has not.** Around two thirds of rostered skill players have
no published ADP at all, and for those the model is the only estimate there is.

### An earlier version of this document was wrong

It reported the blend beating the market by 13.5%, from a weight of 0.5. That result came
from fitting a single ADP-to-points curve across all positions pooled. Pooling is
mis-specified: quarterbacks score far more raw points than running backs drafted at the
same slot, so a pooled curve reads every quarterback as wildly overvalued. Correcting it to
one curve per position raised the market's own score from 0.4455 to 0.5402 — and took most
of our model's apparent value with it.

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

  Worse than unmeasured, one failure is *known*. The recommendation compares taking a
  player now against waiting until your **next** pick only. That is the standard "value
  over next available" argument and it is sound early, when positions genuinely run out
  between your turns. It degrades late: once every position is abundant, waiting appears
  free everywhere, every score collapses toward zero, and the ordering is decided by
  whatever is largest in absolute terms. A simulated fourteen-round draft finished with a
  starting slot unfilled rather than taking the obvious replacement-level player for it.

  The fix is to score the completed roster rather than a single pick. A greedy completion
  was tried and is not a correct approximation — it inverted the recommendation on a case
  the unit tests pin, so it was not shipped. Until this is solved, **treat the ordering as
  advice about scarcity in the early and middle rounds, and check your own empty slots
  late.** The board shows them.
- **`BENCH_VALUE_WEIGHT` (0.1) and `AVAILABILITY_FLOOR` (0.5) are judgement, not
  measurement.** Both are documented as such where they are defined.
- **Kickers and defences are not valued**, because the model does not project them. They
  are absent from the board rather than carrying a fabricated number.
- **2025 and 2026 are not evaluated.** Fantasy Football Calculator publishes no 2025 board,
  so 2024 is the most recent season with both a market price and a finished result.

## The objective, and what is guaranteed about maximising it

Everything above measures *player ranking*, which is an input. The thing the draft
maximises is now the probability of winning the league, computed by playing the season out
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
- **Certified improvement.** The recommendation is one step of policy improvement over an
  explicit base policy: each candidate is evaluated by committing to it and finishing the
  draft under that base policy. By the policy improvement theorem the result is no worse
  than the base policy from any state. Not "usually better" — provably not worse.
- **Not guaranteed: global optimality.** A draft is a sequential game against opponents who
  react, over a state space exponential in the player pool. Claiming an optimal policy
  would be false. A perfect-information relaxation would give a computable upper bound on
  how much better any policy could do; it is **not implemented**, so the size of the gap is
  currently unknown.

### The estimate is noisy, and says so

A title is roughly a one-in-twelve event, so at the few hundred scenarios a draft clock
allows, the top candidates are frequently within sampling noise of each other — 16.7%
against 15.8% is not a real difference at n=300. Every recommendation carries its standard
error and a `tiedWithLeader` flag, and tied candidates are ordered by playoff probability,
which resolves at these sample sizes because it is roughly a coin flip rather than a rare
event. Presenting an unresolved ordering as decided would be exactly the false precision
this project exists to avoid.

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

### Cost

Measured on the real 2026 board, 12 teams, 15 rounds, a full roster of starters plus bench:

| Scenarios | Candidates | Time |
| --- | --- | --- |
| 150 | 10 | 0.56s |
| 300 | 10 | 0.97s |
| 600 | 10 | 1.9s |
| 1000 | 10 | 3.1s |

At 300 scenarios the leading candidates are usually tied within noise; at 600 the ordering
resolves. 600 is the sensible default given a draft clock of a minute or more.

Two optimisations got this from 7.8s. The rollout was completing all twelve teams for every
candidate while only ever reading our own — the other eleven come from the baseline, which
is computed once. And the base policy was re-solving the roster's own lineup for every one
of forty contenders at every remaining pick, when that value does not depend on the
contender.

**Not yet done for production:** this must run off the main thread, because a second of
synchronous work would freeze the interface. The natural fit is to compute speculatively
while opponents are on the clock — your next pick is known in advance, so the answer can be
ready before the turn arrives.

### League rules

**Handled.** Roster shape is arbitrary — any combination of slot kinds and counts, including
superflex — and the simulation uses it directly for every team. League size, playoff field,
bracket length and season length are all configuration. Kickers and defences are on the
board and draftable.

**Kickers and defences carry the market's price only.** The model does not project either
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

- **Memoisation** (`draft-memo.ts`) keys on a league fingerprint plus a state signature.
  The fingerprint covers slot eligibility — not just slot ids, because a hand-assembled
  `flex` that accepts quarterbacks is a different league — along with the playoff shape,
  season length, scenario count, injury model, and seed.
- **Speculation** (`draft-speculation.ts`) precomputes answers for the futures most likely
  to occur while opponents are on the clock. You know your pick *number* in advance but not
  the state at it, so there is no single answer to precompute; instead opponent picks are
  sampled from the same ADP dispersion the survival model uses, states are deduplicated,
  and the likeliest are solved in order until the budget runs out.

States are canonicalised before either cache sees them, because roster order is meaningless
in fantasy but determines the order random draws are consumed — so without it, the same
position computes differently depending on how it was assembled.

A cached answer is served **only on an exact signature match**, which is verified rather
than assumed. Anything else is `approximate` (and labelled, with what differs) or `miss`.
An approximation is never returned unless the caller explicitly asks for one.

Both contracts are mutation-tested. Removing roster canonicalisation, dropping the pool
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
- **Kickers and defences were priced off the pooled curve.** The market spells them `PK`
  and `DEF`; the lookups used `K` and `DST`, so no per-position curve was ever found. The
  pooled curve is the mis-specification this document already records as measurably wrong,
  and it was contaminated too, since those zero-scoring rows were in the fit.
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
  cycle may return anything. The leader is now established before sorting.
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

### Still unmodelled

Stated so their absence is visible: correlation between players (a quarterback and his own
receiver score together), waiver-wire replacement level (depth you could stream is worth
less than depth you must draft), and opponents who adapt their draft strategy rather than
following the base policy.

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
