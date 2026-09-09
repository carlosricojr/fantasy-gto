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
[weekly-lineup.md](weekly-lineup.md). The September 9 pre-experimental roster check produced 2 ordinary
estimates and 10 additional conditional forecasts, with 4 players still unpriced. Ordinary
model coverage is not 12/16, and conditional forecasts do not clear injury uncertainty.

Missing injury reports, stale player history, unsupported ordinary K/D/ST projections and omitted
custom scoring events remain explicit. A partial comparison requires consent and holds
unpriced players in their current places; it cannot establish the best full-roster lineup.
Neither a successful import nor exact lineup assignment proves forecast accuracy. These
are supervised decision-support workflows, not an autonomous draft or lineup manager.

## Personal-workflow release acceptance

The follow-on release combines these bounded capabilities; individual PR merge and
deployment evidence remains authoritative, not this checklist alone:

- Saved Sleeper connections resolve a username or league URL, share the existing
  league cap and hand off directly to a prefilled weekly planner. Manual overrides
  restore only after a fresh matching import, preserving original timestamps and
  expiry. Account changes reset the planner and consent. Grouped warnings, concise
  proposed changes and an in-app kickoff checklist do not submit platform actions.
- [#133](https://github.com/carlosricojr/fantasy-gto/pull/133) adds source-coverage
  transparency and exploratory gap research. That research alone did not activate an
  estimate tier; the separately gated experimental extension is described below.
- [#134](https://github.com/carlosricojr/fantasy-gto/pull/134) extends draft evidence;
  the policy remains experimental, with no superiority or optimal-draft claim.
- [#135](https://github.com/carlosricojr/fantasy-gto/pull/135) supplies the pure
  prospective journal and outcome contract. The workflow backend adds authenticated
  Pro ownership, server receipt time, append-only records and observations, bounded
  reads, idempotency, quotas and account erasure. Outcomes compare frozen lineups;
  they never select a hindsight-best lineup or establish aggregate forecasting edge.
- [#136](https://github.com/carlosricojr/fantasy-gto/pull/136) provides one-week waiver
  comparisons over a bounded, explicitly user-selected available-player pool. It is
  not a global-best waiver search, FAAB policy, rest-of-season optimizer or claim
  submission. Missing values and source uncertainty remain visible.

Source I/O now requires authenticated admission before upstream work: Free has bounded
roster-only imports and connection lookup; Pro has bounded model, waiver and journal
operations. Quotas are atomic across instances and subscription-derived, never an
owner-wide Pro override. Direct-backend hardening in
[#138](https://github.com/carlosricojr/fantasy-gto/pull/138) gates the eleven public
football reads behind authenticated admission and explicit bounded reads. The Convex
module-path correction in [#139](https://github.com/carlosricojr/fantasy-gto/pull/139)
was deployed with a verified backend push and both production aliases on commit
`5d0c48426f1da0333658556d6acf56dee7beb3b5`. Anonymous valid-argument RPC calls to all
eleven endpoints returned unauthenticated errors without football data. These controls
do not eliminate request, auth or hosting costs and are not an absolute spending cap.

The owner explicitly declined an access allowlist and additional Vercel deployment
protection; neither is a pending activation task. Existing subscription-derived
Free/Pro entitlements remain intact. Signed-in production Arc checks verified a real
saved Sleeper connection, fresh weekly import, explicitly conditional/incomplete advice,
private decision save/detail/reload and a correctly pending observed outcome. No
subscription, forecast or result was changed to manufacture a test pass. A complete
signed-in waiver comparison also passed on the exact PR #140 production release,
as recorded below. The data and optimality limitations above still apply.

The recent private decision review follows the bounded descriptive protocol in
[decision-journal.md](decision-journal.md#recent-descriptive-results-protocol). It does
not promote the model or draft policy based on selectively saved outcomes.

## September 9 follow-up acceptance

- [#141](https://github.com/carlosricojr/fantasy-gto/pull/141) adds a sensitivity
  check against original starters, not a confidence interval or all-alternative
  optimality certificate. Signed-in Arc testing on production `13b0b73` showed
  76.53 included points and a +1.82 gain; adverse changes of about ±0.46 per changed
  player could erase it. Changing the stress control from ±1 to ±2 changed the
  stressed margin without refreshing sources or changing the recommendation.
  Harmless equal-eligibility slot permutations are suppressed; necessary slot
  moves remain visible separately from start/bench actions.
- [#140](https://github.com/carlosricojr/fantasy-gto/pull/140) adds saved-team waiver
  handoff, explicit current-week resolution, current-season roster evidence and
  cross-source identity checks for both baseline and candidate estimates. On
  production `abee745`, signed-in Arc testing checked all 10 real league rosters,
  loaded 392 evidence-supported unrostered candidates, excluded a retired-player
  search, and completed all 12 selected AJ Barner add/drop pairs with zero unknown
  pairs. No pair improved the 76.53 included-point no-transaction baseline. This
  tested one selected candidate, not a global search. No transaction was submitted.
- [#143](https://github.com/carlosricojr/fantasy-gto/pull/143) adds the bounded,
  private descriptive recent-results review. Corrupt receipts withhold the batch;
  pending results do not become zero; unknown estimate origins remain separate.
  Exact-head tests and independent review passed before merge. Its new signed-in
  production report check remains part of the final combined-release acceptance.
- [#142](https://github.com/carlosricojr/fantasy-gto/pull/142) adds independent,
  default-off experimental consent for returning-player frozen-model estimates
  and a prior-season observed-game kicker mean. Both assume active at kickoff;
  neither is availability-adjusted or injury clearance. The kicker baseline
  prices only supported kicking events and lists omitted league rules. Disabling
  consent removes these values immediately. Manual overrides remain separate.
  The frozen decision records preserve experimental provenance and consent.

The PR #142 live source check produced 2 ordinary, 10 conditional and 3 experimental
estimates for the 16-player roster: Daniels, Garrett Wilson and Mevis became available
only in the experimental tier; Houston D/ST remained unpriced. This is source/adapter
coverage evidence, not a claim of ordinary 15/16 model coverage, full-scoring accuracy,
or completed signed-in deployment acceptance. The final PR's deployment and browser
evidence must identify the exact shipped commit before that gate is marked complete.

The frozen-model default backtest remained unchanged at 5.8818 development and 5.7709
tuning MAE on the current cache. No reserved 2025 holdout evaluation, coefficient
retuning or published holdout-metric rewrite was performed. Live prior-season inputs
for 2026 recommendations are not held-out outcome evaluation. Partial injury coverage,
unknown publication timestamps, omitted scoring events, unpriced D/ST and unproven
draft-policy superiority remain limitations after these improvements.
