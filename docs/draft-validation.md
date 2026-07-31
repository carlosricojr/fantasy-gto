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
