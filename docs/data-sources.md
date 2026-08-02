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

### Rosters — nflverse

```text
https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_{season}.csv
https://github.com/nflverse/nflverse-data/releases/download/weekly_rosters/roster_weekly_{season}.csv
```

`roster_2026.csv` confirmed present and populated: **2,930 players across all 32 teams**,
carrying `position`, `status` (`ACT`, `RET`, and others), and `gsis_id`, which is the same
identifier `stats_player_week` uses as `player_id`.

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
  `items[0]` — the behaviour that predates any of this.
- Zero and negative timestamps are read as absent, not as 1970.
- An unrecognised or absent status makes the whole event uninformative: `applyClerkEvent`
  writes no subscription state at all and records an audit row. A payload we cannot parse
  cannot revoke a paying subscriber.
- An unrecognised plan key resolves to free and is audited; an absent one leaves the
  recorded plan untouched.

**What would close this.** Capture one real delivery of each of `subscription.created`,
`subscription.updated` (including a scheduled plan change and a cancel-at-period-end), and
`subscriptionItem.updated` from a Clerk test instance, record the shapes here, and turn
them into fixtures. Until that exists, treat the item-selection logic as defensive
inference, not as a verified integration.
