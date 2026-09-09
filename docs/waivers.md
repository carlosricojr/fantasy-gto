# One-week waiver comparison

`/waivers` is a personal, read-only comparison of **one addition and one drop** for
Sleeper's current regular-season week. It does not submit adds, drops or bids. The
narrow `waiver_comparison` entitlement is authorized on the server before source I/O;
FAAB is not implemented and the bundled `waivers_faab` capability remains disabled.
The authorization endpoint is `personalTools:authorizeWaiverComparison`, deployed
with the personal-tools backend. Missing authorization/deployment fails closed.
That same backend action applies a shared, server-clock per-user request allowance
before any source reads: 6 calls per fixed 15-minute window and 30 per UTC day.
Discovery and comparison each consume one admission; failed upstream attempts still
count. Denial returns HTTP 429 and clears the prior pool/comparison. The client cannot grant itself
an entitlement or bypass admission, and this route has no separate in-memory limiter.

## Saved-team handoff

My leagues links each saved connection directly to `/waivers` with its exact league
and manager IDs. The waiver page also lists the authenticated account's saved teams
and offers the existing username/league-link finder. Selection and URL navigation do
not fetch sources. Repeated identity parameters are ignored rather than choosing one.
An omitted week is resolved through the existing authorized connection lookup on the
next Load click; that lookup must confirm the same league and manager. It consumes a
connection-lookup allowance in addition to the waiver discovery allowance. No week-1
default, account grant, new saved record or platform transaction is created.

The existing private-data gate waits for app authentication and provisioning before
mounting saved-team queries. Authenticated Free users see the Pro access explanation,
not another sign-in prompt. Account changes unmount old inputs; changing team clears
selection, search and both consents. Superseded source responses are discarded.

## Objective and scope

The baseline is `planWeeklyLineup(currentRoster)`, not the existing starter arrangement.
For each selected, usable addition and each usable active-roster drop, the tool solves
the changed roster again and subtracts the baseline's included lineup total in cents.
A redundant high-projected QB can therefore have zero marginal value while a lower
projected RB improves an open RB/FLEX assignment. Keeping the roster is a zero-gain
alternative; zero/negative comparisons say no positive included gain, and missing
comparisons say unknown rather than treating missing values as zero.

This is **not** season-long player/drop valuation. Future production, keeper value,
bench depth, opponent blocking, acquisition probabilities, waiver clearance/priority,
FAAB and transaction deadlines are not optimized. A drop that costs no included
points this week may be extremely costly later. Equal one-week deltas do not establish
equivalent drops. Results are estimates, not a guarantee of actual improvement.

## Membership, eligibility and locks

The documented league endpoint supplies `total_rosters`, season, roster slots and exact
scoring. Every league roster must be present with unique roster IDs and parseable
player/reserve/taxi arrays. A null reserve/taxi is the observed empty form; missing
reserve is not accepted, and missing taxi is accepted only with explicitly zero taxi
slots. All ownership, including reserve/taxi IDs absent from `players`, is excluded
before directory/projection filtering. Cross-roster duplicate holdings, invalid starter
membership, missing opponents, wrong league, ambiguous user ownership, disabled adds,
pre-draft/drafting state and wrong current season/week block the entire import.

The searchable pool starts with named directory entries with supported fantasy eligibility
and an active/questionable/doubtful directory designation. It then requires evidence in
the exact season/week regular-season nflverse weekly roster CSV, joined by `sleeper_id`.
A unique active team/position is required; a traded/cut origin can coexist with its active
destination, but conflicting active teams, identities or positions are excluded. Defenses
require their team to appear among that week's active roster rows. No historical player
appearance, stale season row or absent status establishes current membership.

Malformed/unavailable/ineligible directory rows and missing/unknown, inactive and
conflicting NFL membership are counted separately. Empty or wrong-week source evidence
blocks discovery; it never falls back to the directory-only pool. The complete filtered
pool is returned without truncation, but is not claimed to cover the entire NFL: the
reported-team count and source URL remain visible. Directory data can be cached for a day,
and the weekly file has no trusted row-publication timestamp. Retrieval time is not
data freshness. An `ACT` roster row is not injury clearance and never clears a known
Sleeper injury restriction. Selected candidates and the user's roster then receive the
same current-team/game hydration and model gates as the weekly planner. Ownership,
directory eligibility and weekly membership are rechecked on every comparison.

Started or unknown kickoffs cannot be additions or drops. Started starters remain in
their recorded slot and started bench players remain benched. Reserve/taxi holdings
cannot be drops because they do not free an active-roster place. Known unavailable,
unpriced and conflicting-context players are not ranked as additions or drops.
Platform-specific claim clearance, protected-player/roster restrictions and pending
transactions are not proven by this read-only membership snapshot; verify those in
Sleeper before making any transaction. The tool does not claim every displayed pair
is immediately executable on the platform.

## Incomplete estimates

