# Draft completion and strategy evaluation — September 9, 2026

This change closes a roster-accounting weakness. It does not establish that the
championship rollout is a better drafting strategy than ADP. The evaluation below is
intended to detect that distinction, including losses against simple policies.

## Required starters are not hypothetical waiver signings

The greedy continuation discounted empty streamable positions against a hypothetical
waiver replacement. On the September 8 keeper fixture, strict-ADP opponents left the
London/Wilson/Nabers branches without a quarterback. An actual draft still has to buy
that starter with an owned selection.

`guardDraftCompletion` measures maximum-cardinality slot matching using real player
identities, not points. When remaining owned picks equal missing starters, each pick
must increase coverage. Before intervening opponents, a position whose entire remaining
supply is needed is prioritized. FLEX and SUPERFLEX use the same matching test; a
player cannot fill two slots. Draft capacity and actual remaining selections both bound
the budget. Preseason cuts preserve maximum starter coverage before projected value,
including a required starter with negative expected points.

The guard reports `missingStarters`, `canComplete`, and its reason. `canComplete` means
the **currently valued pool**, if it remained available, contains a legal completion
within the owned-pick budget. It is not a guarantee against arbitrary future opponents.
Missing positions, too few picks, simultaneous supply threats, and players outside the
valued pool cannot be repaired by inventing a signing. Structural coverage does not
promise availability through every injury or bye.

The recommendation path throws a descriptive error when our initial state or default
continuation cannot produce the required starters. It excludes candidate continuations
that leave our roster incomplete. Opponents who already spent their selections without
a required starter do not make our own legal advice impossible: each recommendation
reports `incompleteOpponentTeams`. A nonzero count requires disclosure; that forecast
must not be described as a league of complete opponent rosters. The draft interface is
integrated separately by the coordinating change.
`incompleteBaselineOpponentTeams` separately reports the default comparison's count;
comparative warnings must consider both, since their opponent rosters can differ.

## Reproducible protocol

Run `pnpm draft-strategy-eval` offline. `-- --quick` reduces budgets for a smoke test;
it is not the reported evaluation. The script prints its protocol, complete rosters,
all teams' missing-slot counts, paired comparisons and runtime as JSON lines.

Four advised strategies face the same starting state and opponent seed:

- **ADP:** earliest market price, with the structural completion guard.
- **Roster-needs ADP:** earliest market price that increases starter coverage until
  all starters are covered; then guarded ADP.
- **Greedy:** the production base valuation plus the structural guard.
- **Rollout:** the production recommendation leader at every actual owned pick,
  using 600 selection scenarios and ten candidates.

There are three opponent assumptions. Raw **strict ADP** ignores roster legality and is
only a stress test; its incomplete opponents are printed and cannot support a quality
claim. **Needs ADP** fills starters before depth. **Noisy ADP** ranks players by ADP plus
an independent normal perturbation scaled by published dispersion at each pick, with
the completion guard. Neither is a fitted model of the user's managers. Needs and noisy
opponents must be checked for legal final rosters, not merely assumed legal from their
names.

Selection uses seed 20260731. Evaluation uses 19092026, 29092026 and 39092026, each
with 1,000 scenarios, and opponent draws use 9021026. These constants were declared
before inspecting comparative results; no strategy parameter is selected from them.
“Held-out seeds” means held out from candidate selection, not independent historical
leagues or an untouched software-development test set.

Each strategy is rescored on the same evaluation worlds. A player's stream does not
change when their fantasy owner changes. The title comparison is paired scenario by
scenario, against both ADP and roster-needs ADP. Its 95% interval measures finite-draw
uncertainty conditional on these inputs and assumptions. It does not measure player-
model error, market-source error, opponent-model error or generalization. Multiple
case/policy comparisons are descriptive and not multiplicity-adjusted. There is no
pooled confidence interval pretending the reused board cases are independent leagues.

