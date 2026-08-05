# Model Validation

This document records the backtest that every accuracy claim in the product must trace
back to. It exists because the original specification asserted the product would beat ESPN
projections by ≥8% MAE and deliver "+8.2 points/week", and neither number had any
computation behind it.

**Those claims are not achievable and have been removed.** The measured edge is roughly
2.7%, not 8%. What follows is how that was established.

## Evaluation protocol

Three disjoint sets of seasons, named in `scripts/backtest.ts` rather than spelled as loop
literals so the split is greppable.

| Set | Seasons | What it is for |
| --- | --- | --- |
| Development | 2013–2021 | Free exploration. Iterate as much as you like. |
| Tuning | 2022–2024 | Hyperparameter selection only. |
| **Holdout** | **2025** | Evaluated **once per hypothesis**, at a pre-registered decision point. |

`pnpm backtest` scores development and tuning and **does not touch the holdout**. Scoring
2025 requires `pnpm backtest -- --holdout`, and that is also the only run that rewrites
`lib/nfl/model/published-metrics.json`. The guard is not ceremony: the most valuable
property this repository has is that the frozen configuration was chosen before 2025 was
ever looked at, and a default run that quietly scored it would spend that property on every
routine invocation.

**A hypothesis that fails is closed, not retuned.** Re-running the holdout to see whether a
variant lands better is how a held-out season stops being held out.

### Why the floor is 2013, not 2012

The original scope put it at 2012 on the grounds that `snap_counts` begins there. It does
not. `snap_counts_2012.csv` answers HTTP 200 with a valid sixteen-column header and **zero
data rows**; the release is first populated in 2013 with 23,799 rows. A split whose first
development season carries no snap data cannot support the features it was widened for,
which was the criterion that chose the floor in the first place. See `docs/data-sources.md`.

### How much history a projection sees

Two prior seasons, named as `SEASON_HISTORY_LOOKBACK`. That is what the frozen configuration
was given when it was evaluated on 2025, and it was previously implicit in which files
happened to be loaded — inconsistently, since evaluating 2024 from the same loadout gave a
projection only *one* prior season.

Making it explicit is what lets the window widen without disturbing the holdout. Loading
thirteen seasons and letting history accumulate naturally would change the 2025 prediction
itself, and a changed holdout prediction is a fresh evaluation of the holdout — spent on a
refactor rather than on a hypothesis.

### What the wider window buys

The reason the epic starts here. Every figure below is the model against the prior-games-mean
baseline, from one `pnpm backtest -- --holdout` run.

| Set | n | players | clustered SE | MDE at 80% power | smallest reportable |
| --- | --- | --- | --- | --- | --- |
| Development 2013–2021 | 26,837 | 846 | **0.0153** | 0.0430 (**0.72%**) | 0.0301 (0.50%) |
| Tuning 2022–2024 | 9,063 | 448 | 0.0241 | 0.0676 (1.14%) | 0.0474 (0.80%) |
| Holdout 2025 | 3,037 | 308 | 0.0443 | 0.1242 (2.07%) | 0.0872 (1.46%) |

The detection floor falls from **2.07%** on one season to **0.72%** on the development set.
That is the difference between an epic that can distinguish a 1% feature from noise and one
that cannot.

It is worth noting that the standard error did **not** fall by the square root of the season
count. Nine development seasons carry 8.8× the player-weeks of the holdout but only 2.7× the
players, because the same players recur year after year and a player is one cluster however
many seasons he appears in. The gain is 2.9× rather than the 3.0× the season count suggests,
and the reason is the same fact the clustering exists for.

Edges by set: development **2.13%**, tuning **2.93%**, holdout 2.74%. They are close, which
is the useful signal — the model is not carried by one favourable stretch.

## Method

Data: nflverse weekly player stats for the 2011–2025 regular seasons, joined to
`games.csv` for schedule, Vegas lines, and venue. Seasons 2011 and 2012 are loaded only as
history for the first evaluated season, never scored. See `docs/data-sources.md`.

