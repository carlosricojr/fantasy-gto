# Coverage audit protocol

Registered before the first audit run on 2026-09-09. This is an exploratory,
offline coverage study, not a production projection or a promotion gate.

Run `pnpm coverage-audit` with no arguments. The script evaluates 2013–2021
development and 2022–2024 tuning separately, using 2011–2012 only as warm-up
history. It never loads 2025 player/team statistics; schedule rows after 2024
are discarded before contest/market parsing. No holdout flag is supported.

Fixed comparisons, with no parameter search:

- Skill players with one to three prior appearances in the unchanged model's
  two-season history window: frozen `projectPlayer` versus that history's PPR mean.
- Skill players with at least four appearances but a last-appearance gap above
  four NFL weeks: the same frozen model versus the same prior-history mean.
- K and D/ST: previous-season game mean, requiring eight previous-season games,
  versus the last three prior appearances. This is the fixed simple mean already
  used by the K/DST outcome-band audit, not a newly fitted model.

Each forecast precedes insertion of its target observation. Skill defense
factors use only the prior season; betting-market team averages use strictly
earlier weeks. Results report MAE, paired differences and player/team-clustered
uncertainty from the existing statistics implementation. There is no new
predictive variance or calibration fit.

The population is **observed regular-season appearances**, conditional on
playing. It is not all rostered players, includes low-volume/deep-bench skill
players, and has no six-PPR prior-history filter. Its scores cannot be compared
directly with the published core-model population. It does not establish
availability probabilities, pregame roster identity accuracy, rookie forecasts,
or causal injury effects. Multiple exploratory cohorts are not an independent
confirmatory test.

K rows require all nine scoring counters explicitly present and finite before
the existing parser/scorer is used. Missing counters are skipped and counted,
not imputed to zero. The D/ST benchmark requires six explicit event counters and
a resolved final score; conventional PPR scoring uses the opponent's final
score as points allowed. This does **not** prove platform-exact D/ST points
allowed, yards-allowed tiers, blocked kicks, forced fumbles, return scoring, or
the user's full custom scoring. A favorable error comparison alone cannot
promote it to that claim.

Production history, injury, identity, scoring and kickoff gates remain unchanged.
Promotion requires a separate reviewed design that states supported scoring,
source coverage and the remaining conditional-on-appearance limitation.

## First run — September 9, 2026

MAE and paired 95% intervals are in fantasy points. Positive delta favors the
first method. K/DST use prior-season mean versus last-three; skill cohorts use
the frozen model versus prior-history mean. No production gate was changed.

| Split / cohort | Appearances | Clusters | First MAE | Comparator MAE | Delta [95% interval] |
| --- | ---: | ---: | ---: | ---: | --- |
| Development / returning skill | 2,068 | 1,000 | 4.1333 | 4.3084 | 0.1751 [0.1176, 0.2326] |
| Development / limited skill | 3,371 | 1,170 | 3.6628 | 3.7407 | 0.0779 [0.0577, 0.0982] |
| Development / K | 3,569 | 64 | 3.6758 | 4.0050 | 0.3292 [0.2376, 0.4208] |
| Development / conventional D/ST | 4,640 | 32 | 4.6408 | 5.0935 | 0.4527 [0.3576, 0.5479] |
| Tuning / returning skill | 793 | 473 | 3.8982 | 4.2323 | 0.3341 [0.2322, 0.4361] |
| Tuning / limited skill | 990 | 372 | 3.5662 | 3.6123 | 0.0462 [0.0095, 0.0828] |
| Tuning / K | 1,314 | 39 | 3.8274 | 4.2836 | 0.4562 [0.3485, 0.5640] |
| Tuning / conventional D/ST | 1,630 | 32 | 4.3676 | 4.6440 | 0.2764 [0.1054, 0.4474] |

No K/DST rows were skipped for missing required counters and no candidate
contest was missing. These are error measurements on eligible appearances,
not percentages of a user's roster covered. The audit emits source-file SHA-256
digests for snapshot reproducibility. Existing parsers ignore non-fantasy and
aggregate player rows; fantasy-position identity/period duplication fails closed.

Decision: retain production gates. The returning-player result justifies a
separate conditional-on-playing extension study with current roster/injury
evidence, not automatic injury clearance. K is the cleanest next scoring
candidate because its nine counters are explicit; it still needs exact imported
scoring mapping, eligibility checks and a deliberately labeled baseline UX.
D/ST requires platform-correct points-allowed and unsupported-event resolution
before it can claim full custom-scoring coverage. Limited-history's tuning
delta is small and exploratory; no rookie/no-history estimate was evaluated.