The three cases are the exact 20-keeper live state before pick 16, and seats 1 and 10
in a ten-team, twelve-round, skill-only PPR reconstruction of the 2024 market board.
The historical board uses a twelve-team FFC price ordering in a ten-team draft; that
ordering and its dispersion are a market assumption, not verified Sleeper behavior.
There are no kickers or defenses in the historical exercise. The live custom fixture
covers them separately.

## External scoring, not another draw from the optimizer

`draft-evaluation-2024.json` stores 178 archived FFC skill players, including rookies.
It does not discard players because their outcomes were weak. All 178 identities are
resolved; the two explicit spelling bridges are Hollywood/Marquise Brown and
Joshua/Josh Palmer. Target-year statistics are used to identify and score players,
never to choose their price or draft action.

The FFC target payload describes August 31–September 1, 2024 drafts. Market curves use
2023 ADP and 2023 actuals. Model history uses 2022–2023 only. Empirical simulation ratios
use 2023 weekly scores over each player's 2022 mean, compressed into 100 mean-normalized
knots per position. This avoids importing the production PPR bands fitted on 2025 into
a purported pre-2024 exercise. The generic ratio fields are placeholders superseded by
those empirical knots. This is a constrained retrospective diagnostic, not a byte-exact
reconstruction of a historical production board.

That date does **not** validate every field in the retrospective ADP response. Review
found stale team and bye metadata: Josh Allen was assigned week 7 rather than 2024's
week 12, and Davante Adams was assigned his later team, NYJ, rather than opening-team
LV. The fixture ignores both ADP fields. All 178 opening teams come from archived
2024 week-one nflverse rosters, and their byes come from the 2024 schedule; this replaced
160 supplied bye values. Rebuilding fails on unresolved identities or missing opening
schedule metadata. Preliminary comparisons using the incorrect fields were discarded.
These are opening-season byes, not hindsight updates for subsequent trades.

After each full draft, the external path selects a lineup from preseason means and
known byes **before** reading actual weekly PPR points from nflverse's
`fantasy_points_ppr` column. A benched player's good actual week cannot replace a
starter afterward; negative starter scores remain negative. An unresolved external
identity is an error, not zero. A resolved player with no recorded game in a week
scores zero. No injury hindsight, waiver moves or target-season projection updates
are added. This deliberately limited lineup policy can penalize a team that a real
manager would repair during the season.

External season points and the resulting one-season bracket outcome are observations,
not title-probability estimates. One season, two seats and reused opponent assumptions
cannot establish an out-of-sample advantage. The 2024 season was already used elsewhere
in this repository and is not newly reserved validation data. **The reserved 2025 player
outcomes are not read or evaluated.** The live fixture retains its already-frozen
production distribution inputs; the historical exercise uses only the earlier training
years described above. The all-season schedule file is used only for 2024 byes.

