import { describe, expect, it } from "vitest";

import {
  LITE_SCENARIOS,
  MIN_SCENARIOS,
  initialScenarioBudget,
  nextScenarioBudget,
} from "./compute-budget";

describe("draft compute budget", () => {
  it("starts old or memory-constrained devices in lite mode", () => {
    expect(initialScenarioBudget({ full: 600, hardwareConcurrency: 4 })).toBe(
      LITE_SCENARIOS,
    );
    expect(initialScenarioBudget({ full: 600, deviceMemoryGb: 4 })).toBe(
      LITE_SCENARIOS,
    );
    expect(
      initialScenarioBudget({ full: 600, hardwareConcurrency: 8, deviceMemoryGb: 8 }),
    ).toBe(600);
  });

  it("downshifts from observed latency and never raises the budget", () => {
    expect(nextScenarioBudget(600, 3_501)).toBe(LITE_SCENARIOS);
    expect(nextScenarioBudget(600, 6_001)).toBe(MIN_SCENARIOS);
    expect(nextScenarioBudget(MIN_SCENARIOS, 500)).toBe(MIN_SCENARIOS);
  });
});
