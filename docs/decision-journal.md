# Private weekly decision journal

The journal freezes the imported roster, current starters, supplied estimates, scoring identity, source limitations, comparison choices, and recomputed recommendation. Receipt time is assigned by the server. Inputs remain explicitly **user supplied**: a server timestamp proves when the app received them, not that forecasts or league state were independently authenticated.

The baseline is the starting lineup present when the decision was recorded. Evaluation scores those two frozen lineups; it never optimizes after seeing the results. Unpriced held slots are excluded from both totals. A positive realized difference describes this decision only, not a proven forecasting or championship advantage. Multiple records for the same week are revisions, not independent trials; no aggregate performance claim is made.

Records after a compared player's listed kickoff remain history, but cannot qualify for prospective evaluation. Actual-source kickoff context is checked independently before evaluation, including schedule changes. Missing kickoffs, missing player scores, and unfinished periods stay pending; missing never means zero. Signed final values are preserved.

## Read-only observed outcomes

The documented [Sleeper matchup endpoint](https://docs.sleeper.com/#getting-matchups-in-a-league) is used with runtime validation of its optional `players_points` map. This field is present in the league's 2026 week-1 payload (checked 2026-09-09), but is not promised by the documentation example. If it disappears, no player outcome is invented from a team total. There is no call to an undocumented statistics or projections endpoint.

Current league/scoring and roster ownership must still match. Commissioner-adjusted team totals are not evaluated as player-level scores. Player team/week identity and kickoff are recovered independently through nflverse season identity, weekly roster, and schedule data. Completion requires posted game results **and** Sleeper moving past the week. This intentionally delays evaluation beyond live games; later stat corrections are new observations, not edits to the original recommendation. A dropped player absent from all matchup score maps remains missing. Outcome tracking is limited to prospectively saved 2026-and-later records; it does not read the reserved 2025 holdout.

Forecast errors are separated by model, manual, and unspecified origin. Conditional-on-active and partial-scoring model estimates are excluded from ordinary full-score accuracy. The original limitations remain attached even when the frozen lineup's realized comparison can be computed.

## Verification

Pure tests cover bounded input parsing, original-versus-recommended comparison, no hindsight selection, signed outcomes, zero versus missing, independent timing, excluded slots, scoring identity, consent, source failures, and model/manual error separation. Backend tests separately cover authenticated ownership, server timestamps, append-only/idempotent recording, bounded reads, and entitlement enforcement. No lineup changes or platform transactions are submitted.
