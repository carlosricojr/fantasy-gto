# Data Sources (verified)

Every fact in this document was verified by direct HTTP request on 2026-07-30. Treat it as
authoritative: it supersedes any recollection of these APIs. Re-verify before changing an
endpoint, and update this file in the same commit.

All primary sources are **free and unauthenticated**. The product requires no paid data
vendor to produce a projection.

## 1. nflverse — primary statistical source

Public GitHub release assets. No API key, no rate limit of practical concern.

Base: `https://github.com/nflverse/nflverse-data/releases/download`

### 1.1 Weekly player stats (the core table)

```
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

```
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

### 1.3 CSV parsing hazard

Fields are quoted and **contain commas** — `headshot_url` holds values like
`.../upload/f_auto,q_auto/league/...`. Splitting on `,` shifts every downstream column and
corrupts the parse silently. This was observed in practice during verification. A
real RFC 4180 parser is mandatory; naive `String.split(",")` is a defect.

### 1.4 Team abbreviations

The 32 team codes present in 2025 are:

```
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

**Design consequence.** ESPN league import cannot be the guaranteed onboarding path. It is
implemented as an optional adapter behind an interface, with a configurable base URL so it
can be pointed at a working host or proxy if one becomes available, and it must degrade to
a clear "unavailable" state rather than throwing. The guaranteed roster-input paths are CSV
upload and manual entry, and the projections product works with no league connected at all.

## 4. Seasonal state

The current date is in the **2026 offseason**: `stats_player_week_2026.csv` returns 404 and
no 2026 game has been played. The most recent season with complete statistics is **2025**.

Application defaults must therefore resolve "current season" from data availability rather
than from the wall clock, and the UI must present an offseason state honestly instead of
rendering an empty current week. See `lib/nfl/season.ts`.
