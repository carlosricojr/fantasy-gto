# Private data access and read budgets

The eleven public data-query functions in `convex/projections.ts`, `convex/draft.ts`,
`convex/contests.ts` and `convex/season.ts` require an existing application user before
reading football data. No paid entitlement is required. A hosting-access session is not
a Clerk/Convex identity, and protecting Vercel URLs does not protect direct Convex RPCs.

This blocks anonymous database work, not every possible platform charge: request parsing,
authentication and rejected invocations can still consume resources. Authenticated queries
are cached where Convex can reuse an identical result. Authentication is not an account
allowlist or a per-account request quota; those are separate access controls.

## Bounded work, complete answers

| Read | Maximum per request |
| --- | --- |
| Player identity or selected-player lookup | 2,048 raw IDs, then deduplicated; 128 characters per ID |
| Whole weekly projection pool | 1,024 rows before sorting; explicit top-N requests may narrow the result afterward |
| Draft valuation and current catalog | 2,048 rows each, at most 4,096 combined |
| Published-run metadata | 16 rows per indexed shape |
| Weekly / season schedule | 32 / 400 rows |
| Explicit position search | 500 rows; default remains 200 |

Whole-pool reads use an indexed `take(max + 1)` and reject overflow with an explicit
message. They never silently truncate a draft board, lineup pool or schedule. Array bounds
are checked before deduplication and indexed lookups. Seasons, weeks, team counts,
positions, limits and scoring-ID lengths are checked before football-data access.
These are defensive operating budgets, not a claim that every legal future format fits.

The ordinary signed-in result and ranking below these budgets are unchanged. Tests cover
the 468-player lineup pool, top-N sorting after a complete read, duplicate IDs, signed-out
calls, missing user provisioning, malformed arguments and overflow refusal.

The identity-free `internal.season.currentInternal` shares the bounded resolver with the
authenticated public query. All four scheduled-ingest callers use that internal function;
cron actions must not call the authenticated wrapper.

## Coordinated release and older tabs

Verified September 9, 2026 against the installed CLI and the
[official Convex deploy reference](https://docs.convex.dev/cli/reference/deploy):
`convex deploy --cmd 'pnpm build'` runs the build command before typechecking, generating,
bundling and pushing backend functions. Vercel may promote its frontend after that push,
so backend and already-open browser bundles are not an atomic release.

New frontend consumers wait for verified Convex authentication and the application user
row before mounting protected data queries. A provisioning retry is explicit; a failed
read shows a retry state rather than advice from an incomplete pool. Signing out unmounts
the data consumers. Existing signed-in users with valid accounts retain the same query
results below the budgets.

An older signed-out tab can receive an authentication error when the backend guard becomes
active. It cannot acquire the new sign-in/error UI without reloading. The coordinated
release intentionally fails closed: reload existing tabs after deployment, then sign in.
Do not temporarily reopen anonymous reads or substitute empty results to hide this error.
Saved local drafts are not deleted by these guards. Before announcing release, verify the
new frontend sign-in state and one denied direct RPC against the deployed backend; do not
load-test it. Source changes alone are not proof that production is protected.

## Operator diagnostics

Live `pnpm identity-coverage` and `scripts/sleeper-rehearsal.ts` require
`FANTASY_GTO_CLERK_TOKEN`, supplied securely outside git as a short-lived Convex-compatible
Clerk JWT for an already authenticated application user. These scripts do not log in,
discover tokens, inspect browser storage, or accept admin keys as a bypass. Without a token
they stop before provider I/O. Credentials are sent only to the exact configured production
Convex host, with redirects disabled; arbitrary URL overrides are refused.

The `identity-coverage --board <fixture>` board-input path remains available without that
token and still fetches its documented public provider identity inputs. It is a fixture-board
audit, not a live authenticated production-board check. Credentials and response bodies
must not be pasted into issue comments or committed. An expired or unauthorized token means
the live diagnostic is unavailable until the operator supplies valid access.
