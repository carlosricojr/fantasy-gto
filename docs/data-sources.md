# Data Sources (verified)

Every fact in this document was verified by direct HTTP request on 2026-07-30. Treat it as
authoritative: it supersedes any recollection of these APIs. Re-verify before changing an
endpoint, and update this file in the same commit.

All primary sources are **free and unauthenticated**. The product requires no paid data
vendor to produce a projection.

## Runbook: refreshing the draft boards before a draft

The boards rebuild every six hours at 03:00, 09:00, 15:00 and 21:00 UTC through the offseason and preseason,
and not during the regular season — `planDraftRefresh` in `lib/nfl/draft/refresh-plan.ts`
decides that, and it is tested across every phase. The matrix is three scoring formats across
eleven league sizes: **33 boards**.

Player identity and roster status run on a separate 15-minute clock. One complete catalog
serves all 33 boards, so a reserve/exempt/cut designation does not wait for a market rebuild.
The refresh hashes canonical rows and only rewrites the catalog when content changes; an
unchanged check advances `checkedAt` without rewriting hundreds of documents. Players stay
searchable and recordable regardless of valuation or status, while only valued active rows
enter recommendations.

**A failed rebuild is invisible in a timestamp.** `publishBoard` is atomic, so a run that
fails leaves the previous board whole — which is the behaviour you want, and is exactly why
the failure does not show up as an old date. The board can be two hours old and not be the
board the last run was trying to produce. `boardFreshness` therefore carries the last
attempt's time and status alongside the published timestamp, and the draft screen shows one
of five states: fresh, stale, refreshing, last-refresh-failed, never-built.

### Check

```bash
npx convex run --prod draft:boardFreshness \
  '{"season": 2026, "scoringId": "standard", "teams": 10}'
npx convex run --prod draft:catalogFreshness '{"season": 2026}'
```

Read `lastAttemptStatus`. `"failed"` means the board on screen is not the one the last run
intended, whatever `computedAt` says. `"running"` means a rebuild is in flight and nothing
needs doing.

### Force a rebuild

```bash
npx convex run --prod --push ingest:refreshDraftBoards '{}'
npx convex run --prod ingest:refreshDraftPlayerCatalog '{"season": 2026}'
```

It returns `{rebuilt, failed, attempted}` — or `{rebuilt: 0, failed: [], skipped}` with a
sentence saying why nothing was built, which is the case to read before assuming a break.
`failed` names each shape that did not build and the reason. One shape failing does not stop
the rest: a market board can be missing for an unusual size while the common ones are fine.

### Before a live draft

Check the exact shape being drafted, not the default. A board is per `(season, scoring,
teams)`, and the seven league sizes with no published market board are derived from a
neighbour — `adpSourceTeams` says which, and it is worth reading before trusting a price.
Also require `catalogFreshness.computedAt` within the last hour. Any
`unknownStatuses` entry is a source-drift alarm: the affected identities remain recordable
but are deliberately withheld from recommendations.

### Staleness

`BOARD_STALE_AFTER_MS` is 14 hours: two full six-hour cycles plus two hours of slack, the
smallest threshold that does not fire on a single late or slow run. A warning that appears
routinely is a warning nobody reads. Change the cron and this has to change with it; both
numbers live beside each other in `refresh-plan.ts`.

## Average draft position is published for four league sizes, not eleven

Confirmed by direct request on **2026-08-07** — later than the date at the top of this file,
and worth saying so, because this is the check that decides which leagues the product can
serve. Every integer size from 6 to 16, on 2026 standard
(`https://fantasyfootballcalculator.com/api/v1/adp/standard?teams=N&year=2026`):

| Teams | Response |
| ---: | --- |
| 6, 7, 9, 11, 13, 15, 16 | HTTP 400, `{"status":"Error"}` |
| 8, 10, 12, 14 | HTTP 200, 201 players |

The product offers 6–16 because those are ordinary leagues. The seven with no published
board are **derived** from the nearest published one by rescaling every pick number by
`teams / sourceTeams`, which maps a pick onto the same *round* in the target league — the
thing the market actually measures. Ties go to the smaller board, whose residual error points
toward players going earlier than they will; overstating scarcity costs a round where
understating it costs the player.

`lib/nfl/draft/league-size.ts` holds the rule, `draftBoardRuns.adpSourceTeams` records which
board each run used, and the draft screen says so. A board whose provenance predates the field
reports "not recorded" rather than "published" — those are different claims.

**The rescale is an approximation and no measurement here says how far off it is.** Real
drafts are not exactly linear in league size. What is asserted is that the transform is
monotone, so it cannot reorder the board — the market's *ranking* is the half of a player's
value this project measured as better than its own model, and that half survives intact.

## 1. nflverse — primary statistical source

Public GitHub release assets. No API key, no rate limit of practical concern.

Base: `https://github.com/nflverse/nflverse-data/releases/download`

### 1.1 Weekly player stats (the core table)

```text
{base}/stats_player/stats_player_week_{SEASON}.csv
```

One unified file per season covering offense, IDP defense, kicking, and punting: **145
columns**. This is the current asset. The older `player_stats/player_stats_{SEASON}.csv`
release is **legacy and stops at 2024** — do not use it.

Verified for 2025: 19,421 rows, of which 18,539 are `season_type == "REG"`.

Columns the model depends on (exact names — several differ from the legacy file):

