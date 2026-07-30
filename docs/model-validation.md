# Model Validation

This document records the backtest that every accuracy claim in the product must trace
back to. It exists because the original specification asserted the product would beat ESPN
projections by ≥8% MAE and deliver "+8.2 points/week", and neither number had any
computation behind it.

**Those claims are not achievable and have been removed.** The measured edge is roughly
1.3%, not 8%. What follows is how that was established.

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

| Parameter | Value | Meaning |
| --- | --- | --- |
| `alpha` | 0.15 | EMA smoothing on prior fantasy points. Low alpha = long memory. |
| `usageCap` | 0.2 | Maximum weight given to the usage-implied volume estimate. |
| `dvpWeight` | 0.25 | Weight on the shrunk opponent defense-vs-position factor. |
| `vegasWeight` | 0.25 | Weight on the Vegas adjustment. |
| `vegasMode` | `team` | Implied team total measured **relative to that team's own season average**. |

## Results — out-of-sample, 2025, n = 3,036 player-weeks

| Model | MAE | Edge vs FGTO |
| --- | --- | --- |
| **FGTO model (frozen)** | **5.9095** | — |
| Baseline: season-to-date mean | 5.9890 | FGTO is **1.33%** better |
| Baseline: last-3-game mean | 6.3625 | FGTO is 7.12% better |

The headline number the product may state is **1.33%**, measured against the strongest
baseline. The 7.12% figure against a last-3-game baseline is real but is not the honest
headline: quoting it while omitting the stronger baseline would be cherry-picking.

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
feature engineering on public box-score data closes that. A ~1.3% edge over a strong
baseline is a real but modest result, and it is the truthful characterization of this model.

The product's defensible value is therefore **not** projection supremacy. It is:

- **Optimal lineup assignment**, which is provable rather than statistical. Given any set of
  projections, the maximum-weight matching is optimal by construction and beats the greedy
  fill that naive tools use. See `lib/model/optimizer.ts`.
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
