import { describe, expect, it } from "vitest";

import {
  CHAMPIONSHIP_WEEKS,
  DEFAULT_CHAMPIONSHIP_WEEK,
  PLAYOFF_FIELDS,
} from "./league-rules";

describe("offered NFL league rules", () => {
  it("pins the playoff fields the product can represent", () => {
    expect(PLAYOFF_FIELDS).toEqual([4, 6]);
  });

  it("offers only finals before the NFL's resting-heavy final week", () => {
    expect(CHAMPIONSHIP_WEEKS).toEqual([15, 16, 17]);
    expect(CHAMPIONSHIP_WEEKS).not.toContain(18);
  });

  it("uses week 17 as the legacy migration default", () => {
    expect(DEFAULT_CHAMPIONSHIP_WEEK).toBe(17);
    expect(CHAMPIONSHIP_WEEKS).toContain(DEFAULT_CHAMPIONSHIP_WEEK);
  });
});
