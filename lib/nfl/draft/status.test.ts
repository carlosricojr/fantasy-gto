import { describe, expect, it } from "vitest";

import {
  DRAFT_STATUS_STALE_AFTER_MS,
  describeDraftStatusHealth,
  draftStatusHealth,
  isRecommendationEligible,
  rosterStatusLabel,
} from "./status";

describe("draft recommendation eligibility", () => {
  it("recommends active players and preserves a pre-catalog board as a degraded fallback", () => {
    expect(isRecommendationEligible("active")).toBe(true);
    expect(isRecommendationEligible(null)).toBe(true);
  });

  it("never recommends a known unavailable or unrecognised status", () => {
    for (const status of [
      "reserve",
      "practice-squad",
      "inactive",
      "cut",
      "retired",
      "traded",
      "unknown",
    ] as const) {
      expect(isRecommendationEligible(status)).toBe(false);
    }
  });

  it("keeps the raw designation beside its human label", () => {
    expect(rosterStatusLabel("reserve", "EXE")).toBe("Reserve (EXE)");
    expect(rosterStatusLabel("unknown", "W04")).toBe("Status needs review (W04)");
    expect(rosterStatusLabel("active", "ACT")).toBeNull();
  });
});

describe("draft status freshness", () => {
  const now = 10 * DRAFT_STATUS_STALE_AFTER_MS;
  const input = {
    now,
    publishedAt: now - 15 * 60_000,
    lastAttemptFailed: false,
    refreshing: false,
    unknownStatusCount: 0,
  };

  it("warns at one hour instead of inheriting the pricing board's slower clock", () => {
    expect(draftStatusHealth(input)).toBe("fresh");
    expect(
      draftStatusHealth({
        ...input,
        publishedAt: now - DRAFT_STATUS_STALE_AFTER_MS - 1,
      }),
    ).toBe("stale");
  });

  it("makes new upstream codes visible and fail closed", () => {
    const health = draftStatusHealth({ ...input, unknownStatusCount: 4 });
    expect(health).toBe("unknown-designation");
    expect(describeDraftStatusHealth(health, { ...input, unknownStatusCount: 4 })).toContain(
      "4 player(s)",
    );
  });

  it("prioritizes an in-flight refresh and reports a failed one", () => {
    expect(draftStatusHealth({ ...input, refreshing: true })).toBe("refreshing");
    expect(draftStatusHealth({ ...input, lastAttemptFailed: true })).toBe(
      "last-refresh-failed",
    );
  });
});
