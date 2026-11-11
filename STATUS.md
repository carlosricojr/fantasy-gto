# Status — 2026-11-11

Security maintenance [PR145](https://github.com/carlosricojr/fantasy-gto/pull/145)
merged as `f5c5024`. Current-head CI, independent/canonical-policy review and
preview gates passed. Vercel production artifact `dpl_HNRxBwEx37fByyoysSyawu4g1RSH`
and the deployed Convex service were verified against that merge; production
browser checks covered desktop/mobile rendering, PWA activation and the auth
boundary. Read-only metadata showed 2026/week 10 and the 2026-11-11 projection job
succeeded. These checks do not establish injury-source completeness or replace
live authenticated workflow UAT.

A separate navigation repair is in progress from that merged default. Both the
previous production revision and the security candidate prefetch the protected
`/dashboard` link while signed out, redirecting a speculative RSC request to
Clerk and generating CORS/fallback errors. The shared route entry now disables
prefetch for that destination in desktop and mobile navigation. Explicit clicks
still navigate through the existing authentication guard.

Frozen install, both typechecks, lint, all 137 files / 2,328 tests and the production
build (including Serwist and 19 static pages) pass on Node 24.22.1 / pnpm 10.34.5.
Before merge: preview browser regression checks, independent/current-head
canonical review, trusted CI and readiness/protection. After merge: trace and verify the actual
production revision.

The existing production Clerk development-instance warning is a separate owner
decision. No credential, billing, entitlement, backend, model, research artifact
or source-data change is included in this navigation repair.