Target: PPR fantasy points for QB, RB, WR, and TE.

The baseline is the mean of **every prior game inside the history window**, which spans up
to three seasons — not a season-to-date mean. It sees exactly the history the model sees;
restricting it to the current season would hand the model an unfair advantage early in the
year and inflate the reported edge.

Evaluation population: a player-week is scored only if the player has at least 4 prior
games and averaged at least 6.0 PPR points over their last 8. This restricts the metric to
genuinely rosterable players. Including deep-bench players with near-zero usage would
flatter every model equally and measure nothing useful.

Prediction uses only information available before kickoff: prior weeks for the player,
and the game's Vegas line and venue. There is no leakage of same-week production.

Defense-vs-position factors are always built from the **preceding** season — 2024 factors
when evaluating 2025 — never from the season being evaluated.

Hyperparameters were selected on the tuning seasons, then frozen and evaluated once on
**2025**. The 2025 number is therefore a genuine out-of-sample estimate, not a tuned one.

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

Produced by `pnpm backtest -- --holdout`, which is the authoritative run. The tuning rows
are in-sample (hyperparameters were chosen there); only the 2025 row is a valid accuracy
claim.

### 2025 — out-of-sample, n = 3,037 player-weeks

| Model | MAE | FGTO edge |
| --- | --- | --- |
| **FGTO model (frozen)** | **5.8236** | — |
| Baseline: mean of all prior games | 5.9877 | **+2.74%** |
| Baseline: last-3-game mean | 6.3618 | +8.46% |

Per position (MAE): QB 6.735, RB 5.803, WR 5.657, TE 5.239.

Residual bias is −0.573 points: the model still projects slightly high even after
calibration, because the evaluation population is selected for recent production and
regresses. This is disclosed rather than hidden, and it is why the interface leads with a
range rather than a single number.

### Tuning set — in-sample, 2022–2024

| Season | n | players | model | prior-games mean | last 3 | edge |
| --- | --- | --- | --- | --- | --- | --- |
| 2022 | 3,126 | 324 | 5.7271 | 5.8714 | 6.3030 | 2.46% |
| 2023 | 2,949 | 307 | 5.7556 | 5.9509 | 6.2507 | 3.28% |
| 2024 | 2,988 | 296 | 5.8320 | 6.0169 | 6.3311 | 3.07% |
| **Pooled** | **9,063** | **448** | **5.7709** | **5.9453** | **6.2952** | **2.93%** |

Development set, 2013–2021: 26,837 player-weeks over 846 players, model 5.8818 against a
prior-games-mean baseline of 6.0099, a **2.13%** edge.

That in-sample and out-of-sample land within a percentage point of each other — 2.93%,
2.13%, 2.74% — is the useful signal here. The model is not carried by its tuning seasons.

A separate 2024 figure appears below in the calibration section: MAE 5.8346 against 5.8821
uncalibrated, on n = 2,963. That is the **frozen** pipeline, which gives a 2024 projection
only one prior season rather than two, and it is reported unchanged because it is the run
the constants in `config.ts` were derived from. The 2024 row above sees 2022 as well, which
is why its sample and its error differ.

**The headline number the product may state is 2.74%**, measured against the strongest
baseline. The 8.46% figure against a last-3-game baseline is real, but quoting it while
omitting the stronger baseline would be cherry-picking.

## How certain that 2.74% is

For a long time this document published a point estimate and nothing beside it, which left
a reader no way to distinguish a measured result from a coin landing the same way twice.
The backtest now prints an interval and a significance test for every model-versus-baseline
comparison, on every set, and `lib/nfl/model/published-metrics.json` carries the holdout
one.

Two properties of the data set the method.

**The comparison is paired.** The model and the baseline predict the same player-weeks, so
the quantity to average is the per-observation difference in absolute error. Comparing the
two MAEs as if they were independent samples throws the pairing away and inflates the
standard error several times over.

