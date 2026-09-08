# Sleeper draft sync

The draft board can connect to a public Sleeper draft ID. The connection is deliberately
an exact import, not a best-effort setup guess.

## Supported setup

The board imports only a snake draft whose team count, round count, starter slots, and
scoring the board can represent. For a league draft, the adapter also reads
`/v1/league/{league_id}` and compares `scoring_settings` against the local coefficients.
The draft's `ppr`, `half_ppr`, or `standard` label alone is not verification: six-point
passing touchdowns are handled by an exact custom profile, while unknown nonzero scoring
keys block import. Missing or unreadable league rules fail closed. Standalone mocks have no league
endpoint and retain their declared preset; that is not verified league scoring.
Sleeper starter slots map only
when their counts select one existing roster template; bench length remains exact through
the independently imported round count. Ordinary draft-room controls such as the provider
clock, auto-start, sorting, and pause window are retained as source evidence but do not block
an otherwise exact league. The adapter exposes the provider timer, draft/league
IDs, draft order, and raw roster slots for the current import. The persisted sync state
stores only the draft ID, provider status, browser receipt time, provider picks, and repairs.

Linear and auction drafts, unsupported or missing scoring, unknown or custom roster slots,
unsupported settings, and unsupported league sizes are listed to the user and block setup
import. They never select a nearby local preset. Keeper flags are retained as provider
history at their verified overall pick coordinates, including traded ownership. Keeper
costs are not optimized before assignment; auction, archives and multiple saved draft
sessions are not modeled.

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

League drafts now import the actual playoff field, final week, and additional median-game
setting. Imported season settings are checked on every poll, stored across reloads, and
included in both the source-verification and worker-reply fingerprints. A manual change
cannot leave advice computed for the prior season rules on screen. Standalone mocks
retain the manually selected season rules. Unsupported brackets, non-week-one starts,
best ball and automatic substitutions are rejected rather than approximated.

No title estimates are enabled for a custom league until its exact custom-scored board
and weekly distributions have been published. Catalog-only identities cannot enable
recommendations. Unknown nonzero scoring keys fail closed; this is not support for every
possible Sleeper rule.

The pure custom scorer in `lib/nfl/scoring/sleeper.ts` scores sparse *weekly stats*, including individual
special-teams events, distance-specific kicking, defensive forced fumbles/blocked kicks,
and Sleeper's own weekly points/yards-allowed tier indicators. Missing defensive tier
coverage or incomplete kicker distance splits throw. It must not be applied to Sleeper's
season projections, which omit required fields. Canonical nonzero coefficients form the
exact board identity; the ADP source remains separately labelled PPR/half-PPR/standard.

### Custom league simulation

League and predraft URLs resolve through the fixed public Sleeper API; arbitrary hosts
are never fetched. Custom scoring IDs round-trip through session storage with canonical
coefficient validation. A custom connection cannot use a preset board while its own board
loads. The UI labels custom-scored history and market provenance separately and does not
transfer the preset model's validation claims to this new path.

Custom K/DST weekly outcomes use an additive-normal distribution centered on each board
row's weekly mean, with a historical residual spread supplied by the board. This permits
negative points and preserves the expected mean. These positions are selected using their
pre-game mean before the signed score is revealed: selecting on realized scores would
silently bench every negative defense result. Normality is an explicit approximation,
not measured tail calibration. A negative pre-game expected score can still be benched;
negative realized scores from a selected positive-mean starter are never erased.

Custom QB/RB/WR/TE distributions use 100 equally weighted midpoint quantiles of measured
weekly-points / own-season-mean ratios, normalized to mean one. This preserves zero and
negative weeks without a pathological lognormal floor. Sampling is discrete, tails are
bounded by the quantile representation, and position-pooled ratios are not player-specific
forecasts. Custom skill starters are also chosen by their pre-game mean, not realized
outcomes. These choices are uncalibrated season-model assumptions. Preset rows retain
their prior lognormal and lineup behavior.

Sleeper permits drafting above the roster limit after pick trades, then requires cuts
([official rule](https://support.sleeper.com/en/articles/3956140-can-a-team-go-over-the-roster-limit)).
The rollout consumes every verified owned selection, keeps those players unavailable to
other drafters, then cuts overfull simulated rosters before the season. The cut policy
preserves mean-optimal starters and highest-value remaining depth. Underfull rosters are
not granted fictional extra draft picks; post-draft waiver acquisitions are not simulated.
Existing waiver-coverage fractions remain the disclosed streaming assumption, applied to
replacement levels derived from the custom board rather than preset points.

Initial custom-board provisioning is intentionally an operator action, not a public client
endpoint: a canonical profile causes 36 public historical-stat fetches and an arbitrary
profile/size must not let an unauthenticated browser create that work. Until an operator
publishes the exact shape, the connection stays paused rather than borrowing a preset
board. Bootstrap a verified import once with its canonical scoring ID and league size;
successful publication registers that public shape for later scheduled refreshes:

```sh
pnpm exec convex run --prod ingest:buildSleeperCustomDraftBoard \
  '{"season":2026,"scoringId":"sleeper-v1:{...canonical imported coefficients...}","teams":10}'
```

The placeholder is not a usable scoring ID: copy the exact canonical ID from the verified
Sleeper import. The build fails closed on incomplete history, ambiguous current market
matches, or missing required position coverage and leaves an older published board intact.

Run the read-only rehearsal against a published custom board:

```sh
pnpm exec tsx scripts/sleeper-rehearsal.ts <Sleeper-league-URL> <Sleeper-user-id>
```

It checks the exact scoring board, 32 defense identities, keeper resolution, traded
ownership, signed distributions, roster completion/cuts, normalized title probabilities,
and exclusion of drafted players from advice. It never sends a pick to Sleeper.