The existing free nflverse model is unchanged: current identity, team, injury, kickoff,
history and scoring gates still apply. K/DST and insufficient-history players remain
unpriced; supported custom offensive estimates can omit scoring terms and retain PPR
calibration caveats. Both sides use the same source/scoring context and data bytes.
Provider publication times remain unknown; calculation time is not source freshness.

Incomplete comparisons require explicit consent. Every unpriced rostered player is
held in place and excluded from the total; they may not be dropped. Every changed
lineup must retain the baseline's excluded player and slot sets. This prevents an
unpriced FLEX starter from being deleted to free a scored slot and manufacture a gain.
Missing injury-report conditional forecasts require a second, separate opt-in and
retain their active-at-kickoff assumption; they are not availability-adjusted estimates.
Ordinary projected coverage excludes these conditional values. Candidate-specific
warnings remain visible in each pair's expanded explanation.

## Budgets and freshness

The user searches an alphabetical pool and chooses up to **12 candidates**; search
ordering is neither ADP nor value. The tool supports at most **24 rostered players** and
**10 starting slots**, so at most **288 pairs** are solved. The UI shows the first 50
search matches and first 20 ranked pairs, explicitly naming those display limits.
Coverage reports pool size, selected/usable additions, usable drops, evaluated pairs
and unknown pairs. Unsearched candidates are not claimed inferior.

Discovery performs four documented Sleeper reads and one nflverse weekly-roster read.
A comparison uses those reads plus
one combined roster/candidate nflverse generation request (at most 36 identities,
below the generator's 100-ID limit). Per-request deduplication shares roster and
schedule bytes between hydration and modeling; the existing daily directory cache is
shared with the weekly planner. Individual source requests retain the existing
60-second fetch timeout; the route itself has a 60-second execution budget. A slow
provider may exceed that route budget and yield an error, never a partial ranking.

Pair assignment runs in a background worker with a 15-second calculation limit.
Changing candidates or context invalidates the prior result; changing consent restarts
the comparison and the old result is not displayed. Workers and timers are cleaned up
on supersession/unmount. The page checks time every second and on focus: results are
hidden at the next relevant kickoff or when full-league ownership reaches 15 minutes.
Refresh after any known transaction even inside that age window.

Waiver and connection GET requests use an explicit network-only service-worker rule
ahead of default caching. HTTP `no-store` alone is insufficient for Cache Storage.
Offline refreshes fail rather than reuse a previously cached ownership snapshot.

## Verification and limitations

Synthetic tests exercise strict opponent membership, reserve/taxi ownership, source
request budgets, authorization before source I/O, stale context, unpriced fixed scope,
kickoff locks, conditional consent, signed values and the optimized baseline. An
independent recursive assignment enumerator checks every add/drop pair over 24 small
heterogeneous synthetic scenarios; this verifies arithmetic/assignment, not projection
accuracy. The unchanged default backtest scores only development/tuning seasons; the
2025 holdout and published metrics are untouched.

A production-built service-worker transport regression fetched synthetic available
pools online, seeded older responses into the normal API cache, then disabled the
local transport. Both waiver and connection requests failed instead of returning the
cached pool; an unrelated API request returned its cache as a positive control. This
checks the actual built worker's routing, not authorization or live-source accuracy.

Historical directory-only operational check, **before the current-week membership
filter**, on **2026-09-09 around 20:31 UTC**: the requested 10-team
league contained 160 distinct holdings, 16 per roster. Its directory response contained
12,227 entries; 2,772 became unrostered directory candidates and 9,295 other unrostered
entries were excluded. A selected 12-name skill-player test produced 3 ordinary and 16
conditional forecasts across 28 requested roster/candidate identities. Seven additions
and 12 drops were usable, producing 84 comparable pairs and **no positive included-lineup
gain**. This is a scope/coverage check, not a waiver recommendation or accuracy result.
Combined source work took approximately 1.54 seconds and pair solving 19 milliseconds
on that run. A separate cold synthetic maximum-budget run (24 same-position players,
12 candidates, 10 interchangeable slots) solved 288 pairs in approximately 1.46 seconds
on this development machine. These are single-run observations, not mobile latency
guarantees or production service-level claims.

The September 9 workflow follow-up adds mounted signed-in synthetic tests for exact
saved-team handoff, current-week confirmation, ambiguous URL refusal, account-change
and in-flight cleanup, Free/signed-out gates, separate consents, and offline invalidation.
A local browser harness ran the real page, private gate and real comparison Web Worker
with explicitly mocked Clerk/Convex identity and source transport, using the production
build's CSS. It verified a 10-point baseline and +2 included-point addition, a separate
conditional +10 alternative only after consent and refresh, immediate removal when
disabled, and no result after an offline refresh. Desktop 1280px and mobile 390px layouts
were checked, with no horizontal overflow at 390px. This is local integration evidence,
not proof of real production sign-in, live forecast accuracy or optimal player discovery.

Source attribution: [Sleeper documented API](https://docs.sleeper.com/), personal
non-commercial use; [nflverse-data](https://github.com/nflverse/nflverse-data), CC BY 4.0.
No undocumented Sleeper projection endpoint or paid provider is called.
