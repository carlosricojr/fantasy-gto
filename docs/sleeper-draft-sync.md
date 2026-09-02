# Sleeper draft sync

The draft board can connect to a public Sleeper draft ID. The connection is deliberately
an exact import, not a best-effort setup guess.

## Supported setup

The board imports only a snake draft whose team count, round count, roster slots, and
scoring identity exactly match a shipped board setup. Sleeper's `ppr`, `half_ppr`, and
`standard` identities map to the matching local scoring IDs. Sleeper roster slots map only
when their counts and rounds select one existing roster template; this includes Standard
and two FLEX when every slot agrees. The adapter exposes the provider timer, draft/league
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
