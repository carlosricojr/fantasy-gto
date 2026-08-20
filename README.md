# Fantasy GTO

Fantasy football projections that show their working, and lineups that are provably
optimal.

The projection model is backtested and its real accuracy is published, including where it
is weak. The lineup optimizer solves slot assignment exactly, so no legal arrangement of a
roster scores higher.

## Quick start

```bash
pnpm install
pnpm verify                # typecheck, lint, tests
pnpm backtest              # development + tuning sets; leaves the 2025 holdout untouched
pnpm backtest -- --holdout # scores the holdout and rewrites the published figures
pnpm backtest -- --sweeps  # reproduce how each parameter was chosen
pnpm verify-sources        # reproduce every measured figure in docs/data-sources.md
pnpm dev                   # Next.js + Convex
```

`pnpm verify` and `pnpm backtest` need no configuration at all — the domain core has no
infrastructure dependencies, which is deliberate. `pnpm dev` needs a Convex deployment and
Clerk keys; copy [`.env.example`](.env.example) to `.env.local` and follow it.

### Billing webhook

**The Clerk webhook is served by Convex, not by Next.js.** Point the Clerk endpoint at:

```
https://<your-deployment>.convex.site/clerk-webhook
```

Note `.convex.site`, not the `.convex.cloud` URL used by the client. Then set the signing
secret on the deployment, which is a different store from `.env.local`:

```bash
pnpm exec convex env set CLERK_WEBHOOK_SECRET whsec_...
pnpm exec convex env set CLERK_JWT_ISSUER_DOMAIN https://your-instance.clerk.accounts.dev
```

Subscribe the endpoint to `user.*` and `subscription.*` events.

This is worth stating explicitly because getting it wrong fails *silently* in the worst
direction: nothing errors in the browser, the app looks healthy, and every paying
subscriber is treated as free because no `subscriptions` row is ever written. The handler
lives in [`convex/http.ts`](convex/http.ts); it verifies the Svix signature and rejects
unsigned deliveries. If you previously ran a version of this app that received the webhook
at the Next.js route `/api/webhooks/clerk`, that route no longer exists and an endpoint
still aimed at it is now getting a 404 — re-point it.

### Seeding a deployment

A fresh deployment has no data, and both ingest actions are `internal` so no client can
trigger them. Populate it from the CLI:

```bash
pnpm exec convex dev --once                                 # push schema + functions
pnpm exec convex run ingest:syncSchedule '{"season":2025}'  # schedule + betting lines

# Projections. Pass every ruleset the interface offers, or the Half PPR and Standard
# toggles render an empty board — projectWeek defaults to PPR alone.
pnpm exec convex run ingest:projectWeek \
  '{"season":2025,"week":18,"scoringIds":["ppr","half_ppr","standard"]}'
```

Verified against a real Convex deployment on 2026-07-30, by running exactly the commands
above and counting rows: the schedule sync wrote 272 contests (a full regular season, which
is 32 teams × 17 games ÷ 2) and the projection run wrote 1,404 rows across three rulesets
for week 18. These are operational counts, not accuracy claims — re-running the commands on
a fresh deployment is what checks them.

Project the week the interface will actually ask for. `season.current` resolves the
displayed week from the schedule, so during the offseason it reports the final week of the
last completed season — week 18 above — rather than an empty future one. The daily cron in
`convex/crons.ts` keeps things current once a season is under way, but it deliberately
does nothing during the offseason, so the first seed has to be run by hand.

## How it is put together

The organizing rule is that **domain logic is pure and I/O lives at the edges**. Every
projection, score, and lineup decision is computed by a plain TypeScript function with no
network, database, clock, or framework dependency. That is what makes the model
backtestable against three seasons of real data and the optimizer exhaustively testable.

