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
The user confirmed personal use for their own leagues. This release is read-only decision
support, not a commercial data product, and does not submit draft picks or starting lineups
to a fantasy platform. Local draft-board recording is separate from a platform submission.

## Delivery gates

| Workstream | Acceptance evidence | Owner |
| --- | --- | --- |
| Chronological draft decisions | Each candidate consumes the actual owned pick; opponents can take any available future player; London/Wilson regression; traded capacity and keeper tests | Draft engine |
| Feasible roster completion | Required starter slots can be filled when available players and owned picks permit it; impossible states explicitly diagnosed; alternative opponent policies tested | Draft engine |
| Decision evaluation | Paired comparisons against ADP and roster-needs baselines; separate evaluation seeds/assumptions; effect sizes, uncertainty, failures and latency reported | Draft evaluation |
| Data provenance | Provider, season/week, reception format, retrieval time, upstream update time or explicit unknown, missing fields and license constraints preserved; no synthetic ADP dispersion | Free data |
| Weekly lineups | Exact league slots and roster; per-game kickoff locks including bench; inactive/bye exclusions; missing-input diagnostics; explicit scoring identity; no automatic roster submission | Weekly lineups |
| Honest draft UX | Experimental ranking labeled before results; source and market cost visible; large reaches flagged; unknown waiting estimates not fabricated; simulation results secondary | Product integration |
| Immediate market comparator | On a verified current own turn, show the lowest priced ADP option allowed by the structural completion guard independently of simulation latency; withhold on impossible or unpriced states | Product integration |
| Release | Unit/integration tests, build, independent review, production smoke checks and rollback path for each scoped PR | Coordinator |

## Evaluation boundaries

- Preserve the existing 2025 projection holdout. Routine backtests use development and tuning sets only.
- A mock-draft success does not establish a real-world advantage. Do not optimize and evaluate solely against the same assumed opponents and scoring model.
- Missing projected events are not zero events. Any partial estimate must name its omissions and cannot be labeled a complete exact-scoring projection.
- No empirical edge means no empirical edge, including after a bug fix. More simulation samples only reduce simulation sampling noise.
- Candidate and default-policy forecasts with incomplete opponent rosters must disclose that limitation before any percentages. A legal-market comparator is a transparent rule, not a replacement claim of optimality.
- Withhold actionable output on stale or conflicting draft state; do not hide a failure behind a cached answer.
- Sleeper API requests and weekly-lineup imports use a network-only service-worker route ahead of the offline cache. A failed refresh must surface as a failure, not a cached live snapshot; static pages retain their existing offline behavior.
- Record prospective input snapshots before kickoff when permission allows, so future evaluations can use information actually available at decision time.

## Current position

The following changes merged on September 9, 2026, after exact-head review and readiness
checks. Each pull request records its validation and review evidence:

- [#124](https://github.com/carlosricojr/fantasy-gto/pull/124): chronological draft continuations, including traded capacity and the London/Wilson regression.
- [#125](https://github.com/carlosricojr/fantasy-gto/pull/125): offline Sleeper projection/ADP contracts and honest source provenance; no undocumented projection download.
- [#126](https://github.com/carlosricojr/fantasy-gto/pull/126): experimental simulation labels, visible ADP/reach context, secondary percentages and stale-result suppression.
- [#127](https://github.com/carlosricojr/fantasy-gto/pull/127): free nflverse weekly estimate adapter with explicit coverage, identity, scoring and availability gates.
- [#128](https://github.com/carlosricojr/fantasy-gto/pull/128): live-request cache safety. A production-mode service-worker test confirmed that an offline request fails instead of returning an old cached live response.
- [#129](https://github.com/carlosricojr/fantasy-gto/pull/129): required-starter completion guards and paired draft-policy evaluation.
- [#130](https://github.com/carlosricojr/fantasy-gto/pull/130): personal weekly roster import and exact constrained lineup assignment, including kickoff locks, refresh safety and the cross-source Out regression.

The evaluation does **not** establish rollout superiority: rollout lost to roster-needs
ADP in five of six non-stress point estimates. The full assumptions, uncertainty, external
historical checks and latency are in [draft-strategy-evaluation.md](draft-strategy-evaluation.md).
The immediate market comparator therefore remains a transparent alternative, not a newly
validated optimal policy. Desktop/mobile draft checks covered its immediate appearance and
removal after a local pick advances the board to an opponent turn.

The weekly interface is available at `/lineup/weekly`. The separately reviewed opt-in
active-at-kickoff extension is tracked in [#131](https://github.com/carlosricojr/fantasy-gto/pull/131);
its source contract, browser checks and remaining workflow friction are recorded in
[weekly-lineup.md](weekly-lineup.md). The September 9 live roster check produced 2 ordinary
estimates and 10 additional conditional forecasts, with 4 players still unpriced. Ordinary
model coverage is not 12/16, and conditional forecasts do not clear injury uncertainty.

Missing injury reports, stale player history, unsupported K/D/ST projections and omitted
custom scoring events remain explicit. A partial comparison requires consent and holds
unpriced players in their current places; it cannot establish the best full-roster lineup.
Neither a successful import nor exact lineup assignment proves forecast accuracy. These
are supervised decision-support workflows, not an autonomous draft or lineup manager.
