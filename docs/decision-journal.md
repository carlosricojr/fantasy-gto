# Private weekly decision journal

The foundation in PR #135 supplied pure record validation/evaluation and a read-only outcome adapter. This dependent workflow release adds the authenticated private backend, server receipt clock, saved-history UI and bounded retention. A caller-supplied clock alone is not evidence of server receipt.

The journal freezes the imported roster, current starters, supplied estimates, scoring identity, source limitations, comparison choices, and recomputed recommendation. Receipt time is assigned by the server. Inputs remain explicitly **user supplied**: a server timestamp proves when the app received them, not that forecasts or league state were independently authenticated.

The baseline is the starting lineup present when the decision was recorded. Evaluation scores those two frozen lineups; it never optimizes after seeing the results. Unpriced held slots are excluded from both totals. A positive realized difference describes this decision only, not a proven forecasting or championship advantage. Multiple records for the same week are revisions, not independent trials; no aggregate performance claim is made.

Records after a compared player's listed kickoff remain history, but cannot qualify for prospective evaluation. Actual-source kickoff context is checked independently before evaluation, including schedule changes. Missing kickoffs, missing player scores, and unfinished periods stay pending; missing never means zero. Signed final values are preserved.

## Read-only observed outcomes

The documented [Sleeper matchup endpoint](https://docs.sleeper.com/#getting-matchups-in-a-league) is used with runtime validation of its optional `players_points` map. This field is present in the league's 2026 week-1 payload (checked 2026-09-09), but is not promised by the documentation example. If it disappears, no player outcome is invented from a team total. There is no call to an undocumented statistics or projections endpoint.

Current league/scoring and roster ownership must still match. Commissioner-adjusted team totals are not evaluated as player-level scores. Player team/week identity and kickoff are recovered independently through nflverse season identity, weekly roster, and schedule data. Missing or malformed schedule times stay unknown, never an invented midnight. Completion requires posted game results **and** Sleeper moving past the regular-season leg, into postseason, or into a later season. This includes week 18 and intentionally delays evaluation beyond live games; later stat corrections are new observations, not edits to the original recommendation. A dropped player absent from all matchup score maps remains missing. Outcome tracking is limited to prospectively saved 2026-and-later records; it does not read the reserved 2025 holdout.

Forecast errors are separated by model, manual, and unspecified origin. Conditional-on-active and partial-scoring model estimates are excluded from ordinary full-score accuracy. The original limitations remain attached even when the frozen lineup's realized comparison can be computed.

### Experimental estimate provenance

The experimental extension freezes the independent `allowExperimentalEstimates`
choice alongside the existing conditional and incomplete-comparison preferences.
Each experimental estimate retains its version-1 method, active-at-kickoff assumption,
history count and timing, calibration label, scoring scope, excluded rules and evidence
tag. Returning-player frozen-model estimates and prior-season observed-game kicker
means are distinct methods, not ordinary model forecasts. New saves validate the
supported provenance shape and consent; malformed or unsupported metadata is rejected.

Experimental and unrecognized future origins are excluded from ordinary forecast-error
statistics, while the original snapshot and unevaluated count remain visible. A genuine
manual full-score override is evaluated as manual, not as a validated experimental
forecast. Legacy absent origins may be evaluated only in the separate unspecified-origin
error group; the recent-results report segregates nonnull absent/unknown origins in its
experimental-or-unrecognized cohort. None of these classifications establishes injury
clearance, complete custom scoring or forecast calibration.

## Verification

Pure tests cover bounded input parsing, original-versus-recommended comparison, no hindsight selection, signed outcomes, zero versus missing, independent timing, excluded slots, scoring identity, consent, source failures, and model/manual error separation. This workflow release separately tests authenticated ownership, server timestamps, append-only/idempotent recording, changed-payload request-ID rejection, bounded reads, entitlement expiry, atomic request quotas and concurrent observation throttling. Deleted accounts lose access immediately; bounded internal batches erase their decisions, observations (including orphans), connections and usage counters without affecting other users. UTF-8 payload caps bound record and observation read costs. No lineup changes or platform transactions are submitted.

Development deployment and anonymous rejection smoke are verified. On September 9, 2026, the owner's signed-in Arc session verified a real saved connection, weekly import, conditional incomplete-comparison consent, receipt-dated save, private detail, reload persistence, and a correctly pending server-side outcome observation. No synthetic subscription, forecast, actual score or account grant was used. The journal is Pro-only under the existing subscription-derived policy. See [weekly source access](weekly-lineup.md#source-access-and-bounded-compute) for quotas and remaining infrastructure limits.

## Recent descriptive results protocol

`recent-decisions-v1` adds an explicit review button to private history. It loads only
the newest server-ordered batch (at most 20 records; the backend byte cap may return
fewer), then at most two owner-scoped detail reads concurrently. There are at most
21 existing quota-admitted reads per click, no new endpoint, automatic scan, polling,
upstream results fetch, observation write, or client persistence. An unavailable or
failed detail aborts publication instead of reporting a selectively successful subset.
Both requests in a pair must settle before retry is enabled, including asymmetric failure.
The account-keyed history unmount invalidates pending responses and stops later batches.

Selection is fixed before looking at outcomes: for each league/team/season/week in
the batch, retain the latest receipt marked before all listed comparison kickoffs;
equal receipt times use lexical record ID. Older revisions and late/unknown-timing
records are counted, not treated as independent trials. The latest stored observation
supplies the result. An independently ineligible, pending, corrupt or missing latest
observation never causes fallback to an earlier successful recommendation. New stat
corrections replace the observation used by a reloaded report, not the frozen receipt.

The report separates no-declared-limitation, conditional/incomplete, and experimental
or unknown-origin cohorts. It shows completed comparison counts, distinct NFL weeks,
total and mean realized point difference against original starters, grouped separately
by league, team, season, exact scoring identity and limitation cohort; pending comparisons
do not become zero. Unknown or corrupt record formats are counted and withhold the
entire batch, because a corrupt receipt could be the newest revision of a valid context.
Each row names its summary group, whose team owner ID and exact scoring identity are
available in a disclosure. The first cohort is not a claim that user-supplied inputs were authenticated
or that the model is calibrated. Different scoring systems are not directly comparable.

This is a **descriptive recent-batch review**, not a preregistered efficacy trial, full
season report, forecast-accuracy benchmark, independent sample, or causal estimate.
Selective saving, correlated players/weeks, incomplete slots, source limitations and
varying league scoring remain important biases. It does not prove the user followed
the advice. No model weights, draft policy, historical holdout or published evaluation
metrics change. A future claim of superiority needs a separately frozen protocol,
complete prospective capture and appropriate independent baselines and uncertainty.

## Retained storage limits

Each owner may retain 500 decisions, each with at most 20 outcome observations.
Storage limits are enforced atomically, without scanning hundreds of large snapshots.
Existing identical request-ID retries remain valid at the decision cap. A record cap
does not silently delete old history; individual deletion, archive and export are not
implemented. Account erasure remains the separate privacy lifecycle.

An outcome refresh with unchanged player points, completion, kickoffs and evaluation
does not append another observation merely because retrieval time advanced. Original
timestamps stay unchanged. Genuine source corrections append until the 20-observation
cap; at the cap additional refreshes are refused before source I/O. Failed/unchanged
checks still consume the request allowance. These finite caps are not a promise that
every possible payload combination fits a hosting provider's free storage allowance.

If pre-release development records exist without their retained-count accounting,
new saves fail closed pending explicit accounting repair; they are not counted as zero
or removed. Production starts with additive new tables. Regression tests cover boundary
concurrency, cross-owner isolation, no automatic deletion and unchanged pending checks.
