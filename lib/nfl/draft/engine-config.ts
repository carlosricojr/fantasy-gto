import { CHAMPIONSHIP_CANDIDATES } from "../../core/draft-policy";

/**
 * The engine invocation the `/draft` page and the mock-draft harness share.
 *
 * One copy, deliberately. PR #92 shipped the harness with these re-declared from the
 * page's unexported constants, and recorded the consequence as its known limitation: a
 * page-side change to any of them would not fail the harness, which is exactly the drift
 * the harness exists to catch. Both now read this module, so "the harness runs the page's
 * own engine settings" is true by construction rather than by line-against-line review.
 */

/**
 * The seed every recommendation is computed under.
 *
 * A constant rather than a draw because the whole pipeline is deterministic on purpose:
 * the same board and the same picks produce the same panel, which is what makes a
 * recommendation reproducible after the fact and the harness's replay meaningful at all.
 */
export const RECOMMEND_SEED = 20260731;

/**
 * Scenarios per recommendation.
 *
 * A draft-clock budget, not a resolving sample. This constant used to claim "600 resolves
 * the ordering; 300 leaves the top few tied", and #89.C measured that claim false for a
 * real league shape: from round 2 onward the top of the board sat statistically tied at
 * this size. The ranking now simply descends by title odds — identically, by the paired
 * vs-leader comparison's point estimate — and the gaps these scenarios cannot resolve
 * are *flagged* tied rather than re-ordered (see `orderRecommendations`). Raising the
 * count buys narrower paired intervals and therefore fewer flagged ties, not a different
 * rule, and costs time on a draft clock.
 */
export const RECOMMEND_SCENARIOS = 600;

/**
 * Candidates the worker is asked to rank — the policy's own shortlist width, re-exported
 * so the page and the harness cannot ask for a different panel than the policy documents.
 */
export const RECOMMEND_CANDIDATES = CHAMPIONSHIP_CANDIDATES;