The fixture records SHA-256 hashes for all source payloads. Rebuilding requires the
2022–2024 nflverse files and `games.csv` in `.cache/nflverse`, then
`pnpm exec tsx scripts/build-draft-evaluation-fixture.ts`; an alternate cache directory
may be passed as its first argument. This reconstruction uses only free sources:
[FFC 2024 ADP](https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2024),
[FFC 2023 ADP](https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2023),
[nflverse weekly statistics](https://github.com/nflverse/nflverse-data/releases/tag/stats_player),
[archived weekly rosters](https://github.com/nflverse/nflverse-data/releases/tag/weekly_rosters),
and the [NFL schedule](https://github.com/nflverse/nfldata/blob/master/data/games.csv).
Historical releases are retrospective downloads and may contain later corrections;
hashes make that input revision visible, not impossible.

## Results and runtime

The corrected full run completed all 36 case/opponent/strategy cells. Every advised
roster filled its required starters, including raw strict-ADP stress continuations.
All ten teams were structurally complete in every needs-ADP and noisy-ADP cell.
Raw strict-ADP still produced incomplete opponents and is excluded from the quality
tables below. The [machine-readable record](draft-strategy-evaluation-results.json)
contains every roster, missing-slot count, paired interval and runtime, including stress
results. Its protocol note was clarified after the run to distinguish frozen live-model
inputs from reserved outcome evaluation; no measured result was changed.

Conditional title percentages on the 3,000 held-out simulation draws:

| Case | Opponents | Guarded ADP | Roster-needs ADP | Greedy | Rollout |
| --- | --- | ---: | ---: | ---: | ---: |
| Live, 20 keepers | Needs ADP | 2.87% | 10.07% | 5.70% | 3.03% |
| Live, 20 keepers | Noisy ADP | 9.07% | 8.23% | 8.63% | 6.53% |
| 2024, seat 1 | Needs ADP | 9.27% | 11.97% | 12.97% | 8.60% |
| 2024, seat 1 | Noisy ADP | 5.97% | 6.10% | 15.07% | 14.20% |
| 2024, seat 10 | Needs ADP | 5.53% | 9.27% | 6.23% | 8.90% |
| 2024, seat 10 | Noisy ADP | 14.77% | 14.90% | 10.30% | 7.53% |

The rollout does not consistently beat either simple baseline even inside the
simulator. On the live needs-ADP case, its difference versus guarded ADP is +0.17
percentage points (paired 95% interval −0.68 to +1.01), but versus roster-needs ADP it
is −7.03 points (−8.24 to −5.83). On historical seat 1 with noisy opponents it gains
8.23 points over guarded ADP, yet seat 10 under that same opponent rule loses 7.23.
These conditional, descriptive intervals do not establish real-world title edges.

External 2024 regular-season PPR points under the fixed preseason lineup policy:

| Seat | Opponents | Guarded ADP | Roster-needs ADP | Greedy | Rollout |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Needs ADP | 935.16 | 1028.54 | 1133.10 | 1202.14 |
| 1 | Noisy ADP | 1044.82 | 913.72 | 1129.72 | 976.90 |
| 10 | Needs ADP | 970.18 | 941.18 | 1247.18 | 1160.08 |
| 10 | Noisy ADP | 1449.50 | 1459.20 | 1252.28 | 1056.92 |

The external ordering disagrees with the simulator in important cells. For example,
seat 1/noisy has a simulated rollout advantage over ADP but 67.92 fewer realized
points. The single season and static injury-blind lineup policy do not identify a
universal winner or calibrate championship odds. One opponent-noise seed per case
also leaves broader manager-policy sensitivity unmeasured.

A fresh-process first recommendation on the exact 20-keeper/31-held-player fixture
took **6.27 seconds** for 600 scenarios and ten candidates on Apple M4 Max, Node 24.18.0;
an independent reviewer measured 6.35 seconds. This excludes module startup, and other
local CPU workloads were active. Full rollout draft replays took about 31–52 seconds,
versus at most 0.11 seconds for the simple strategies. Browser-worker/mobile latency
and a draft-clock service-level guarantee remain unmeasured.

**Readiness conclusion:** the structural fix and diagnostic harness pass their bounded
checks; the rollout has not earned a superior-strategy default or a title-edge claim.
A clearly labeled market-first legal comparator can be offered for transparency, with
the simulator remaining experimental. This change does not select or tune a new
production default from these results. FFC ordering/dispersion may not represent the
user's Sleeper market, so even the market comparator must identify its source.

Validation: `pnpm verify` passed 1,841 tests across 89 files; the production build passed;
both draft-mock modes passed 9/9 checks; the default development/tuning backtest was
unchanged and did not evaluate the 2025 holdout. Independent review found and verified
fixes for scarcity being bypassed at the starter deadline and stale historical ADP
byes. It also checked 2,400 brute-force matching cases and all 178 historical schedule
assignments. No provider, draft, or production mutations were part of this evaluation.
