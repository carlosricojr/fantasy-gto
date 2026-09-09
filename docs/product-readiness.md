# Decision-support readiness

September 9, 2026. This is the acceptance plan for the draft and weekly-lineup rebuild,
not a claim that the gates below have passed.

## Product contract

The tool should improve decisions over a documented simple baseline. Exact lineup
assignment means maximizing supplied projected points subject to eligibility and locks;
it does not mean predicting the highest realized score. Draft simulations remain
experimental until independent decision-quality evidence supports a stronger claim.

Only free, permitted data is in scope. A public endpoint is not evidence of permission
to automate collection, redistribute data, or sell access. Personal and commercial
activation must be considered separately; no paid-data purchase is authorized.

## Delivery gates

| Workstream | Acceptance evidence | Owner |
| --- | --- | --- |
| Chronological draft decisions | Each candidate consumes the actual owned pick; opponents can take any available future player; London/Wilson regression; traded capacity and keeper tests | Draft engine |
| Feasible roster completion | Required starter slots can be filled when available players and owned picks permit it; impossible states explicitly diagnosed; alternative opponent policies tested | Draft engine |
| Decision evaluation | Paired comparisons against ADP and roster-needs baselines; separate evaluation seeds/assumptions; effect sizes, uncertainty, failures and latency reported | Draft evaluation |
| Data provenance | Provider, season/week, reception format, retrieval time, upstream update time or explicit unknown, missing fields and license constraints preserved; no synthetic ADP dispersion | Free data |
| Weekly lineups | Exact league slots and roster; per-game kickoff locks including bench; inactive/bye exclusions; missing-input diagnostics; explicit scoring identity; no automatic roster submission | Weekly lineups |
| Honest draft UX | Experimental ranking labeled before results; source and market cost visible; large reaches flagged; unknown waiting estimates not fabricated; simulation results secondary | Product integration |
| Release | Unit/integration tests, build, independent review, production smoke checks and rollback path for each scoped PR | Coordinator |

## Evaluation boundaries

- Preserve the existing 2025 projection holdout. Routine backtests use development and tuning sets only.
- A mock-draft success does not establish a real-world advantage. Do not optimize and evaluate solely against the same assumed opponents and scoring model.
- Missing projected events are not zero events. Any partial estimate must name its omissions and cannot be labeled a complete exact-scoring projection.
- No empirical edge means no empirical edge, including after a bug fix. More simulation samples only reduce simulation sampling noise.
- Withhold actionable output on stale or conflicting draft state; do not hide a failure behind a cached answer.
- Record prospective input snapshots before kickoff when permission allows, so future evaluations can use information actually available at decision time.

## Current position

PR #124 merged on September 9, 2026, after a fresh exact-head readiness check. It fixes
the reserved-future-player defect. It does not establish calibration or globally optimal
drafting. Draft feasibility/evaluation, free-source provenance, and weekly workflow
improvements are separate active tranches. Their evidence must be recorded before any
end-to-end readiness claim.
