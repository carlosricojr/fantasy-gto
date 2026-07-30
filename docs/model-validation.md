# Model Validation

This document records the backtest that every accuracy claim in the product must trace
back to. It exists because the original specification asserted the product would beat ESPN
projections by ≥8% MAE and deliver "+8.2 points/week", and neither number had any
computation behind it.

**Those claims are not achievable and have been removed.** The measured edge is roughly
2.53%, not 8%. What follows is how that was established.

## Method

Data: nflverse weekly player stats for 2023, 2024, and 2025 regular seasons, joined to
`games.csv` for schedule, Vegas lines, and venue. See `docs/data-sources.md`.

Target: PPR fantasy points for QB, RB, WR, and TE.

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
| `VEGAS_WEIGHT` | 0.25 | Weight on the Vegas adjustment. |
| Vegas reference | team | Implied team total measured **relative to that team's own season average**. |
| `CALIBRATION` | 0.96–0.99 | Per-position bias correction, derived on 2024. |

## Results

Produced by `pnpm backtest`, which is the authoritative run. The 2024 row is in-sample
(hyperparameters were chosen there); only the 2025 row is a valid accuracy claim.

### 2025 — out-of-sample, n = 3,037 player-weeks

| Model | MAE | FGTO edge |
| --- | --- | --- |
| **FGTO model (frozen)** | **5.8365** | — |
| Baseline: season-to-date mean | 5.9877 | **+2.53%** |
| Baseline: last-3-game mean | 6.3618 | +8.26% |

Per position (MAE): QB 6.756, RB 5.821, WR 5.665, TE 5.250.

Residual bias is −0.595 points: the model still projects slightly high even after
calibration, because the evaluation population is selected for recent production and
regresses. This is disclosed rather than hidden, and it is why the interface leads with a
range rather than a single number.

### 2024 — in-sample, n = 2,963

MAE 5.8464 against a season-mean baseline of 6.0009, a 2.57% edge. That this is nearly
identical to the out-of-sample figure is the useful signal here: the model is not
overfitted to its tuning season.

**The headline number the product may state is 2.53%**, measured against the strongest
baseline. The 8.26% figure against a last-3-game baseline is real, but quoting it while
omitting the stronger baseline would be cherry-picking.

### Correction: lookahead bias, found in review and removed

An earlier run of this backtest reported **2.29%**. That figure was contaminated.

The Vegas term compares a game's implied team total against the team's own norm. That norm
was being computed as the team's average implied total across the *entire season*,
including weeks after the one being projected — so a team's later form informed an earlier
projection. It was caught by a reviewer, confirmed against `scripts/backtest.ts`, and fixed
by `meanImpliedTotalBefore`, which averages only weeks strictly before the target.

Removing the leakage moved the result from 5.8507 to **5.8365**, i.e. it got slightly
*better*. That is not paradoxical: with no prior week the reference falls back to the
league mean, which damps a weakly-helpful adjustment early in the season when it is least
informative. The point is that the current number is methodologically valid and the
previous one was not, regardless of which is larger.

A regression test in `project.test.ts` asserts that a later week cannot change an earlier
projection's baseline.

### The calibration step earns its place

Measured on the current (leakage-free) pipeline by setting every `CALIBRATION` factor to 1
and re-running:

| | MAE | Bias | vs season mean |
| --- | --- | --- | --- |
| Without calibration | 5.8946 | −0.873 | +1.56% |
| **With calibration** | **5.8365** | **−0.595** | **+2.53%** |

The factors were computed on 2024 and applied unchanged to 2025, so this is an
out-of-sample gain rather than a curve fit. It is also the single largest contributor to
the headline number — larger than the usage, Vegas, and matchup terms combined.

### Implementation agreement

The model was prototyped in Python before being written in TypeScript. Run against the same
pipeline, the two agreed to 5.8512 versus 5.8507 — a difference of 0.0005 MAE, arising
because the TypeScript model recomputes every historical score through the configurable
scoring engine (with two-decimal quantisation) while the prototype read upstream's
precomputed PPR column. Agreement at that tolerance is what confirmed the port was
faithful.

Both of those figures predate the lookahead-bias fix described above, so they are a
statement about *port fidelity*, not about current accuracy. The current number is 5.8365.

## What the sweeps established

These are the findings that shaped the model, each measured rather than assumed.

**Long memory beats recency.** Sweeping alpha from 0.05 to 0.40 produced a clear optimum at
0.15, and a last-3-game baseline (6.36) was substantially *worse* than a season-to-date mean
(5.99). Weekly fantasy scoring is noisy enough that aggressive recency weighting discards
more signal than it captures. This contradicts the common intuition that "recent form"
should dominate.

**League-relative Vegas actively hurts; team-relative Vegas helps slightly.** Scaling a
projection by the game's implied team total against the *league* average made the model
monotonically worse at every weight tested (5.915 → 6.098 as weight went 0 → 1). The cause
is double-counting: a player on a high-scoring offense already carries that team's quality
in their own scoring history, so multiplying by team strength again applies it twice.
Measuring the implied total against **that team's own season average** isolates the
game-specific signal, and at weight 0.25 it produces a small genuine gain. This is why
`vegasMode` is `team`.

**Usage and opponent adjustments are real but small.** Each contributes on the order of
0.1% or less. They are retained because they are directionally sound and improve
explainability, not because they move the metric much.

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