**The observations are not independent.** A player appears up to seventeen times in a
season, and a player the model systematically misreads contributes seventeen correlated
errors rather than seventeen pieces of evidence. The standard error is therefore clustered
by player, using the sandwich estimator specialised to a mean. On 2025 that matters: the
i.i.d. figure is 0.0364 and the clustered one is **22% larger** at 0.0443. A *t* statistic
built on the naive one would have read 4.51 rather than 3.70.

### 2025 — model against the prior-games-mean baseline

n = 3,037 player-weeks over **308** distinct players.

| Quantity | Value |
| --- | --- |
| ΔMAE (baseline − model) | +0.1642 points |
| Standard error, clustered by player | **0.0443** |
| Standard error, assuming independence | 0.0364 |
| *t*, on 307 degrees of freedom | **3.70** |
| Two-sided *p* | 0.00025 |
| 95% CI on ΔMAE | [0.0769, 0.2514] |
| **95% CI on the edge** | **1.28% to 4.20%** |
| Minimum detectable effect, 80% power | 0.1242 (**2.07%**) |
| Smallest effect reportable as significant | 0.0872 (**1.46%**) |

The reference distribution is Student's *t* on `G − 1` degrees of freedom, not the normal,
because the cluster count is what the estimator has to work with. The *p*-value is computed
as an incomplete-beta tail rather than as `2 × (1 − CDF)`, which underflows to exactly zero
past about *t* = 8 — the last-3-games comparison below would otherwise print a *p* of 0,
claiming infinite certainty from 308 players.

Against the weaker last-3-games baseline the same run gives ΔMAE +0.5383, clustered SE
0.0527, *t* = 10.21, *p* = 3.01e-21, a 95% CI on the edge of 6.83% to 10.09%, a minimum
detectable effect of 0.1478 (2.32%), and a significance floor of 0.1038 (1.63%). The
bootstrap returns 0.0534 against the analytic 0.0527.

Those figures are carried in `published-metrics.json` under `significanceVsLastThree` and
asserted, for the same reason as the headline comparison: they were stated here in prose
with nothing producing them, which is precisely the failure the artifact exists to prevent.

### The bootstrap cross-check

The analytic interval assumes the sandwich estimator is right. A block bootstrap over
**players** — 2,000 resamples, seed 8675309, drawn from `lib/core/rng.ts` so the figure is
reproducible rather than different every run — checks it without that assumption. Whole
players are resampled with replacement, never individual player-weeks: resampling
player-weeks would destroy the very correlation the clustering exists to account for and
would agree with the naive estimator instead, an agreement proving only that both sides made
the same mistake.

It returns a standard error of 0.0440 against the analytic 0.0443, and an interval on the
edge of 1.31% to 4.14% against 1.28% to 4.20%. The two methods agree to well within their
own Monte Carlo error.

Clusters are resampled in sorted key order. That sounds like a detail and is not: the
resample picks clusters by index, so before it was sorted the seed drew whichever players
happened to be inserted first, and *insertion* order was a property of which season files
the script loaded rather than of the data. Widening the evaluation window reordered the map
and moved this interval while every analytic figure stayed put — a published number that
changed for no statistical reason. The same fix applies to the evaluation itself, which now
iterates players in a canonical order so that floating-point summation cannot drift either.

The percentage interval is the interval on ΔMAE rescaled by the baseline MAE, which treats
that baseline as fixed. The bootstrap recomputes both MAEs inside every resample and so
propagates the denominator properly; that it lands in the same place is the evidence the
approximation is harmless here.

### What the interval means for future work

**The 2.74% edge is real: the interval excludes zero, and comfortably.** It is also
imprecise. The honest reading of `1.28% to 4.20%` is "a small edge, somewhere between
barely worth having and modestly worth having", not "2.74%".

The line that matters most for anything built next is the **minimum detectable effect: 0.1242
MAE, or 2.07% of the baseline**. That is the smallest true improvement this sample could
distinguish from noise at 80% power.

A feature that genuinely improves weekly MAE by 1% therefore cannot be established on one
season of this population — and the way it fails is worse than an honestly wide interval.

