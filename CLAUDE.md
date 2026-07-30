# Fantasy GTO — Project Context for Claude

## What this is

Fantasy football projections with visible reasoning, and a lineup optimiser that solves
slot assignment exactly. Mobile-first PWA, Clerk-billed free and Pro tiers.

Read [`README.md`](README.md) first, then [`docs/model-validation.md`](docs/model-validation.md)
and [`docs/data-sources.md`](docs/data-sources.md). Those three describe what is true; this
file records the rules for changing it.

## Non-negotiable rules

**Never state a number the code cannot produce.** Every user-visible claim maps to a row in
the README's honesty ledger. If you cannot point at the computation, delete the claim
rather than soften it. This project previously advertised "+8.2 points/week" and "beats
ESPN by ≥8%" with nothing behind either; the measured edge is 2.59%.

**Any model change re-runs `pnpm backtest` and updates `docs/model-validation.md` in the
same commit.** Hyperparameters in `lib/nfl/model/config.ts` were chosen on 2024 and frozen
before evaluating on 2025. Retuning them against 2025 destroys that property and makes the
published figure meaningless.

**Keep the domain core pure.** Nothing in `lib/core`, `lib/nfl`, or `lib/billing` may
import Convex, Clerk, React, or call `fetch`, `Date.now()`, or `Math.random()`. Pass the
clock in. This is what makes the model backtestable and the entitlement logic testable, and
`lib/purity.test.ts` enforces it. I/O adapters go in `lib/sources/`, which is exempt.

**Never grant an entitlement directly.** Access is derived from subscription state by a
pure function. If you find yourself writing a mutation that sets a capability, the design
has gone wrong — that exact bug shipped once already.

**Verify data endpoints before coding against them.** `docs/data-sources.md` records what
was confirmed by direct request. Upstream renames columns and retires releases; reading a
column that no longer exists yields zero silently rather than failing.

**ALWAYS use pnpm.**

## Stack

Next.js 15.5 (App Router), React 19, Tailwind 4, Convex, Clerk (auth + billing), Vercel.

There is no Redis and no paid data vendor. Both were in the original plan; neither is
needed. The unconfigured Upstash client was removed because it logged errors on every build
and nothing used it. nflverse supplies statistics, schedule, and Vegas lines for free.

## Commands

```bash
pnpm verify     # typecheck, lint, tests (both projects) — run before every commit
pnpm test       # watch mode
pnpm backtest   # reproduce accuracy figures (add -- --sweeps for parameter sweeps)
pnpm dev        # frontend + Convex
```

## Layout

```
lib/core/       Sport-agnostic: domain types, provider seams, lineup optimiser
lib/nfl/        NFL domain: csv, teams, season, scoring/, model/, stats/ (pure)
lib/billing/    Entitlement derivation (pure)
lib/sources/    Adapter layer — the only part of lib/ allowed to do I/O
convex/         Thin orchestration; schema, queries, ingest, http webhook
app/            App Router; (marketing) is public, (app) is mixed
scripts/        backtest.ts
```

Adding a sport means adding an adapter under `lib/<sport>/` that implements the seams in
`lib/core/providers.ts`. It must not require edits to `lib/core` or to another sport.

## Where the bodies are buried

- **ESPN's fantasy league API has no working host.** `lm.espn.com` and
  `lm-api-reads.espn.com` are NXDOMAIN on public DNS. "ESPN-first" is no longer the
  strategy and cannot be. CSV and manual entry are the guaranteed roster paths.
- **It is currently the offseason.** Resolve the season from data availability, never from
  `new Date().getFullYear()` — see `lib/nfl/season.ts`.
- **nflverse CSVs contain quoted fields with commas.** Use `lib/nfl/csv.ts`, never
  `String.split(",")`.
- **The current stats release is `stats_player_week_{season}.csv`.** The older
  `player_stats` release stops at 2024 and spells several columns differently.
- **Convex needs its own `@/*` path mapping** (`convex/tsconfig.json`). Without it, shared
  imports silently degrade to `{}`.

## Not built yet

Waivers, FAAB, D/ST streamer, alerts, and performance history are gated in the entitlement
table with no implementation behind them. D/ST and kicker scoring exist and are tested, but
the model projects skill positions only. Do not present any of these as working.