| Purpose | Columns |
| --- | --- |
| Identity | `player_id`, `player_display_name`, `position`, `position_group`, `team`, `opponent_team` |
| Join keys | `season`, `week`, `season_type`, `game_id` |
| Passing | `completions`, `attempts`, `passing_yards`, `passing_tds`, `passing_interceptions`, `sacks_suffered`, `passing_air_yards`, `passing_epa`, `passing_2pt_conversions` |
| Rushing | `carries`, `rushing_yards`, `rushing_tds`, `rushing_fumbles_lost`, `rushing_epa`, `rushing_2pt_conversions` |
| Receiving | `targets`, `receptions`, `receiving_yards`, `receiving_tds`, `receiving_fumbles_lost`, `receiving_air_yards`, `receiving_epa`, `receiving_2pt_conversions` |
| Usage (stable signal) | `target_share`, `air_yards_share`, `wopr`, `racr` |
| Kicking | `fg_made`, `fg_att`, `fg_made_0_19`, `fg_made_20_29`, `fg_made_30_39`, `fg_made_40_49`, `fg_made_50_59`, `fg_made_60_`, `fg_missed`, `pat_made`, `pat_att`, `pat_missed` |
| IDP defense | `def_sacks`, `def_interceptions`, `def_tds`, `def_safeties`, `def_fumbles_forced`, `fumble_recovery_opp`, `fumble_recovery_tds` |
| Returns | `special_teams_tds`, `punt_return_yards`, `kickoff_return_yards` |
| Oracle | `fantasy_points`, `fantasy_points_ppr` |

**Naming traps.** The legacy file used `interceptions`, `sacks`, `recent_team`, and
`def_safety`. The current file uses `passing_interceptions`, `sacks_suffered`, `team`, and
`def_safeties`. Coding against the legacy names silently yields zeros.

**`fantasy_points_ppr` is a validation oracle, not an input.** It reproduces standard PPR
for offensive players and is used in tests to prove our scoring engine is correct. It is
**0 for kickers** — nflverse does not score them — so kicker scoring must be computed
entirely by our engine and cannot be validated against this column.

### 1.2 Schedules, Vegas lines, and weather

```text
{base}/schedules/games.csv
```

One file, all seasons, 7,548 rows. Verified coverage: 2023, 2024, and 2025 each have 285
games all played; **2026 has 272 scheduled games with 0 played**.

Relevant columns: `game_id`, `season`, `game_type`, `week`, `gameday`, `gametime`,
`away_team`, `home_team`, `away_score`, `home_score`, `away_rest`, `home_rest`,
`spread_line`, `total_line`, `away_moneyline`, `home_moneyline`, `div_game`, `roof`,
`surface`, `temp`, `wind`, `stadium`.

`spread_line` and `total_line` are populated for **future** games, which is what makes the
Vegas component of the model implementable with no paid odds vendor. `roof` takes the
values `outdoors`, `dome`, `closed`, `open`, or empty.

**Join integrity: verified 272/272 (100%)** of 2025 regular-season `game_id` values in the
player stats file resolve to a row in `games.csv`. `game_id` is the join key between player
production and game context.

**Bye weeks are derived from this file, not from the ADP feed.** Verified 2026-08-17 by
direct request: the 2026 regular season spans weeks 1–18, and each of the 32 teams is
absent from exactly one week (byes fall in weeks 5–14), so `lib/nfl/byes.ts` can derive
every team's bye as the single missing week. Cross-checked against the ADP feed's
published byes on the frozen audit board: all 213 comparable rows agree, and the feed has
no bye at all for the 388 teamed rows it does not price — which is why the feed's bye is
demoted to a fallback (`convex/ingest.ts` counts any disagreement as `byeMismatches`).
`tests/fixtures/games_2026.csv` freezes the 2026 regular-season rows (the ten columns
`parseContests` reads) for the draft-mock harness's `--schedule-byes` mode.

