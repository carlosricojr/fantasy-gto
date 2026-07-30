# Model Validation

This document records the backtest that every accuracy claim in the product must trace
back to. It exists because the original specification asserted the product would beat ESPN
projections by ≥8% MAE and deliver "+8.2 points/week", and neither number had any
computation behind it.

**Those claims are not achievable and have been removed.** The measured edge is roughly
2.6%, not 8%. What follows is how that was established.

## Method

Data: nflverse weekly player stats for 2023, 2024, and 2025 regular seasons, joined to
`games.csv` for schedule, Vegas lines, and venue. See `docs/data-sources.md`.

Target: PPR fantasy points for QB, RB, WR, and TE.

The baseline is the mean of **every prior game in the loaded history**, which spans up to
three seasons — not a season-to-date mean. It sees exactly the history the model sees;
restricting it to the current season would hand the model an unfair advantage early in the
year and inflate the reported edge.

Evaluation population: a player-week is scored only if the player has at least 4 prior
games and averaged at least 6.0 PPR points over their last 8. This restricts the metric to
genuinely rosterable players. Including deep-bench players with near-zero usage would
flatter every model equally and measure nothing useful.

Prediction uses only information available before kickoff: prior weeks for the player,
and the game's Vegas line and venue. There is no leakage of same-week production.

Defense-vs-position factors are always built from a **prior** season (2023 factors when
evaluating 2024; 2024 factors when evaluating 2025), never from the evaluation season.

Hyperparameters were selected on **2024**, then frozen and evaluated once on **2025**. The
2025 number is therefore a genuine out-of-sample estimate, not a tuned one.

## Frozen configuration

All values live in `lib/nfl/model/config.ts`.

| Parameter | Value | Meaning |
| --- | --- | --- |
| `EMA_ALPHA` | 0.15 | EMA smoothing on prior fantasy points. Low alpha = long memory. |
| `USAGE_WEIGHT_CAP` | 0.2 | Maximum weight given to the usage-implied volume estimate. |
| `DVP_WEIGHT` | 0.25 | Weight on the shrunk opponent defense-vs-position factor. |
| `VEGAS_WEIGHT` | 0.5 | Weight on the Vegas adjustment. |
| Vegas reference | team | Implied team total measured **relative to that team's own season average**. |
| `CALIBRATION` | 0.96–0.99 | Per-position bias correction, derived on 2024. |

## Results

Produced by `pnpm backtest`, which is the authoritative run. The 2024 row is in-sample
(hyperparameters were chosen there); only the 2025 row is a valid accuracy claim.

### 2025 — out-of-sample, n = 3,037 player-weeks

| Model | MAE | FGTO edge |
| --- | --- | --- |
| **FGTO model (frozen)** | **5.8324** | — |
| Baseline: mean of all prior games | 5.9877 | **+2.59%** |
| Baseline: last-3-game mean | 6.3618 | +8.32% |

Per position (MAE): QB 6.742, RB 5.816, WR 5.666, TE 5.245.

Residual bias is −0.627 points: the model still projects slightly high even after
calibration, because the evaluation population is selected for recent production and
regresses. This is disclosed rather than hidden, and it is why the interface leads with a
range rather than a single number.

### 2024 — in-sample, n = 2,963

MAE 5.8406 against a prior-games-mean baseline of 6.0009, a 2.67% edge. That this is nearly
identical to the out-of-sample figure is the useful signal here: the model is not
overfitted to its tuning season.

**The headline number the product may state is 2.59%**, measured against the strongest
baseline. The 8.32% figure against a last-3-game baseline is real, but quoting it while
omitting the stronger baseline would be cherry-picking.

### Correction: lookahead bias, found in review and removed

An earlier run of this backtest reported **2.29%**. That figure was contaminated.

The Vegas term compares a game's implied team total against the team's own norm. That norm
was being computed as the team's average implied total across the *entire season*,
including weeks after the one being projected — so a team's later form informed an earlier
projection. It was caught by a reviewer, confirmed against `scripts/backtest.ts`, and fixed
by `meanImpliedTotalBefore`, which averages only weeks strictly before the target.

Removing the leakage moved the result from 5.8507 to 5.8365, i.e. it got slightly
*better*. That is not paradoxical: with no prior week the reference falls back to the
league mean, which damps a weakly-helpful adjustment early in the season when it is least
informative. The point is that the current number is methodologically valid and the
previous one was not, regardless of which is larger.

The fix also changed what the Vegas reference contains, so `VEGAS_WEIGHT` was re-selected
on the tuning season: the corrected sweep prefers 0.5 over 0.25. That re-selection used
2024 only, leaving 2025 untouched, and produced the final **5.8324**.

A regression test in `project.test.ts` asserts that a later week cannot change an earlier
projection's baseline.

### Outcome quantiles

Every floor and ceiling shown in the interface is `mean × p10` and `mean × p90` from this
table. `pnpm backtest` prints it on the evaluation season, from the same predictions the
MAE table is built from, and `OUTCOME_QUANTILES` in `lib/nfl/model/config.ts` is copied
from that output.

