# Private weekly decision journal

The journal freezes the imported roster, current starters, supplied estimates, scoring identity, source limitations, comparison choices, and recomputed recommendation. Receipt time is assigned by the server. Inputs remain explicitly **user supplied**: a server timestamp proves when the app received them, not that forecasts or league state were independently authenticated.

The baseline is the starting lineup present when the decision was recorded. Evaluation scores those two frozen lineups; it never optimizes after seeing the results. Unpriced held slots are excluded from both totals. A positive realized difference describes this decision only, not a proven forecasting or championship advantage. Multiple records for the same week are revisions, not independent trials; no aggregate performance claim is made.

Records after a compared player's listed kickoff remain history, but cannot qualify for prospective evaluation. Actual-source kickoff context is checked independently before evaluation, including schedule changes. Missing kickoffs, missing player scores, and unfinished periods stay pending; missing never means zero. Signed final values are preserved.

## Read-only observed outcomes

The documented [Sleeper matchup endpoint](https://docs.sleeper.com/#getting-matchups-in-a-league) is used with runtime validation of its optional `players_points` map. This field is present in the league's 2026 week-1 payload (checked 2026-09-09), but is not promised by the documentation example. If it disappears, no player outcome is invented from a team total. There is no call to an undocumented statistics or projections endpoint.

Current league/scoring and roster ownership must still match. Commissioner-adjusted team totals are not evaluated as player-level scores. Player team/week identity and kickoff are recovered independently through nflverse season identity, weekly roster, and schedule data. Missing or malformed schedule times stay unknown, never an invented midnight. Completion requires posted game results **and** Sleeper moving past the regular-season leg, into postseason, or into a later season. This includes week 18 and intentionally delays evaluation beyond live games; later stat corrections are new observations, not edits to the original recommendation. A dropped player absent from all matchup score maps remains missing. Outcome tracking is limited to prospectively saved 2026-and-later records; it does not read the reserved 2025 holdout.

Forecast errors are separated by model, manual, and unspecified origin. Conditional-on-active and partial-scoring model estimates are excluded from ordinary full-score accuracy. The original limitations remain attached even when the frozen lineup's realized comparison can be computed.

## Verification

Pure tests cover bounded input parsing, original-versus-recommended comparison, no hindsight selection, signed outcomes, zero versus missing, independent timing, excluded slots, scoring identity, consent, source failures, and model/manual error separation. This workflow release separately tests authenticated ownership, server timestamps, append-only/idempotent recording, changed-payload request-ID rejection, bounded reads, entitlement expiry, atomic request quotas and concurrent observation throttling. Deleted accounts lose access immediately; bounded internal batches erase their decisions, observations (including orphans), connections and usage counters without affecting other users. UTF-8 payload caps bound record and observation read costs. No lineup changes or platform transactions are submitted.

Development deployment and anonymous rejection smoke are verified. Signed-in production save/list/detail/outcome-refresh remains a release check requiring the owner's actual authenticated session; no synthetic subscription or account grants were used. The journal is Pro-only under the existing subscription-derived policy. See [weekly source access](weekly-lineup.md#source-access-and-bounded-compute) for quotas and remaining infrastructure limits.