Any result this sample can report as significant must sit at least one interval half-width
from zero, which is **0.0872 MAE, or 1.46%**. A true 1% effect cannot clear that bar *at its
own size*; it can only clear it by overstating itself by half again. So measuring one has
two outcomes: most of the time nothing significant, and the rest of the time a significant
result that is inflated by construction. That is the winner's curse, and it is the reason a
hypothesis below the floor must not be run at all rather than run and read cautiously — a
cautious reading cannot undo a selection effect that has already happened.

Any hypothesis smaller than these figures needs a wider evaluation window before it is
tested, not a more hopeful reading of a single season.

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
2024 only, leaving 2025 untouched. Combined with the later calibration correction, the
final out-of-sample result is **5.8236**.

A regression test in `project.test.ts` asserts that a later week cannot change an earlier
projection's baseline.

### Outcome quantiles

Every floor and ceiling shown in the interface is `mean × p10` and `mean × p90` from this
table. `pnpm backtest -- --holdout` prints it on the holdout season, from the same predictions the
MAE table is built from, and `OUTCOME_QUANTILES` in `lib/nfl/model/config.ts` is copied
from that output.

| Position | n | p10 | p90 |
| --- | --- | --- | --- |
| QB | 560 | 0.171 | 1.772 |
| RB | 760 | 0.269 | 1.901 |
| WR | 1,216 | 0.186 | 1.808 |
| TE | 501 | 0.217 | 1.953 |

The spread is enormous — a tenth-percentile outcome is around a fifth of the projection and
a ninetieth-percentile outcome nearly double it. That is not a defect in the model; it is
the week-to-week variance of fantasy football.

K and DST carry `provenance: "placeholder"` in the same table. The model does not project
those positions, so there is no backtest behind their bands and the type says so.

### Reproducing the sweeps

`pnpm backtest -- --sweeps` re-runs every parameter sweep on the tuning set and prints
the table below. Every claim in this section comes from that command; none is asserted
from memory.

On the pooled tuning set, holding the other parameters at their frozen values:

| Sweep | Result |
| --- | --- |
| EMA alpha | 0.05→5.8007, **0.10→5.7706**, 0.15→5.7709, 0.20→5.7852, 0.30→5.8434, 0.40→5.9314 |
| Usage cap | 0→5.7770, **0.2→5.7709**, 0.4→5.7756, 0.6→5.7896, 0.8→5.8129 |
| Vegas (team reference) | 0→5.7996, 0.25→5.7796, **0.5→5.7709**, 0.75→5.7751, 1→5.7911 |
| Vegas (league reference) | 0→5.7996, **0.25→5.7959**, 0.5→5.8103, 0.75→5.8433, 1→5.8937 |
| Opponent weight | 0→5.7745, **0.25→5.7709**, 0.5→5.7714, 0.75→5.7753, 1→5.7830 |
| Calibration | **on→5.7709**, off→5.8243 |

Every row that sits at the frozen value reads 5.7709, because those runs *are* the frozen
configuration.

### The alpha sweep now prefers 0.10, and the configuration is not changing

Widened from one tuning season to three, the EMA sweep puts its optimum at 0.10 rather than
the frozen 0.15. The difference is **0.0003 MAE**.

The tuning set cannot report an effect below **0.0474** as significant. 0.0003 is two orders
of magnitude under that floor — it is not a smaller optimum, it is the same optimum with
noise on it, and both values sit in a basin that is flat to four decimal places between 0.10
and 0.15 while degrading sharply outside it. Re-freezing on 0.10 would be selecting a
hyperparameter on a difference this sample cannot see, which is the failure the whole
protocol exists to prevent.

`EMA_ALPHA` therefore stays at 0.15. Recorded here because the temptation to move it is
exactly the kind of thing that goes unrecorded, and because the next reader running the
sweeps will see 0.10 in the "best" line and deserve to know it was considered and declined.

The other five sweeps put their optimum at the frozen value unchanged.

### Calibration factors

`pnpm backtest` also derives these, on 2024 with calibration switched off, under the frozen
history window that produced them. The sweep row above (5.8243 against 5.7709) is a
different measurement: it is calibration on and off across the whole tuning set under the
uniform lookback, not the derivation run.

