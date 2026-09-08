# Sleeper draft sync

The draft board can connect to a public Sleeper draft ID. The connection is deliberately
an exact import, not a best-effort setup guess.

## Supported setup

The board imports only a snake draft whose team count, round count, starter slots, and
offensive scoring the board can represent. For a league draft, the adapter also reads
`/v1/league/{league_id}` and compares `scoring_settings` against the local coefficients.
The draft's `ppr`, `half_ppr`, or `standard` label alone is not verification: six-point
passing touchdowns, reception bonuses, and other unmodeled nonzero player scoring block
import. Missing or unreadable league rules fail closed. Standalone mocks have no league
endpoint and retain their declared preset; that is not verified league scoring.
Sleeper starter slots map only
when their counts select one existing roster template; bench length remains exact through
the independently imported round count. Ordinary draft-room controls such as the provider
clock, auto-start, sorting, and pause window are retained as source evidence but do not block
an otherwise exact league. The adapter exposes the provider timer, draft/league
IDs, draft order, and raw roster slots for the current import. The persisted sync state
stores only the draft ID, provider status, browser receipt time, provider picks, and repairs.

Linear and auction drafts, custom or missing scoring, unknown or custom roster slots,
unsupported settings, and unsupported league sizes are listed to the user and block setup
import. They never select a nearby local preset. Keeper flags are retained as provider
history only; this feature does not model keeper cost semantics, custom scoring, auction,
ownership, archives, or multiple draft sessions.

## Identity and reconciliation

Every provider pick is kept as source history. It is classified through #60's exported
`classifyProviderPicks`, then any append-only operator repair is replayed through #60's
`applyIdentityRepairs`. This PR does not alter those matching heuristics.

Each pick is therefore visibly matched, ambiguous, or unmatched. Ambiguous and unmatched
picks remain in the repair list until an operator selects a board player. A provider/local
disagreement is retained as a conflict; neither side overwrites the other. The operator may
explicitly use the provider's resolved board match, while retaining local state otherwise.

Whole-list polls merge into append-only source history by provider event key. Repeated and
out-of-order polls do not duplicate or reorder accepted history. A changed event, duplicate
overall pick, invalid provider coordinate, rejected repair, unresolved identity, or local
disagreement prevents a clean completion.

## Polling and recovery

Polling lives in `lib/sources/sleeper.ts`; reconciliation is pure in
`lib/nfl/draft/sleeper-sync.ts`. Successful polls run every 4 seconds. Failures retry after
2, 4, 8, 16, then at most 30 seconds. The browser shows the safe provider error and a Retry
now control. A poll handle is cancelled on unmount, reconnect, reset, or an abort signal.

Polling stops automatically only after Sleeper reports `complete` and the expected pick
count, identity resolution, rejected-repair state, and reconciliation conflicts all agree.
A provider-complete draft with unresolved identities is explicitly not clean and continues
to expose its repair path.

Local picks and the connected provider history are saved in session storage, so a reload or
same-tab sign-in redirect does not discard a draft when Sleeper is unavailable. To roll back
an in-progress connection, use Reset draft; it clears the local board and the saved Sleeper
connection. A provider outage never clears locally saved draft state.

## Advice readiness

Recording history and recommending a pick are separate contracts. Recommendations pause
until the first successful poll in the current browser session, even when a saved draft
contains an earlier receipt timestamp. They also pause on provider errors, unresolved
identities, rejected repairs, conflicts, gaps before a later non-keeper pick, changed setup,
or a snapshot that removes/replaces an observed pick. The saved board is preserved; a
rollback requires operator verification, not silent history deletion. A subsequent valid
snapshot resumes advice automatically. A genuinely removed pick currently requires a
reset/reconnect after saving any manual corrections; there is no automatic undo acceptance.

After 20 seconds without a successful poll (five normal poll intervals), an independent
browser timer pauses advice even if no new event or error arrives. This is an operational
guard, not a guarantee of event-time freshness: Sleeper can still serve a lagging response.
Clean completion does not require polling forever. Pausing clears old recommendation
replies, so a delayed worker answer cannot reappear as advice for a recovered board.

Kicker/DST rules, actual playoff settings, and other unmodeled league details still limit
title estimates. The offensive compatibility check can reject ordinary platform rules
that this model does not score, such as individual fumble-recovery touchdowns; it does
not silently ignore them or claim every Sleeper league is supported.
