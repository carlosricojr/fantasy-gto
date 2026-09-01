import { describe, expect, it } from "vitest";

import { importSleeperSetup } from "./sleeper-import";

const source = {
  teams: 10,
  rounds: 15,
  type: "snake",
  rosterSlots: { slots_qb: 1, slots_rb: 2, slots_wr: 2, slots_te: 1, slots_flex: 1, slots_k: 1, slots_def: 1, slots_bn: 6 },
  pickTimerSeconds: 90,
  scoring: { identity: "standard", metadata: {} },
  unsupported: [],
} as const;

describe("importSleeperSetup", () => {
  it("imports standard scoring only with an exact standard roster mapping", () => {
    expect(importSleeperSetup(source)).toEqual({
      exact: true,
      settings: { teams: 10, rounds: 15, scoringId: "standard", templateId: "standard", pickTimerSeconds: 90 },
      unsupported: [],
    });
  });

  it("imports two FLEX only when the exact second FLEX is present", () => {
    expect(importSleeperSetup({ ...source, scoring: { identity: "half_ppr", metadata: {} }, rosterSlots: { ...source.rosterSlots, slots_flex: 2, slots_bn: 5 } })).toMatchObject({
      exact: true,
      settings: { scoringId: "half_ppr", templateId: "two_flex" },
    });
  });

  it("leaves custom scoring, order and slots visibly unsupported instead of choosing a nearby preset", () => {
    const imported = importSleeperSetup({ ...source, type: "linear", scoring: { identity: "custom", metadata: { scoring_type: "custom" } }, rosterSlots: { ...source.rosterSlots, slots_idp_flex: 1 }, unsupported: ["settings.some_custom_rule"] });
    expect(imported).toEqual({
      exact: false,
      settings: null,
      unsupported: expect.arrayContaining(["draft type: linear", "roster slot: slots_idp_flex", "scoring: custom", "settings.some_custom_rule"]),
    });
  });
});