| Position | n | p10 | p90 |
| --- | --- | --- | --- |
| QB | 560 | 0.170 | 1.759 |
| RB | 760 | 0.268 | 1.892 |
| WR | 1,216 | 0.185 | 1.802 |
| TE | 501 | 0.216 | 1.949 |

The spread is enormous — a tenth-percentile outcome is around a fifth of the projection and
a ninetieth-percentile outcome nearly double it. That is not a defect in the model; it is
the week-to-week variance of fantasy football.

K and DST carry `provenance: "placeholder"` in the same table. The model does not project
those positions, so there is no backtest behind their bands and the type says so.

### Reproducing the sweeps

`pnpm backtest -- --sweeps` re-runs every parameter sweep on the tuning season and prints
the table below. Every claim in this section comes from that command; none is asserted
from memory.

On the tuning season, holding the other parameters at their frozen values:

| Sweep | Result |
| --- | --- |
| EMA alpha | 0.05→5.8834, 0.10→5.8492, **0.15→5.8406**, 0.20→5.8503, 0.30→5.9126, 0.40→6.0048 |
| Usage cap | 0→5.8489, **0.2→5.8406**, 0.4→5.8408, 0.6→5.8473, 0.8→5.8583 |
| Vegas (team reference) | 0→5.8629, 0.25→5.8464, **0.5→5.8406**, 0.75→5.8478, 1→5.8672 |
| Vegas (league reference) | 0→5.8629, 0.25→5.8555, 0.5→5.8682, 0.75→5.8999, 1→5.9489 |
| Opponent weight | 0→5.8458, **0.25→5.8406**, 0.5→5.8416, 0.75→5.8475, 1→5.8590 |
| Calibration | **on→5.8406**, off→5.8821 |

Every row that sits at the frozen value reads 5.8406, because those runs *are* the frozen
configuration. An earlier revision of this table printed 5.8464 for the alpha and usage
rows — values carried over from before `VEGAS_WEIGHT` was re-selected — which made it
self-contradictory: two runs of one identical configuration reported different numbers.

Two things are worth reading off that table. The league-referenced Vegas sweep is
monotonically worse past its first step and never beats leaving the term out entirely,
while the team-referenced sweep has a genuine interior optimum. And calibration moves the
metric further than the usage, Vegas, and matchup terms combined.

### Implementation agreement

The model was prototyped in Python before being written in TypeScript. Run against the same
pipeline, the two agreed to 5.8512 versus 5.8507 — a difference of 0.0005 MAE, arising
because the TypeScript model recomputes every historical score through the configurable
scoring engine (with two-decimal quantisation) while the prototype read upstream's
precomputed PPR column. Agreement at that tolerance is what confirmed the port was
faithful.

Both of those figures predate the lookahead-bias fix described above, so they are a
statement about *port fidelity*, not about current accuracy. The current number is 5.8324.

## What the sweeps established

These are the findings that shaped the model, each measured rather than assumed.

**Long memory beats recency.** Sweeping alpha from 0.05 to 0.40 gives a clear optimum at
0.15, and a last-3-game baseline (6.36) is substantially *worse* than a mean over all prior
games (5.99). Weekly fantasy scoring is noisy enough that aggressive recency weighting discards
more signal than it captures. This contradicts the common intuition that "recent form"
should dominate.

**The Vegas reference matters more than the Vegas weight.** Measured against the *league*
average, the term never beats switching it off (5.8629 at weight 0) and degrades
monotonically after its first step, reaching 5.9489 at full weight. Measured against the
team's own prior weeks, it has a genuine interior optimum at 0.5 (5.8406). The cause of the
difference is double-counting: a player on a high-scoring offence already carries that
team's quality in their own scoring history, so scaling by team strength again applies it
twice. Only the game-specific deviation is new information.

**Usage and opponent adjustments are real but very small.** Against switching each off,
the usage cap is worth 0.0083 MAE and the opponent weight 0.0052; across their full sweep
ranges, 0.0177 and 0.0184. They are retained because they are directionally sound and
improve explainability, not because they move the metric. Calibration, at 0.0415, is worth
more than both combined — which is the honest ordering of what actually matters here.

## Honest interpretation

Weekly fantasy football scoring is dominated by irreducible variance. An MAE near 5.9
points against a mean around 12 means the error is roughly half the signal, and no amount of
feature engineering on public box-score data closes that. A ~2.5% edge over a strong
baseline is a real but modest result, and it is the truthful characterization of this model.

The product's defensible value is therefore **not** projection supremacy. It is:

- **Optimal lineup assignment**, which is provable rather than statistical. Given any set of
  projections, the maximum-weight matching is optimal by construction and beats the greedy
  fill that naive tools use. See `lib/core/optimizer.ts`.
- **Explainability** — every projection decomposes into named contributions that sum to the
  mean, so a user can see *why*.
- **Calibrated floor and ceiling**, supporting variance-aware decisions.

## Reproducing

The backtest is implemented as a checked-in script and run against real downloaded data:

```bash
pnpm backtest
```

Any change to the model must re-run this and update the table above in the same commit. A
claim that is not in this table may not appear in the UI. See the honesty ledger in
`README.md`.
