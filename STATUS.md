# Status — 2026-11-11

Dependency security maintenance is in progress from main `4a5af84`. The frozen
baseline passed all four `pnpm verify` stages: 137 files and 2,328 tests. A fresh
native audit reported 57 advisory records across 17 packages (51 GitHub advisory
URLs); those counts describe dependency matches, not proven exploitability.

The candidate targets the reported packages, preserving Next 15.5.28, Convex, Clerk and Serwist. React and React DOM
move from 19.1.1 to 19.1.10 on the same minor branch, satisfying the installed
Clerk peer floor of 19.1.4. Happy DOM 21, Glob 14 and the Minimatch 9 consumer's
bounded move to 11 need test/build compatibility evidence. Existing domain,
billing, data-source and research rules are preserved in canonical `AGENTS.md`;
CLAUDE redirects there and the legacy review document becomes a handbook pointer.

Candidate frozen install and audit pass (zero reported advisories). Full
`pnpm verify` passes again: 137 files and 2,328 tests. The production build
passes, including the Serwist service worker and all 19 static pages.

Before merge: preview/browser checks, independent review, canonical current-head
review and trusted CI/readiness. After merge: trace the production artifact to the reviewed
merge and verify representative flows. No 2025 holdout evaluation, model change,
published-metric rewrite, billing or backend data mutation is part of this work.

The holdout instruction now distinguishes unscored 2025 player-weeks from the
all-season schedule/betting rows read for a printed diagnostic, matching
`scripts/backtest.ts`. This is a wording correction; the script is unchanged.
