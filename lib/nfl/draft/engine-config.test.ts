import { describe, expect, it } from "vitest";

import { CHAMPIONSHIP_CANDIDATES } from "../../core/draft-policy";
import {
  RECOMMEND_CANDIDATES,
  RECOMMEND_SCENARIOS,
  RECOMMEND_SEED,
} from "./engine-config";

describe("the shared engine invocation", () => {
  it("pins the values the audit and its replay ran under", () => {
    // Literals on purpose, not re-imports: these are the settings the #88/#89 audit's
    // panel computed with, and the frozen scoreboard is a replay of that audit only
    // while they hold. Changing one is legitimate — but it re-baselines every number
    // `pnpm draft-mock` prints, and this test is where that choice becomes a visible
    // decision instead of a silent drift.
    expect(RECOMMEND_SEED).toBe(20260731);
    expect(RECOMMEND_SCENARIOS).toBe(600);
    expect(RECOMMEND_CANDIDATES).toBe(10);
  });

  it("asks the worker for exactly the shortlist width the policy documents", () => {
    expect(RECOMMEND_CANDIDATES).toBe(CHAMPIONSHIP_CANDIDATES);
  });
});
