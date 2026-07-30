# Fantasy GTO

Fantasy football projections that show their working, and lineups that are provably
optimal.

The projection model is backtested and its real accuracy is published, including where it
is weak. The lineup optimiser solves slot assignment exactly, so no legal arrangement of a
roster scores higher.

## Quick start

```bash
pnpm install
pnpm verify                # typecheck, lint, tests
pnpm backtest              # reproduce the published accuracy figures
pnpm backtest -- --sweeps  # reproduce how each parameter was chosen
pnpm dev                   # Next.js + Convex
```

`pnpm dev` needs a Convex deployment and Clerk keys in `.env.local`. `pnpm verify` and
`pnpm backtest` need neither — the domain core has no infrastructure dependencies, which
is deliberate.

### Seeding a deployment

A fresh deployment has no data, and both ingest actions are `internal` so no client can
trigger them. Populate it from the CLI:

```bash
npx convex dev --once                                 # push schema + functions
npx convex run ingest:syncSchedule '{"season":2025}'  # schedule + betting lines

# Projections. Pass every ruleset the interface offers, or the Half PPR and Standard
# toggles render an empty board — projectWeek defaults to PPR alone.
npx convex run ingest:projectWeek \
  '{"season":2025,"week":18,"scoringIds":["ppr","half_ppr","standard"]}'
```

Verified against a real deployment: the schedule sync writes 272 contests (a full regular
season) and the projection run writes 1,404 rows across three rulesets for week 18.

Project the week the interface will actually ask for. `season.current` resolves the
displayed week from the schedule, so during the offseason it reports the final week of the
last completed season — week 18 above — rather than an empty future one. The daily cron in
`convex/crons.ts` keeps things current once a season is under way, but it deliberately
does nothing during the offseason, so the first seed has to be run by hand.

## How it is put together

The organising rule is that **domain logic is pure and I/O lives at the edges**. Every
projection, score, and lineup decision is computed by a plain TypeScript function with no
network, database, clock, or framework dependency. That is what makes the model
backtestable against three seasons of real data and the optimiser exhaustively testable.

```
lib/core/            Sport-agnostic. Domain vocabulary, provider seams, lineup optimiser.
lib/nfl/             NFL domain: CSV parsing, teams, scoring, model, season logic.
lib/billing/         Entitlement derivation.
lib/sources/         The adapter layer. The only place in lib/ that performs I/O.
convex/              Thin orchestration over the pure core. Schema, queries, ingest, webhook.
app/                 Next.js App Router.
scripts/backtest.ts  The authority for every accuracy claim.
docs/                Verified data sources and model validation.
```

`lib/core`, `lib/nfl`, and `lib/billing` are pure — no `fetch`, no clock, no randomness, no
framework imports. That is not a convention; `lib/purity.test.ts` enforces it by scanning
the source. `lib/sources` is exempt because performing I/O is its entire job.

### Adapter seams

Three provider interfaces mark boundaries where a second implementation is genuinely
foreseeable — another sport's statistics, another fantasy platform, another source of
market prices. Each has exactly one implementation today. The value is in the seam being in
the right place, not in generic machinery built ahead of a second caller.

- `StatsProvider<TStatLine>` — historical production. The stat shape is a type parameter,
  so adding a sport cannot force edits to another sport's types.
- `MarketProvider` — schedule and betting lines. Already needed, since the model consumes
  the implied team total. This is also the seam a betting feature would plug into.
- `LeagueProvider` — a user's league and roster. Needed now, because ESPN's league API has
  no working host and CSV/manual entry has to carry the product.

The lineup optimiser lives in `lib/core` rather than under NFL because it is genuinely
sport-agnostic: a weighted assignment problem over eligible slots.

### Why no paid data vendor

The original plan budgeted for OddsAPI ($99/mo) and SportsDataIO ($299/mo). Neither is
needed. nflverse publishes weekly player statistics, and its schedule file carries Vegas
spread and total lines for future games alongside venue and weather. Everything the model
consumes is free and public. See [`docs/data-sources.md`](docs/data-sources.md), where every
endpoint was verified by direct request.

## Honesty ledger

Every claim the interface makes, and the computation behind it.

| Claim | Backed by |
| --- | --- |
| "2.59% better than a season-average baseline" | `pnpm backtest`, out-of-sample on 2025, n=3,037. Recorded in [`docs/model-validation.md`](docs/model-validation.md). |
| Projection floor and ceiling | Empirical 10th/90th percentiles of actual/projected, measured per position after calibration, **under PPR**. Other rulesets carry a visible caveat. |
| Contributions sum to the projection | True by construction — the mean is derived from the summed contributions — and asserted in tests. |
| "Provably optimal lineup" | Maximum-weight bipartite matching. Optimal by construction; tests include a roster where greedy loses 14 points. |
| Scoring correctness | Reproduces upstream's own `fantasy_points` and `fantasy_points_ppr` columns exactly on every offensive player-week in the fixture. |
| Residual bias of −0.63 points | Published on `/accuracy` rather than hidden. |