**Operator note — the annual roster-before-schedule window.** The draft-board build now
*requires* a resolved bye on every teamed row: the schedule-derived bye is used wherever
the schedule can answer for the team, the ADP feed's bye is used only where it cannot
(and only when the feed's week is one the schedule shows some team idle), and a row
neither source can answer for fails the build loudly rather than writing null. The two
failure messages are distinguishable: "no games for the season" (the drafted season is
not in the schedule release yet) and "no bye from any source for &lt;teams&gt;" (the
release is truncated, or a team's idle week is ambiguous, and the market feed does not
price — or misprices — the affected rows). The first is an expected
annual state: `draftSeasonFor` flips to the next season as soon as the current one ends,
while nflverse publishes the next `games.csv` rows only at the May schedule release — in
that window every board shape fails to rebuild, by design, rather than shipping boards
whose market-absent rows carry the #89.D null-bye subsidy. The previous board stays
published throughout; `refreshDraftBoards` records the failure per shape. Its returned
record also carries `byeMismatches` alongside `rebuilt`/`failed`/`attempted` — the count,
summed across shapes, of rows whose feed-published bye disagreed with the schedule's
(the schedule won). Zero is the healthy state; a nonzero value means the ADP feed's byes
have gone stale and is worth a look even though no wrong bye reached a board.

### 1.2a Historical coverage — a present column is not a populated one

Verified 2026-08-05 by direct request, parsed with this repository's own CSV reader.
**`pnpm verify-sources` reproduces every figure in this section**, so none of it is asserted
from memory. Re-run it before trusting these numbers; upstream retires and repopulates
releases.

**The header does not drift.** All 145 columns are byte-identical for every season from
1999 through 2025. Coding against a renamed column is not the historical hazard here.

**The population does.** Share of regular-season skill-position rows (WR/TE/RB) carrying a
non-empty, non-zero value:

| Season | `target_share` | `air_yards_share` | `wopr` | `racr` | `targets` |
| --- | --- | --- | --- | --- | --- |
| 1999 | 80% | 11% | 52% | 9% | 80% |
| 2004 | **0%** | **0%** | **0%** | **0%** | **0%** |
| 2006 | **0%** | **0%** | **0%** | **0%** | **0%** |
| 2008 | **0%** | **0%** | **0%** | **0%** | **0%** |
| 2009 | 82% | 80% | 82% | 69% | 82% |
| 2012 | 82% | 80% | 82% | 70% | 82% |
| 2016 | 83% | 81% | 83% | 72% | 83% |
| 2021 | 83% | 81% | 83% | 70% | 83% |
| 2024 | 81% | 78% | 81% | 68% | 81% |
| 2025 | 79% | 77% | 79% | 67% | 79% |

2004 through 2008 parse cleanly, carry every expected column, and contain **no receiving
usage at all** — not even a target. `num()` reads a blank cell as zero, so those seasons
produce a complete, plausible, entirely fictional usage signal. 2000–2003, 2005 and 2007
were not checked; 2005 and 2007 are bracketed by zero-coverage seasons on both sides.

`scripts/backtest.ts` therefore asserts per-season usage coverage rather than trusting the
parse, and refuses a season below 50%. A row count alone would not have caught this: the
2006 file has 16,495 regular-season rows.

### 1.2b Snap counts — starts in 2013, not 2012

```text
{base}/snap_counts/snap_counts_{SEASON}.csv
```

Keyed by `pfr_player_id`, not `gsis_id`, so it cannot join to `stats_player_week` directly.
Columns: `game_id`, `pfr_game_id`, `season`, `game_type`, `week`, `player`,
`pfr_player_id`, `position`, `team`, `opponent`, `offense_snaps`, `offense_pct`,
`defense_snaps`, `defense_pct`, `st_snaps`, `st_pct`.

**`snap_counts_2012.csv` answers HTTP 200 with a valid header and zero data rows.** Measured
row counts: 2012 → 0, 2013 → 23,799, 2014 → 23,864, 2015 → 23,842, 2016 → 23,890,
2017 → 23,862. The release is first populated in 2013, and that is why the development
window starts there. `pnpm verify-sources` reproduces this.

The bridge to `gsis_id` is `players.csv` (section 1.2c), which carries both identifiers for
22,556 of its 25,037 rows. Measured join rates for regular-season skill rows (QB/RB/WR/TE/FB): 2013
**100.0%** (0 unjoinable players), 2016 **99.9%** (2), 2020 **99.9%** (2), 2024 **99.7%**
(3). The players who fail to join are genuinely marginal — their mean `offense_pct` is
17.1%, 8.6% and 10.8% in those three seasons, against a league where a starter sits far
higher. Report on the joinable subset and do not impute the gap, but do not caveat a
0.3% gap as though it were large either.

`bridgeSnaps` in `lib/nfl/snaps.ts` returns the unmatched rows alongside the matched ones
rather than discarding them, and `pnpm verify-sources` measures the join rate **through that
same function** — not through a parallel implementation in the script, which would publish a
number nothing in the product actually exercises.

Counting rather than dropping is the load-bearing choice. A caller that discarded unmatched
rows would report snap share for the players it could resolve and say nothing about the
rest, which reads as complete coverage. A caller that defaulted them to zero would be worse:
**zero snaps means benched and unknown snaps means unknown**, and no model should be unable
to tell those apart.

Note that `offense_pct` is a fraction, not a percentage — upstream ships `0.9` for 90%.
Reading it as a percentage puts every snap share two orders of magnitude too low and
silently disables any feature built on it.

### 1.2b-1 Team weekly stats — the only place a D/ST week exists

```text
{base}/stats_team/stats_team_week_{SEASON}.csv
```

Verified by direct request 2026-08-26 for every season 2012–2024, and counted by
`pnpm verify-sources` on every run since: one row per team-game, **512–544** regular-season
rows a season, **32** distinct teams in every season.

**`stats_player_week` carries no D/ST row at all**, because a team defense is not a player.
Measured rather than asserted: the script collects every position code the player release
uses across the whole window — 26 of them — and **throws** if `DST`, `DEF` or `D` is ever
among them, since that would mean this whole section is working around a problem upstream
has stopped having. That is why this release exists in the repo: it is the only nflverse file from
which a defense's week can be assembled.

Columns the parser reads, and their exact spellings: `def_sacks`, `def_interceptions`,
`fumble_recovery_opp`, `def_tds`, `special_teams_tds`, `def_safeties`, plus `team`,
`week`, `season` and `season_type`. Two are easy to get wrong in a way that parses:
`def_fumbles` is a different count from `fumble_recovery_opp`, and `special_teams_tds` is
the team's own return touchdowns, which is what a fantasy defense is credited with.
`tests/fixtures/stats_team_week_sample.csv` is five unedited rows of the 2024 file, chosen
so every one of those six columns is non-zero somewhere, and `lib/nfl/stats/parse.test.ts`
asserts each is present and read.

**Points allowed is not in this release.** It is the other team's final score, so it comes
from the schedule (section 1.2) through the shipped `parseContests`. Measured: **0 of 6,782
regular-season team-weeks** failed to join a kickoff across 2012–2024. `pnpm verify-sources`
throws rather than fitting a band on whichever weeks happened to join.

**Yards allowed is not measured.** No shipped ruleset enables yardage tiers, so
`toDefenseStatLine` returns `null` rather than approximating it from the opponent's passing
and rushing yards, which is a different quantity.

#### Cross-checked against the player release

The player release carries the same `def_*` columns for individual defenders, so
aggregating them over each team-week is an independent reading of the same events.
Measured over **6,782 team-games**, 2012–2024:

| field | team-games where the two releases disagree |
|---|---|
| `def_interceptions` | 0 |
| `def_tds` | 0 |
| `fumble_recovery_opp` | 0 |
| `special_teams_tds` | 0 |
| `def_sacks` | 8 |
| `def_safeties` | 131 |

**The comparison is asserted, not merely printed**, and it has a floor of its own — every
check counts *disagreements*, so a key that stopped matching would read exactly like two
releases in perfect accord. The four fields that agree exactly are required to keep agreeing
exactly: any disagreement there is an upstream contract change, and `verify-sources` refuses
rather than fitting the band on a quantity that has quietly become a different one.

Safeties are the one real disagreement, and the team release is taken as authoritative for
them. It changes nothing that matters, and the script proves that on every run rather than
asking to be believed: it refits the entire D/ST band with safeties taken from the player
release instead and prints both side by side — dispersion **0.9045 against 0.9050**, band
**0.208/2.117 against 0.208/2.118**. That is why sacks and safeties are bounded loosely
(10% of team-games, against the 0.12% and 1.93% they measure today) rather than pinned:
what matters is not the count but that the band cannot feel it.

### 1.2b-2 Measured K and D/ST outcome bands

`OUTCOME_QUANTILES` in `lib/nfl/model/config.ts` used to carry an admitted placeholder for
kicker and defense, because `pnpm backtest` fits a band from the model's own predictions and
the model projects neither position. Both are now measured here instead, and
`pnpm verify-sources` prints them beside the checked-in constants and **fails if the two
disagree**. That is a stronger contract than the skill bands carry: `pnpm backtest` prints
its measured quantiles but does not compare them against `config.ts`, so those four are
checked by eye and these two are not.

**Construction.** For each season 2013–2024, each week's actual fantasy points divided by
that entity's *prior*-season points per game, requiring at least eight prior games behind the
denominator. 2012 supplies denominators and is never scored; **nothing from 2025 enters either band**,
because 2025 is the holdout and a band fitted here is not the pre-registered decision `CLAUDE.md`
reserves it for. The denominator is deliberately a forecast rather than a same-season mean:
the skill bands are actual-over-*predicted* and carry the forecast's error, and a band built
on a level nobody knows until the season is over would be a narrower, differently-defined
number.

Scoring is this repo's own K and D/ST ladders, which `lib/nfl/scoring/presets.ts` says
plainly are conventional defaults verified against no external source — unlike the offensive
values, which are. A league scoring defenses differently has a differently-shaped band. The
three shipped rulesets score K and D/ST identically, so unlike the skill bands these two are
not PPR-specific.

**Measured, 2013–2024:**

| | n | p10 | p50 | p90 | weeks ≤ 0 | E[max of 2]/mean | σ from p10/p90 | σ from E[max] |
|---|---|---|---|---|---|---|---|---|
| K | 4,866 | 0.271 | 0.952 | 1.864 | 3.7% | 1.341 | 0.752 | 0.624 |
| D/ST | 6,270 | **0.000** | 0.858 | 2.379 | 12.6% | 1.478 | **undefined** | 0.905 |

**The kicker band is the empirical deciles**, taken exactly as the four skill bands are:
`0.271 / 1.864`, against a placeholder of `0.25 / 1.85` — the placeholder was within 4% on
dispersion. It is flat in the prior-games threshold (4 → `0.267/1.875`, 12 → `0.276/1.859`)
and dropping any one scored season moves its dispersion only within [0.620, 0.632].

**The defense band cannot be the empirical deciles.** Under the conventional points-allowed
ladder an eighth of team-weeks score nothing or less, so the empirical tenth percentile is
0.000 and the log range `ln(p90/p10)` is undefined. Flooring it at an epsilon does not
rescue anything: it manufactures a dispersion near six, which is not a wide distribution but
a degenerate one — nearly every week at zero with rare enormous spikes, the mean preserved
and the shape absurd, and it would inflate the worth of a *second* defense, which is the
exact defect the #88 audit found.

So the defense is fitted by matching the expectation of a weekly maximum, which is defined
whatever the lower tail does and is the only functional the season simulation consumes: a
roster scores the best legal lineup it can field each week. That gives σ = 0.905 and a band
of `0.208 / 2.118`, against a placeholder of `0.2 / 2.0` — within 1% on dispersion.
Dropping any one scored season moves it only within [0.897, 0.913]. Note that the
prior-games threshold is *not* a sensitivity check here and the run says so: a team plays at
least fifteen regular-season games, so all three thresholds admit the identical sample and
print the identical band. Three identical rows are not agreement.

**Why the substitute is licensed — and how far that licence actually reaches.**
`verify-sources` fits both rules for all six positions under one construction and prints
them, so this can be read rather than taken on trust. The four projected positions appear
there **only as a yardstick**; their shipped bands come from the backtest against the
model's own predictions and nothing here touches them.

| | n | σ from p10/p90 | σ from E[max] | gap | sd = a + b·mean |
|---|---|---|---|---|---|
| QB | 4,650 | 0.610 | 0.584 | +4.5% | 4.55 + 0.17·mean |
| RB | 12,503 | **undefined** | 1.286 | — | 2.25 + 0.39·mean |
| WR | 18,308 | **undefined** | 1.158 | — | 2.24 + 0.42·mean |
| TE | 8,942 | **undefined** | 1.074 | — | 1.69 + 0.48·mean |
| K | 4,866 | 0.752 | 0.624 | +20.5% | 2.45 + 0.24·mean |
| D/ST | 6,270 | **undefined** | 0.905 | — | 2.92 + 0.40·mean |

The honest reading is narrower than the one this document first carried. A zero-valued tenth
percentile is **not** a D/ST peculiarity: under a prior-season denominator taken over a whole
release it happens at four of the six positions, because plenty of players have scoreless
weeks. And where both rules are defined they differ by 4.5% and 20.5% — close, but not the
tight agreement that would let one stand in for the other on that basis alone.

So the argument for the substitute is not that it reproduces the incumbent. It is that the
incumbent does not exist for D/ST, the substitute does exist everywhere, and the substitute
matches the functional the season simulation actually leans on. The incumbent is kept
wherever it works, for continuity with the four bands the backtest produces. Note also that
the skill rows above are the whole release rather than a draftable subset, which is why
their dispersions run so high — they are a yardstick for the *rules*, not an estimate of
anything.

**Two limits worth stating.** A measured band is not a projection: nothing has started
estimating what a kicker will score, only how far a week strays from an estimate somebody
else supplies, so `MODELED_POSITIONS` is unchanged and every market-only label still fires.

And the multiplicative form is an approximation at *every* position. The last column of the
table above is each entity-season's weekly standard deviation regressed on its own mean; a
pure scale family would put the intercept at zero. It sits between **1.69 and 4.55 points**
with a slope between **0.17 and 0.48**, which says weekly spread is mostly additive, so a
multiplicative band under-disperses strong players and over-disperses weak ones at every
position. Measuring a band does not fix that, and this row is here so nobody reads the
measurement as having done so.

### 1.2c Player directory — age, experience, and the identifier bridge

```text
{base}/players/players.csv
```

One file, every player, no season parameter. Verified 2026-08-05 and reproduced by
`pnpm verify-sources`.

25,037 rows carrying a `gsis_id`, of which 8,581 are at skill positions (QB/RB/WR/TE/FB).
`gsis_id` **is** the `player_id` used by `stats_player_week`, so that join is direct.

Columns the model cares about: `gsis_id`, `display_name`, `position`, `birth_date`,
`pfr_id`, `rookie_season`, `last_season`, `years_of_experience`, `draft_year`,
`draft_round`, `draft_pick`, `status`.

**Two different coverage figures, and conflating them is the easy mistake.**

| Measured over | `birth_date` | `pfr_id` |
| --- | --- | --- |
| All directory rows | 99.8% | 90.1% |
| Skill-position directory rows | 99.8% | **89.2%** |

| Regular-season skill player-weeks | in directory | with `birth_date` | with `pfr_id` |
| --- | --- | --- | --- |
| 2013 (5,516) | 100.0% | 100.0% | 100.0% |
| 2016 (5,563) | 100.0% | 100.0% | 99.9% |
| 2020 (5,670) | 100.0% | 100.0% | 99.9% |
| 2024 (5,920) | 100.0% | 100.0% | 99.9% |

The tenth of skill-position *directory rows* with no `pfr_id` is real, and it is not missing
at random — it skews to players last seen in 2002–2009 and to 2026 rookies not yet indexed by
Pro Football Reference. But it is **not** a tenth of the data that needs joining. Those
players overwhelmingly never appear in a modern weekly statistics file, so on the rows that
actually matter the identifier is present 99.9% of the time.

Report whichever figure answers the question being asked, and say which one it is. "One in
nine players cannot be joined" is true of the directory and false of any real season's
player-weeks.

Age is computed by `ageAt(birthDate, asOf)` in `lib/nfl/players.ts`, which takes the date as
an argument. That is not stylistic: replaying week 6 of 2017 has to produce the age the
player was *then*, and a function reading the wall clock would give every historical row
today's age and silently destroy any aging curve fitted on it. `lib/purity.test.ts` enforces
the rule.

### 1.2d Weekly injury reports — and whether they leak

```text
{base}/injuries/injuries_{SEASON}.csv
```

Verified 2026-08-06, reproduced by `pnpm verify-sources`.

**The header drifts, and the drift is dangerous.**

| Season | `game_type` | `season_type` | `date_modified` |
| --- | --- | --- | --- |
| 2024 | ✓ | — | ✓ |
| 2025 | ✓ | ✓ | — |

Filtering rows on `season_type == "REG"` **silently discards 100% of 2024** and produces a
clean-looking result built from nothing. `game_type` is present in both and is what
`lib/nfl/injuries.ts` filters on. The adapter asserts a non-zero regular-season row count
per season, so the same mistake fails loudly next time.

Regular-season rows: 2024 → 5,954; 2025 → 5,783.

| Season | none | questionable | out | doubtful | unrecognised |
| --- | --- | --- | --- | --- | --- |
| 2024 | 3,203 | 1,464 | 1,091 | 190 | `"Note"` ×6 |
| 2025 | 3,107 | 1,215 | 1,356 | 105 | none |

`none` means the player is on the report — usually with a practice limitation — but carries
no game designation. That is not the same as being absent from the report, and conflating
the two puts every healthy player in the same bucket as everyone listed and cleared.
Unrecognised values are **counted, never coerced**: upstream ships a literal `Note` in both
status columns, and folding that into "no designation" is how a new status value would go
unnoticed for a season.

**Fields contain newlines.** 48 records in the 2024 file carry a `practice_status` of
`"\n    "` — a quoted field spanning lines. Splitting the file on newlines shifts every
column after it and the row still looks plausible. `lib/nfl/csv.ts` handles it, and two such
records are in the fixture — the assertion that would catch a shift is on the column *after*
the newline, not on the field itself.

#### The leakage question, answered

The injury *report* is published before kickoff by nature. But this release is **assembled
after the fact**, so "the report existed before the game" and "the row we can read was
written before the game" are different claims, and only the second is checkable.

Where `date_modified` exists, it checks out. Joining every 2024 regular-season row to its
game's kickoff — converting `gameday`/`gametime` from US Eastern, which spans the
daylight-saving changeover, so a naive `Z` suffix would shift every kickoff by four or five
hours and could invert this result:

| | 2024 |
| --- | --- |
| Rows joined to a kickoff | 5,954 of 5,954 |
| Modified **before** kickoff | 5,953 (**99.98%**) |
| Modified after kickoff | 1 (0.02%) |
| Hours before kickoff | min −2.9, median **47.1**, max 103.4 |

A median of 47 hours is Friday for a Sunday game, which is exactly when the NFL mandates the
final injury report. The single exception is one `Out` designation on the Thursday-night
opener, edited about three hours after kickoff — plausibly a post-game correction.

`ruledOutForWeek` in `lib/nfl/injuries.ts` is the one consumer in the product today:
`projectWeek` skips any player designated `Out` for the week being projected. That is a
correctness guard rather than a model feature — see the honesty ledger — and it is
deliberately confined to `Out`.

**Verdict, scoped to what was measured: in 2024, 5,953 of 5,954 regular-season rows were
written before their game. That is the only season this can be checked on, and the finding
is about those rows — not about "the injury reports" in general.** On that evidence the
family is usable for projections, with the exception counted rather than rounded away.

**The caveat that must not be dropped: 2025 has no `date_modified` at all**, so this check
cannot be run on the holdout season. The claim there rests on inference — same upstream
release, same NFL reporting mandate, and 2024 verifying at 99.98% — and inference is not
verification. Any hypothesis that uses this data on 2025 must say so in those words rather
than presenting the season as checked.

### 1.2e Weekly rosters — the only pre-kickoff team source

```text
{base}/weekly_rosters/roster_weekly_{SEASON}.csv
```

Verified 2026-08-06. Available from 2002; `roster_weekly_2026.csv` is present and populated
with 2,930 rows.

Keyed on `gsis_id` + `week`, so it joins directly to `stats_player_week` — no bridge needed.
It also carries `birth_date`, `years_exp` and `pfr_id`, independently corroborating the
player directory.

**This is the only source that answers "which team is this player on?" before a game has
been played.** Everything else derives a team from an appearance, which works from week 2
onward and is useless in the days before week 1 — exactly the window a user wants a
projection. The 2025 file has 46,849 rows, of which 44,697 are regular season.

Status codes, measured on 2025:

| Code | Rows | Mapped to |
| --- | --- | --- |
| `ACT` | 27,377 | `active` — the only projectable state |
| `DEV` | 8,783 | `practice-squad` |
| `RES` | 5,763 | `reserve` |
| `INA` | 3,593 | `inactive` |
| `CUT` | 951 | `cut` |
| `RET` | 361 | `retired` |
| `EXE` | 7 | `reserve` |
| `TRD` / `TRC` | 7 each | `traded` |

All nine are mapped explicitly. An unrecognised code becomes `unknown` and is **counted**,
never folded into `active` — a new code read as active would put a practice-squad or
injured-reserve player on a board as though he were starting, and the board would look
entirely normal. Equally, every code upstream actually ships is mapped, because a drift
counter that fires on normal data stops being read.

**29 rows carry no `gsis_id`** and are dropped; that branch is live, not defensive.

The adapter refuses two shapes: a season that parsed to no regular-season rows, and one that
parsed rows in which *nobody* is active. The second is the payload-level failure a row count
cannot see, and it is the same guard the injury seam carries for the same reason.

### 1.3 CSV parsing hazard

Fields are quoted and **contain commas** — `headshot_url` holds values like
`.../upload/f_auto,q_auto/league/...`. Splitting on `,` shifts every downstream column and
corrupts the parse silently. This was observed in practice during verification. A
real RFC 4180 parser is mandatory; naive `String.split(",")` is a defect.

### 1.4 Team abbreviations

The 32 team codes present in 2025 are:

```text
ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB  HOU IND JAX KC
LA  LAC LV  MIA MIN NE  NO  NYG NYJ PHI PIT SEA SF  TB  TEN WAS
```

Note `LA`, not `LAR`. Historical seasons additionally use `OAK` (now `LV`), `SD` (now
`LAC`), and `STL` (now `LA`). Normalization must map these to the current codes.

## 2. ESPN public site API — supplementary

Works, unauthenticated, returns JSON:

- `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
- `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams`

Useful for logos, live game state, and display metadata. Not required by the model.

## 3. ESPN fantasy league API — NO WORKING HOST

This is a hard constraint on the product, not a temporary outage.

| Host | Result |
| --- | --- |
| `lm.espn.com` | NXDOMAIN (public DNS, 8.8.8.8) |
| `lm-api-reads.espn.com` | NXDOMAIN (public DNS, 8.8.8.8) |
| `fantasy.espn.com/apis/v3/...` | 302 → HTML page, not JSON |
| `site.web.api.espn.com/apis/v3/...` | 404 |
| `sports.core.api.espn.com/apis/v3/...` | 403 |

The previous implementation targeted `lm.espn.com`, a host that does not resolve, so its
league import could never have worked.

**Design consequence.** ESPN league import cannot be the guaranteed onboarding path. The
`LeagueProvider` seam in `lib/core/providers.ts` is where such an adapter would go, and it
carries an `isAvailable()` so a provider can report "unavailable" rather than throw — but
**no ESPN adapter is implemented**, because there is no host to point one at. The
projections product works with no league connected at all, which is what makes that
acceptable. Roster input is covered by `lib/nfl/lineup-csv.ts` and `leagues.setRoster`,
both implemented and tested, though neither is wired to a screen yet — see the known gaps
in the README.

## 4. Seasonal state

The current date is in the **2026 offseason**: `stats_player_week_2026.csv` returns 404 and
no 2026 game has been played. The most recent season with complete statistics is **2025**.

Application defaults must therefore resolve "current season" from data availability rather
than from the wall clock, and the UI must present an offseason state honestly instead of
rendering an empty current week. See `lib/nfl/season.ts`.

## 5. Draft data

Verified by direct request on 2026-07-31.

### Average draft position — Fantasy Football Calculator

```text
https://fantasyfootballcalculator.com/api/v1/adp/{ppr|half-ppr|standard}?teams={n}&year={season}
```

Public, unauthenticated, JSON. The 2026 PPR/12-team board returns **247 players**, each
carrying `adp`, `stdev`, `high`, `low`, `times_drafted`, and `bye`.

Not all 247 reach our board with a price: the deployment recorded in the README counted
**244**. A published ADP has to join to a roster player by name *and* position before it
can be priced, and `buildMarketIndex` refuses a name it cannot separate — two players who
normalize the same way and share a position are both dropped rather than one of them
guessed at. The three-player difference has not been attributed to specific names; it is
recorded here as a difference rather than explained, because the run that produced 244 is
not one this repository can reproduce offline.

The standard deviation is the reason this source was chosen over the alternatives. Without
dispersion, ADP reads as a deadline, and a draft strategy built on a deadline reaches for
players who would have lasted another full round. `lib/core/draft.ts` turns `adp` and
`stdev` into a survival probability directly.

Two hazards, both handled in `lib/sources/adp.ts` and covered by tests:

- **A season with no board returns HTTP 200 with `{"status":"Error"}`**, not a 404.
  Reading that as success produces a board where every player is unranked and every
  survival probability is 1. Confirmed: `year=2025` and `year=2031` both answer this way.
- **Our ruleset id `half_ppr` is spelled `half-ppr` upstream.** Sending our spelling
  returns the PPR board rather than an error.

Availability by season, confirmed by request: 2021 (211 players), 2022 (157), 2023 (202),
2024 (205 PPR / 180 standard), **2025 — none**, 2026 (247). The 2025 gap is why the
backtest evaluates on 2024.

### Live draft state — Sleeper

```text
https://api.sleeper.app/v1/draft/{draft_id}
https://api.sleeper.app/v1/draft/{draft_id}/picks
https://api.sleeper.app/v1/state/nfl
```

Public and unauthenticated. `/v1/state/nfl` confirmed live, reporting the 2026 preseason
with a season start of 2026-08-06.

**Partially verified.** The endpoints are reachable and an unknown draft id was confirmed
to return HTTP 200 with the body `null` rather than a 404 — a real hazard, since parsing
`null` as an object surfaces as a confusing shape error. But **no live draft payload was
captured**, because that needs an in-progress draft with a known id. The field names in
`lib/sources/sleeper.ts` come from Sleeper's documentation, not from observation, exactly
as with the Clerk webhook in section 6.

The parsers are written so that being wrong about the shape degrades rather than misfires:
a pick with no usable name or no overall number is skipped rather than guessed at, and
missing settings fail the call instead of defaulting to invented league dimensions.

### Players dump — Sleeper (market-awareness signal, NOT a price)

```text
https://api.sleeper.app/v1/players/nfl
```

Public, unauthenticated, one JSON object keyed by Sleeper's player id. **Verified by
direct request 2026-08-18**: HTTP 200, ~14.6 MB, 12,221 entries, every entry an object.
The fields `lib/sources/sleeper.ts` reads — `full_name`, `first_name`/`last_name`,
`position`, `fantasy_positions`, `team`, `search_rank`, `depth_chart_position`,
`depth_chart_order`, `years_exp` — were all observed in the live payload, unlike the draft endpoints
above, whose shapes come from documentation.

**Nothing in the product reads this dump.** It is the seam and the measurement only, in
exactly the sense the snap-count row of the README's honesty ledger uses those words.
The market-discipline gate (`applyMarketGate`, `lib/core/draft-policy.ts`) keys on the
**board's own `adp` field** and on nothing else — deliberately, because the board's
10-team prices are derived by rescaling a 12-team list, so any re-fetched external list
measures a different universe than the engine sees. What this dump supplies is the
evidence for the gate's premise: that the players the board leaves unpriced are ones a
deeper source does know about, at ranks nowhere near the rounds the model was leading
them in. The market-awareness join is exercised by `pnpm verify-sources` and its tests;
`pnpm identity-coverage` separately measures the player-identity seam below.

### Draft player-identity coverage

`pnpm identity-coverage` measures the deterministic provider-to-board classifier used by
live-pick integration work. It prints matched, ambiguous, and unmatched counts for both the
current public production board and the freshly fetched Sleeper player universe, including
rookies and every unresolved identity. The command fetches the Sleeper dump and the matching
nflverse season roster afresh, writing inspection copies under `.cache/identity-coverage` but
never reading a cache as though it were current data. Pass `-- --board path/to/board.json` to
audit an exported snapshot instead; the source provenance printed by the command is part of the
result.

The reported board snapshot is only clean when the command prints `identity coverage status:
clean`. Any ambiguous or unmatched row remains explicit and needs an append-only operator
repair; it is not silently guessed, dropped, or treated as a completed draft.

The audit's culprits, re-measured 2026-08-18: Kenny Gainwell rank **86**, RB2 — spelled
"Kenneth" on our board, which is why the join needs the first-name aliases in
`lib/nfl/draft/match.ts`; Colby Parkinson rank 136, TE2; Troy Franklin rank 171, depth
`SWR` 3. Kyle Pitts sits at rank 68, TE1, and is **not** one of them: the frozen board
prices him at ADP 81.7, so the join skips him along with every other priced row. He is
the coverage-cap evidence #90 raised and #89's own correction comment settled, not a
market-absent leader.

Measured coverage, reproduced by `pnpm verify-sources` through the shipped parser and
join rather than a side-channel script:

| | measured 2026-08-18 |
|---|---|
| entries in the payload | 12,221 |
| rows the parser accepts | 11,981 (240 have no usable name or position) |
| skill rows (QB/RB/WR/TE by *fantasy* position) | 4,144 |
| …carrying a meaningful `search_rank` **and** a team | **837** |
| …of those, also a `depth_chart_order` | 695 |
| skill rows with no usable rank at all | 2,373 |
| price feed the same day | 221 rows, **185** of them skill |
| frozen audit board | 587 skill rows, **403** unpriced |
| joined by `joinMarketAwareness` | **397** (361 with a meaningful rank) |
| refused as ambiguous | 2 — Kyle Williams, Jacoby Jones |
| unmatched, listed not dropped | 4 — Bam Knight, Jack Westover, Ben VanSumeren, Brady Russell |

**These figures drift daily and are meant to.** `search_rank` is a live search-relevance
ordering: the ranked-and-teamed count moved from 835 to 837 between two runs an hour
apart on the day above, and the payload's byte count moved with it. The date stamp is
what makes the table honest, and `pnpm verify-sources` is how a reader re-measures rather
than trusts. What must not move is the shape — the check fails outright if the join
answers for under half the unpriced board, because that is a broken matcher rather than a
busy offseason. #90 recorded 431 vs 187 on 2026-08-17; the difference from 837 vs 185 is
recorded here as a difference, not explained, since no threshold definition reproduces
431 from the payloads since.

Of the 397 joined rows, 29 are spelled differently by the two sources. Suffix and
punctuation folding bridges most of them (`Michael Penix Jr.` against `Michael Penix`);
the residue that normalization alone cannot bridge is the eight first-name pairs in
`FIRST_NAME_ALIASES`, each one added because it was measured missing rather than
imagined.

Three hazards, all load-bearing:

- **`search_rank` is a search-relevance ordering, not an ADP.** Rank 86 does not mean
  pick 86. It must never reach `fitAdpCurve` or any other pricing path, and no interface
  label may call it a market price — `lib/nfl/draft/market-awareness.test.ts` walks every
  deployable file that calls the curve fit and asserts none of them can see a search
  rank.
- **The sentinel is 9,999,999, not a missing field.** Read as a number it sorts as "the
  9,999,999th most relevant player", which looks like information and is the absence of
  it; the parser folds it to `null`.
- **`position` is the roster position, not the fantasy one.** Kyle Juszczyk is
  `position: "FB"` with `fantasy_positions: ["RB"]`, and reading the roster code drops
  him (rank 410) from a skill join. The parser prefers `fantasy_positions[0]`.
  `depth_chart_position` is likewise a slot code (`SWR`, `LWR`), not our position set.

### Rosters — nflverse

```text
https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{season}.csv
https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{season}.csv
```

`roster_2026.csv` confirmed present and populated: **2,930 players across all 32 teams**,
carrying `position`, `status` (`ACT`, `RET`, and others), and `gsis_id`, which is the same
identifier `stats_player_week` uses as `player_id`.

For the draft identity bridge, verified by direct request and this repository's
`parseSeasonRoster` on **2026-09-01**: the 1,695 active rows with usable `gsis_id` contain
`sleeper_id` on 1,264 rows (74.6%) and a positive integer `rookie_year` on all 1,695 (100.0%).
The parser maps a blank `sleeper_id` to `null`; it maps blank, non-numeric, or non-positive
`rookie_year` to `null`. Thus this release supplies a stable provider-ID bridge where it is
published and a season-based rookie flag where it is populated, without inventing either
missing value.

This is the release the README's week-1 known gap names as the fix. It resolves a player's
team before any game has been played, which is exactly what a preseason draft board needs
and what the in-season projection path currently cannot do.

### ESPN — still unusable

Re-checked on 2026-07-31. `lm-api-reads.espn.com` and `lm.espn.com` remain **NXDOMAIN** on
public DNS; `curl` fails with "Could not resolve host". Nothing has changed since section 3.

## 6. Clerk billing webhook — NOT verified by observation

Every other source in this document was confirmed by direct request. This one was not, and
the distinction matters enough to state rather than blur.

`convex/http.ts` parses Clerk subscription events without a captured payload to check
against. No webhook delivery is recorded here, and there is no fixture. The field names it
probes — `data.plan.{slug,key,name}`, `data.items[].plan.*`, `data.items[].status`,
`data.items[].period_start` / `period_end`, `data.primary_email_address_id` — are taken
from Clerk's documentation and from the shapes the tests in `convex/tests/http.test.ts`
encode. Clerk marks `period_end` optional on a subscription item; whether it omits
`period_start`, or sends `0`, or sends the future switchover date for a scheduled item, is
**not established**.

The parsers are therefore written so that being wrong about the shape degrades rather than
misfires:

- Plan selection is tiered. The period only discriminates *among* items whose status is
  plausibly live, so an unfamiliar or absent period cannot promote a scheduled or finished
  item over the current one. With no usable status and no usable period, it falls back to
  `items[0]` — the behavior that predates any of this.
- Zero and negative timestamps are read as absent, not as 1970.
- An unrecognized or absent status makes the whole event uninformative: `applyClerkEvent`
  writes no subscription state at all and records an audit row. A payload we cannot parse
  cannot revoke a paying subscriber.
- An unrecognized plan key resolves to free and is audited; an absent one leaves the
  recorded plan untouched.

**What would close this.** Capture one real delivery of each of `subscription.created`,
`subscription.updated` (including a scheduled plan change and a cancel-at-period-end), and
`subscriptionItem.updated` from a Clerk test instance, record the shapes here, and turn
them into fixtures. Until that exists, treat the item-selection logic as defensive
inference, not as a verified integration.