| Position | n | mean predicted | mean actual | factor |
| --- | --- | --- | --- | --- |
| QB | 542 | 15.607 | 15.250 | 0.9771 |
| RB | 769 | 12.592 | 12.052 | 0.9571 |
| WR | 1,226 | 11.709 | 11.427 | 0.9760 |
| TE | 426 | 9.687 | 9.575 | 0.9884 |

`CALIBRATION` in `config.ts` is copied from that output. It previously held values from an
earlier pipeline; syncing them to what the script actually derives improved out-of-sample
MAE from 5.8324 to 5.8236 and cut bias from −0.627 to −0.573.

Two things are worth reading off that table. The league-referenced Vegas sweep buys a
little at 0.25 and then degrades steeply, ending worse than leaving the term out, while the
team-referenced sweep has a genuine interior optimum, and beats the league reference at
every weight above zero — the two are identical at zero, where the term is skipped.
And calibration moves the metric further than the usage, Vegas, and matchup terms combined.

### Implementation agreement

The model was prototyped in Python before being written in TypeScript. Run against the same
pipeline, the two agreed to 5.8512 versus 5.8507 — a difference of 0.0005 MAE, arising
because the TypeScript model recomputes every historical score through the configurable
scoring engine (with two-decimal quantization) while the prototype read upstream's
precomputed PPR column. Agreement at that tolerance is what confirmed the port was
faithful.

Both of those figures predate the lookahead-bias fix described above, so they are a
statement about *port fidelity*, not about current accuracy. The current number is 5.8236.

## What the sweeps established

These are the findings that shaped the model, each measured rather than assumed.

**Long memory beats recency.** Sweeping alpha from 0.05 to 0.40 gives a flat basin between
0.10 and 0.15 and steep degradation outside it — 5.9314 at 0.40 against 5.7706 at the
bottom — and a last-3-game baseline (6.30) is substantially *worse* than a mean over every
prior game in the window (5.95). Weekly fantasy scoring is noisy enough that aggressive
recency weighting discards more signal than it captures. This contradicts the common
intuition that "recent form" should dominate.

**The Vegas reference matters more than the Vegas weight.** Both references start from the
same 5.7996 at weight 0 — with the weight at zero the block is skipped entirely, so the
reference is irrelevant there. From there they diverge sharply. Against the team's own
prior weeks the term has a genuine interior optimum, 5.7709 at 0.5, and degrades gently on
either side. Against the *league* average it manages only a shallow gain (5.7959 at 0.25)
before turning and degrading steeply to 5.8937 at full weight — worse than not using the
term at all. The cause is double-counting: a player on a high-scoring offense already
carries that team's quality in their own scoring history, so scaling by team strength again
applies it twice. Only the game-specific deviation is new information.

**Usage and opponent adjustments are real but very small — and now provably below the
noise floor.** Against switching each off, the usage cap is worth 0.0061 MAE and the
opponent weight 0.0036; across their full sweep ranges, 0.0420 and 0.0121. The tuning set's
significance floor is 0.0474, so **neither term's contribution can be reported as
significant on it**, and the full-range usage figure only just reaches it. They are retained
because they are directionally sound and improve explainability, not because they move the
metric — and that was true when the numbers were larger on one season, but it can now be
stated as a measurement rather than as a judgement. Calibration, at 0.0534, clears the floor
and is worth more than both combined, which is the honest ordering of what actually matters
here.

## Honest interpretation

Weekly fantasy football scoring is dominated by irreducible variance. An MAE near 5.9
points against a mean around 12 means the error is roughly half the signal, and no amount of
feature engineering on public box-score data closes that. A 2.74% edge over a strong
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
pnpm backtest              # development and tuning sets
pnpm backtest -- --holdout # the holdout, and the published figures
```

Any change to the model must re-run this and update the table above in the same commit. A
claim that is not in this table may not appear in the UI. See the honesty ledger in
`README.md`.