```
lib/core/            Sport-agnostic. Domain vocabulary, provider seams, lineup optimizer.
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

The lineup optimizer lives in `lib/core` rather than under NFL because it is genuinely
sport-agnostic: a weighted assignment problem over eligible slots.

### Why no paid data vendor

The original plan budgeted for OddsAPI and SportsDataIO — list prices of $99/mo and
$299/mo respectively at the time `docs/technical-specification.md` was written, which is
where those figures come from and the only place they are used. Neither vendor is
needed. nflverse publishes weekly player statistics, and its schedule file carries Vegas
spread and total lines for future games alongside venue and weather. Everything the model
consumes is free and public. See [`docs/data-sources.md`](docs/data-sources.md), where every
endpoint was verified by direct request.

### Draft board

`/draft` tracks every team's picks and ranks candidates by the probability of winning the
league, simulated against the rosters your opponents have actually drafted. Seed a board
before using it:

```bash
pnpm exec convex run ingest:syncSchedule '{"season":2026}'
pnpm exec convex run ingest:refreshDraftBoards '{}'
```

The first is needed because the page resolves its season from ingested games; without it
`/draft` says there is no season to draft for. The second builds every scoring and league
size in one pass — twelve boards sharing one download, where twelve separate
`buildDraftBoard` calls re-fetch the same multi-megabyte CSVs twelve times. A single
combination is still available if that is all you want:

```bash
pnpm exec convex run ingest:buildDraftBoard '{"season":2026,"scoringId":"ppr","teams":12}'
```

**If a push fails on `draftBoard` schema validation,** the deployment holds rows written
before a column existed — `quantileProvenance` is the one that does this. Every row in that
table is derived and rebuilt twice daily, so clear it and rebuild rather than softening the
schema:

```bash
: > /tmp/empty.jsonl
pnpm exec convex import --table draftBoard --replace --yes /tmp/empty.jsonl
pnpm exec convex dev --until-success
pnpm exec convex run ingest:refreshDraftBoards '{}'
```

The rebuild is not optional. `dev --until-success` pushes the schema; it does not write
application data, so without the last line the board stays empty until the cron next runs —
twice a day, and not at all once the season is under way.

Verified against a real deployment on 2026-07-31: 650 players, 244 of them carrying a
market price. A cron rebuilds every scoring/league-size combination twice daily through the
preseason and does nothing once a season is under way.

The simulation runs in a Web Worker, because a second of synchronous work would freeze the
board at the moment a pick is due. `docs/draft-validation.md` records what was measured,
including the finding that **our model does not out-rank the market** — no edge over ADP is
claimed anywhere in the interface.

## Honesty ledger

Every claim the interface makes, and the computation behind it.

| Claim | Backed by |
| --- | --- |
| "2.74% better than a prior-games-mean baseline, 95% CI 1.28% to 4.20%" | `pnpm backtest -- --holdout`, out-of-sample on 2025, n=3,037 player-weeks over 308 players. The interval uses a standard error clustered by player — the same player appears up to seventeen times, and the clustered error is 22% larger than the i.i.d. one that treats each week as fresh evidence. Two-sided *p* = 0.00025, cross-checked by a seeded block bootstrap over players. Recorded in [`docs/model-validation.md`](docs/model-validation.md), and written to `lib/nfl/model/published-metrics.json`, which `/accuracy` and the landing page render directly rather than restating. `published-metrics.test.ts` recomputes every figure in that artifact from the others and asserts it agrees with the document. |
| Player age, experience, and the snap-count identifier bridge | `pnpm verify-sources`, from nflverse `players.csv`. Directory coverage is 99.8% for `birth_date` and 89.2% for `pfr_id` at skill positions, but on the rows that actually need joining — regular-season skill player-weeks — both are present 99.9–100% of the time across 2013, 2016, 2020 and 2024. Both figures and the difference between them are recorded in [`docs/data-sources.md`](docs/data-sources.md). No age term is in the model; this is the seam only. |
| "2024 injury reports were written before kickoff; 2025 cannot be checked" | `pnpm verify-sources`. Every 2024 regular-season row joins to its game's kickoff, and 5,953 of 5,954 (**99.98%**) were last modified before it, median 47 hours before — Friday for a Sunday game, which is when the NFL mandates the final report. **One row was not**: an `Out` designation edited about three hours after the Thursday-night opener. **2025 carries no `date_modified` at all, so the same check cannot be run on it**; the claim there is inference from the 2024 result and the NFL's reporting mandate, not verification, and [`docs/data-sources.md`](docs/data-sources.md) says so in those words. No claim is made about seasons other than 2024. **Nothing in the product reads this data; it is the seam and the measurement only.** |
| Snap counts join to the rest of the data 99.7–100% of the time | `pnpm verify-sources`, measured through the same `bridgeSnaps` the product would use rather than a parallel implementation. Regular-season skill rows: 2013 100.0% (0 unjoinable players), 2016 99.9% (2), 2020 99.9% (2), 2024 99.7% (3). Unmatched rows are **counted and returned**, never dropped or zeroed — zero snaps means benched and unknown snaps means unknown. Recorded in [`docs/data-sources.md`](docs/data-sources.md). **Nothing in the product reads this data; it is the seam and the measurement only.** |
| Week-1 projections are available before kickoff | `weekly_rosters` resolves a player's team with no game played. `convex/tests/ingest.test.ts` asserts both directions on identical inputs — without the release, 0 projections and a failed run; with it, all 32 teams covered. Only `ACT` players are eligible. |
| A player the league has ruled out is not projected | `projectWeek` reads the weekly injury report and skips anyone designated `Out` for that week, exactly as it already skips a bye-week player — the schema states that invariant and `/lineup` relies on it to hardcode availability. Only `Out`; Questionable and Doubtful players do play, and excluding them would be a modelling decision rather than a correctness fix. Tested in both vitest projects. |
| Projection floor and ceiling | Empirical 10th/90th percentiles of actual/projected, measured per position after calibration, **under PPR**. Other rulesets carry a visible caveat. |
| Contributions sum to the projection | True by construction — the mean is derived from the summed contributions — and asserted in tests. |
| "Provably optimal lineup" | Maximum-weight bipartite matching. Optimal by construction; tests include a roster where greedy loses 14 points. |
| Scoring correctness | Reproduces upstream's own `fantasy_points` and `fantasy_points_ppr` columns exactly on every offensive player-week in the fixture. |
| Residual bias of −0.57 points | Published on `/accuracy` rather than hidden. |
| Pairwise start/sit accuracy and lineup regret | `pnpm backtest`, **in-sample** on the development (2013–2021) and tuning (2022–2024) sets — no decision metric is measured on the 2025 holdout, and none reaches the interface. Pair counts, accuracy by projected gap, points forgone with a pair-clustered 95% CI, and regret against a perfect-hindsight lineup are recorded in [`docs/model-validation.md`](docs/model-validation.md). The headline is that on the closest calls the model is barely better than a coin flip. |
| Draft recommendations ranked by championship probability | Simulated season in `lib/core/season-sim.ts`; each recommendation carries its standard error and a tied-with-leader flag. **No ranking edge over ADP is claimed** — measured out-of-sample, the market ranks players better than our model. See [`docs/draft-validation.md`](docs/draft-validation.md). |
| A player's market price, our model's number, and the blend of the two, shown side by side on the draft board, with the blend named as what the ranking uses | `pnpm draft-backtest`, held out on 2024 over the 151 players with both a market price and a prior game. Recorded in [`docs/draft-validation.md`](docs/draft-validation.md) and written to `published-draft-metrics.json`. The board shows all three because the honest summary is that they disagree: the market ranks better (Spearman 0.5403 against our 0.4433), blending made rank correlation **worse** (0.5364, a 0.72% decline), and the blend's top 24 nonetheless scored more (272.6 against 267.4). The interface states both halves of that — including, on the same screen as the numbers, that the blend does not beat the market. One evaluation season of 151 players cannot settle a disagreement that small, which is why the blend is kept rather than adopted or dropped. |
| "Byes that leave a slot empty" on the draft board, and which of them fall in a playoff week | Not a count of shared bye weeks. The week's players are removed and `solveLineup` is run again; a slot the matching can then no longer fill is the reported cost, with the roster's own unfilled slots subtracted so an undrafted position is not blamed on a bye. Same exact matching as the roster panel beside it. `pool-view.test.ts` covers the two cases a tally gets wrong in opposite directions: depth that absorbs a bye, and a starter sharing one with their only cover. A gap is labelled a playoff week from the league's own bracket — `config.playoffWeeks`, the same value the simulation is run with — never from an assumed one. |
| The season a draft is simulated over: regular-season weeks and the playoff rounds | Derived by `fantasySeasonWeeks` from the two settings the setup screen asks for, the championship week and the size of the playoff field. Every week from 1 to the final belongs to exactly one half, and the bracket is exactly as long as the field needs. Asserted as invariants rather than as examples: `season-sim.test.ts` walks a few hundred season shapes and checks the partition, the bracket length, and that moving the final slides the whole bracket rigidly rather than resizing it; `season-invariants.test.ts` walks every league the two controls can produce and checks it end to end — that it ends before the NFL season does, restores from storage as the season it was drafted against, is described on screen by numbers equal to the ones simulated, and cannot share a cache key with another shape. This used to be two literals applied to every league, which is recorded with what it cost in [`docs/draft-validation.md`](docs/draft-validation.md). Byes are priced by the week they land in, so this is not presentational: a bye in a playoff round the team has to play takes at least 30% off its championship probability where the same bye in the regular season takes under 20%, which is the pair `season-sim.test.ts` asserts. |
| "Lasts to 3.04" and the per-pick survival bars | `survivalProbability` in `lib/core/draft.ts` — the probability a player's actual draft slot falls after that pick, from the market's published ADP and its dispersion, read as a mean rather than a deadline. A missing dispersion is defaulted rather than treated as certainty, and a player the market has not priced is placed behind everyone it has. Tested there against tabulated normal values. |
| A player with no market price is not recommended in the first six rounds, unless no priced player is available at all | `applyMarketGate` in `lib/core/draft-policy.ts`: through round 6 the recommendation shortlist admits only players the board prices with an `adp` — the one exception being a shortlist on which *no* candidate carries one, where the gate stands down rather than return an empty panel, because a panel advising nothing is worse than one advising with the caveat attached. On any real board the market has priced hundreds of players and that exception cannot fire; it is stated because the ledger states what the code does, not what it usually does. A market-absent player's model projection still appears on the board under its "no market price" badge, and past round 6 he may lead again. The measured reason for the window is the #88 audit — the panel recommended market-absent players at picks 2.06 and 6.06 on the model's number alone, and [`docs/draft-validation.md`](docs/draft-validation.md) records that the model's ranking does not beat the market's. Regression-locked as check (a) of `pnpm draft-mock`, in both replay modes. The gate reads the board's own `adp` and nothing else: Sleeper's players dump is the *evidence* for the window, measured in [`docs/data-sources.md`](docs/data-sources.md) and reproduced by `pnpm verify-sources`, and **nothing in the product reads it** — its `search_rank` is a search-relevance ordering, not a market price, never enters the ADP curve fit (`market-awareness.test.ts` walks every deployable file that calls the fit and asserts it), is never blended into a valuation, and appears in no label. |
| A kicker or defence is not recommended before the round the market drafts him in, and never a second one before the last two rounds | `applyStreamableDiscipline` in `lib/core/draft-policy.ts`, over the waiver-wire table in `lib/nfl/roster.ts`. Both rules apply to exactly the positions that table marks as supplied entirely by the wire, and those are the two the model does not project at all — a kicker's and a defence's whole price is the market's, and their weekly spread is still an assumed band rather than a measured one, so an engine taking one early is overruling the only price it has on no signal of its own. The same table controls both the hypothetical replacement an empty slot may receive and the remaining value of drafted cover: zero-cover positions get no free replacement, while tight end receives three quarters of the best remaining tight end. As with the market gate, a discipline that would leave the panel empty stands down instead. Regression-locked as checks (b), (d), and the every-week playability check (g) of `pnpm draft-mock`, in both replay modes. |
| Once a position holds as many players as your lineup dedicates slots to it, a player who outranks one of them is not recommended | `applyOutbidDiscipline` in `lib/core/draft-policy.ts`. He was on the board at the turn we took the lesser player at his position, so preferring him now would spend a second pick to bench the first — #89.A's finding, and 600 simulated seasons cannot tell two late candidates apart well enough to justify it. Two exceptions, both stated because this ledger states what the code does: a player the board does not price is exempt while the market gate itself withholds him; and the rule stands down rather than empty the panel. Regression-locked as check (c) of `pnpm draft-mock`, in both replay modes. |

**Withdrawn.** The original plan claimed "+8.2 points/week vs platform projections" and
"beats ESPN by ≥8% MAE". Neither had any computation behind it, and the measured model
cannot support them — the real edge over the strongest baseline tried is 2.74%. Weekly
fantasy scoring is dominated by variance that no model built on public box-score data
removes. Neither claim appears anywhere in the product. Both are struck through in
`docs/technical-specification.md`, which is retained only as the record of original intent
and is marked superseded at the top.

Any change to the model must re-run `pnpm backtest` and update `docs/model-validation.md`
in the same commit. A number that is not in that document may not appear in the interface.

## Entitlements

Access is a pure function of `(plan, subscription status, clock)`. There is no exported way
to grant a capability directly, so there is nothing for a client to call and nothing to
forge. Persisted rows are a read cache; privileged paths re-derive from stored subscription
state.

| | Free | Pro |
| --- | --- | --- |
| Projections, lineup optimizer | ✓ (no account needed) | ✓ |
| Start/sit advice | ✓ | ✓ |
| Leagues | 1 | **unlimited** |
| Everything else in the plan | — | *not built* |

The cap lives in `lib/billing/entitlements.ts` and every surface derives from it — server
enforcement, `/pricing`, `/dashboard`, and the error message a capped user sees. **The
plan cards rendered by Clerk's `<PricingTable />` do not.** Their feature bullets are free
text in the Clerk dashboard, no code reads them, and only the plan *key* crosses into this
repository. Changing the cap here therefore requires editing the Clerk plan features by
hand, or a card will advertise a limit the server refuses to honor.

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
"included today" and "not built yet" columns from the same table the server authorizes
against — so the page cannot promise more than the code delivers.

Free deliberately includes start/sit. A free tier that cannot answer "who do I start?"
cannot demonstrate value before asking for payment.

To be precise about what that means today: start/sit is delivered by `/lineup`, which takes
the players you select and returns the highest-scoring legal arrangement. The narrower
`startSitAdvice` function — which diffs a *saved* league roster against the optimum and
says "start X over Y" — is implemented and tested but has no screen wired to it. See the
known gaps.

A failed payment keeps Pro for a 3-day grace period. A cancellation runs to the end of the
period already paid for.

An event that does not describe the subscription's current state — an unrecognized or
absent status, or a scheduled change Clerk sends ahead of time — writes nothing and is
audited. That is deliberately biased toward the subscriber: a payer is never dropped by an
event we do not understand. The cost is that a *terminal* status Clerk spells in a way this
code does not model would leave Pro in force indefinitely, because nothing polls Clerk to
reconcile and no alert reads the audit table. `canceled`, `cancelled`, `ended`, and
`expired` are modeled, so ordinary endings revoke normally. Unknown *plan keys* still
resolve to free, and are audited.

## Testing

```bash
pnpm test          # watch
pnpm test:run      # once
pnpm test:coverage
```

Tests are colocated with the code they cover. Fixtures under `tests/fixtures/` are
byte-exact slices of real upstream data, pinned with `.gitattributes` so line endings stay
stable across platforms and the parser's behavior stays reproducible.

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

- **No league import exists, and no screen writes a roster.** ESPN has no working host —
  `lm.espn.com` and `lm-api-reads.espn.com` are both NXDOMAIN on public DNS — so no adapter
  is implemented behind the `LeagueProvider` seam. CSV parsing (`lib/nfl/lineup-csv.ts`)
  and roster storage (`leagues.setRoster`) are implemented and tested, but nothing in `app/`
  calls either, so today a league can be created and never populated. `/lineup` is the
  working path: it takes the players you pick and returns the optimal arrangement.
- **D/ST and kicker projections are not computed.** Scoring for both is implemented and
  tested; the model currently projects skill positions only.
- **Waivers, FAAB, alerts, and performance history are not built.** They appear in the
  entitlement table and are gated, with no implementation behind them yet.
- **The model has a known −0.57 point high bias**, disclosed on `/accuracy`.
- **One season cannot detect an improvement smaller than about 2%.** The minimum detectable
  effect at 80% power on the 2025 sample is 0.1242 MAE, or 2.07% of the baseline, and no
  measured effect below 1.46% can be reported as significant at all. A true 1% improvement
  therefore cannot produce a significant result at its own size — only an inflated one. The
  development set brings that floor down by roughly a factor of three, which is why anything
  smaller is measured there and not on one season. The 2025 figures come from
  `pnpm backtest -- --holdout`; the development and tuning figures from the default
  `pnpm backtest`. Both are recorded in
  [`docs/model-validation.md`](docs/model-validation.md).
- **Calibration and the floor/ceiling bands were fitted on PPR only.** Half PPR and
  Standard projections are rescaled, but that validation does not carry over, and the
  projections page says so when either is selected.
- **Pro currently unlocks only the league cap.** See the entitlements section.
- **The Clerk webhook payload shape is inferred, not verified.** Every data source in
  `docs/data-sources.md` was confirmed by direct request except this one: no real delivery
  has been captured, so the field names `convex/http.ts` probes come from documentation
  rather than observation. The parsers are written to degrade rather than misfire — an
  event that cannot be parsed writes nothing and is audited, so it cannot revoke a paying
  subscriber — but that is a mitigation, not a verification. See section 5 of
  `docs/data-sources.md`.
- **Saved-roster start/sit is not wired to a screen.** `startSitAdvice` in
  `lib/core/optimizer.ts` is implemented and tested, but no page calls it — a league
  currently records scoring and roster format, and start/sit is delivered through
  `/lineup` instead.
- ~~**Week 1 projects nobody until that week's games have been played.**~~ **Closed.**
  `projectWeek` now resolves a player's team from nflverse's `weekly_rosters` release, which
  answers that question before any game is played, and falls back to a current-season
  appearance where one exists — an appearance being stronger evidence than a roster listing,
  and the roster release lagging a transaction by up to a day. Only players listed active
  contribute, so a cut or practice-squad player cannot reach a board. Both states are pinned
  in `convex/tests/ingest.test.ts`: without the release the run resolves nobody and writes
  nothing, with it the board covers all 32 teams pre-kickoff.