**Removed.** The previous version claimed "+8.2 points/week vs platform projections" and
"beats ESPN by ≥8% MAE". Neither had any computation behind it, and the measured model
cannot support them — the real edge over a strong baseline is 2.59%. Weekly fantasy scoring
is dominated by variance that no model built on public box-score data removes. The claims
were deleted rather than softened.

Any change to the model must re-run `pnpm backtest` and update `docs/model-validation.md`
in the same commit. A number that is not in that document may not appear in the interface.

## Entitlements

Access is a pure function of `(plan, subscription status, clock)`. There is no exported way
to grant a capability directly, so there is nothing for a client to call and nothing to
forge. Persisted rows are a read cache; privileged paths re-derive from stored subscription
state.

| | Free | Pro |
| --- | --- | --- |
| Projections, lineup optimiser | ✓ (no account needed) | ✓ |
| Start/sit advice | ✓ | ✓ |
| Leagues | 3 | **unlimited** |
| Everything else in the plan | — | *not built* |

**Pro's only implemented differentiator today is the league cap.** That is an uncomfortable
thing for a paid tier to admit, and it is what the code does. Every other capability named
in the plan is `false` in the entitlement table because nothing reads it:

- `accuracy_dashboard` — `/accuracy` is a public marketing page with no gate.
- `import_export` — `lib/nfl/lineup-csv.ts` is complete and tested, but no route imports it.
- `daily_refresh` — the cron rewrites shared projection rows and `projections.forWeek` is a
  public query with no staleness tier, so a free visitor reads the same fresh data. Billing
  for it would be charging for a difference that does not exist.
- `waivers_faab`, `dst_streamer`, `alerts`, `performance_history` — not built.

Each flips to `true` in the same change that implements it. `UNIMPLEMENTED_FEATURES` keeps
the list explicit, a test asserts none of them is granted, and `/pricing` renders both its
"included today" and "not built yet" columns from the same table the server authorises
against — so the page cannot promise more than the code delivers.

Free deliberately includes start/sit. A free tier that cannot answer "who do I start?"
cannot demonstrate value before asking for payment.

A failed payment keeps Pro for a 3-day grace period. A cancellation runs to the end of the
period already paid for. Unknown Clerk plan keys and statuses fail closed to free.

## Testing

```bash
pnpm test          # watch
pnpm test:run      # once
pnpm test:coverage
```

Tests are colocated with the code they cover. Fixtures under `tests/fixtures/` are
byte-exact slices of real upstream data, pinned with `.gitattributes` so line endings stay
stable across platforms and the parser's behaviour stays reproducible.

The suite deliberately contains no mocks of our own modules. The domain core is pure, so it
is tested with real values; the provider seams take an injectable fetcher, so adapters are
tested against fixtures rather than the network.

The suite runs as two projects. `domain` covers `lib/` in plain Node. `convex` runs the
actual Convex functions against an in-memory backend via `convex-test`, in the edge runtime.

That second project exists because the defects that made the original paywall unenforceable
were **not in the entitlement logic** — they were in the wiring. A client-callable action
granted access, and a webhook resolved its user from a session that does not exist in a
webhook. Unit-testing the pure resolver would have passed cleanly through both. So the
league cap, cross-user ownership, roster integrity, and the full billing lifecycle
(upgrade, cancellation, grace period, unknown plan key, replayed events) are tested against
real Convex functions with a real identity.

## Known gaps

Stated plainly rather than left to be discovered.

- **ESPN league import is not functional.** No working host exists — `lm.espn.com` and
  `lm-api-reads.espn.com` are NXDOMAIN on public DNS. The `LeagueProvider` seam is in place
  and CSV/manual entry works.
- **D/ST and kicker projections are not computed.** Scoring for both is implemented and
  tested; the model currently projects skill positions only.
- **Waivers, FAAB, alerts, and performance history are not built.** They appear in the
  entitlement table and are gated, with no implementation behind them yet.
- **The model has a known −0.63 point high bias**, disclosed on `/accuracy`.
- **Calibration and the floor/ceiling bands were fitted on PPR only.** Half PPR and
  Standard projections are rescaled, but that validation does not carry over, and the
  projections page says so when either is selected.
- **Pro currently unlocks only the league cap.** See the entitlements section.
