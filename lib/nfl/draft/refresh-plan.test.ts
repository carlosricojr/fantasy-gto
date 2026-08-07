import { describe, expect, it } from "vitest";

import type { SeasonState } from "../season";
import { SCORING_PRESETS } from "../scoring/presets";
import { SUPPORTED_LEAGUE_SIZES } from "./league-size";
import {
  BOARD_REFRESH_INTERVAL_HOURS,
  BOARD_STALE_AFTER_MS,
  type BoardHealthInput,
  boardHealth,
  describeBoardHealth,
  draftBoardMatrix,
  planDraftRefresh,
} from "./refresh-plan";

/**
 * Whether to rebuild, and what to say when a rebuild did not happen.
 *
 * The defect this replaced was invisible by construction: the refresh built only when the
 * displayed season was complete, so through the whole preseason — the one window in which
 * anybody drafts — it rebuilt nothing, twice a day, silently. A decision that cannot be
 * tested is a decision that fails that way.
 */

const HOUR = 60 * 60 * 1000;

const state = (overrides: Partial<SeasonState>): SeasonState => ({
  season: 2025,
  week: 1,
  phase: "preseason",
  isComplete: false,
  ...overrides,
});

describe("planDraftRefresh across the calendar", () => {
  it("builds next season's board once this one is complete", () => {
    // The offseason. `isComplete` moves the target forward, which is the same rule the draft
    // page reads — they disagreed once and the page served a board the cron was not
    // building.
    const plan = planDraftRefresh(
      state({ season: 2025, phase: "offseason", isComplete: true, week: 18 }),
    );
    expect(plan.kind).toBe("rebuild");
    if (plan.kind === "rebuild") expect(plan.season).toBe(2026);
  });

  it("builds this season's board through the preseason", () => {
    // The window that matters. Drafts happen here.
    const plan = planDraftRefresh(state({ season: 2026, phase: "preseason" }));
    expect(plan.kind).toBe("rebuild");
    if (plan.kind === "rebuild") expect(plan.season).toBe(2026);
  });

  it("stops once the season is under way, and says why", () => {
    const plan = planDraftRefresh(state({ season: 2026, phase: "regular" }));
    expect(plan.kind).toBe("skip");
    if (plan.kind === "skip") {
      expect(plan.reason).toContain("under way");
      expect(plan.reason).toContain("2026");
    }
  });

  it("keeps building through a complete regular season that has not flipped to offseason", () => {
    // The postseason boundary. `resolveSeasonState` reports `regular` until every game is
    // played and `offseason` after — so a season marked complete is the offseason case above
    // and this pins the other side of the same boundary rather than a third state.
    expect(planDraftRefresh(state({ phase: "regular", isComplete: true })).kind).toBe(
      "skip",
    );
    expect(
      planDraftRefresh(state({ phase: "offseason", isComplete: true })).kind,
    ).toBe("rebuild");
  });

  it("refuses with a reason rather than quietly doing nothing when there is no season", () => {
    // An action returning `{rebuilt: 0}` for "the season is under way" and for "the schedule
    // was never ingested" is an action whose logs cannot tell working from broken.
    const plan = planDraftRefresh(null);
    expect(plan.kind).toBe("skip");
    if (plan.kind === "skip") {
      expect(plan.reason).toContain("schedule has not been ingested");
    }
  });
});

describe("the matrix", () => {
  it("is every scoring format across every league size, and nothing else", () => {
    const shapes = draftBoardMatrix();
    expect(shapes).toHaveLength(SCORING_PRESETS.length * SUPPORTED_LEAGUE_SIZES.length);
    expect(shapes).toHaveLength(33);
    for (const preset of SCORING_PRESETS) {
      for (const teams of SUPPORTED_LEAGUE_SIZES) {
        expect(shapes).toContainEqual({ scoringId: preset.id, teams });
      }
    }
  });

  it("has no duplicates", () => {
    const shapes = draftBoardMatrix();
    const keys = shapes.map((s) => `${s.scoringId}|${s.teams}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers every shape the setup screen can select", () => {
    // The invariant that broke before: a size the page offers and the cron does not build is
    // a league whose board is permanently empty, with nothing to say so.
    const plan = planDraftRefresh(state({ phase: "preseason" }));
    expect(plan.kind).toBe("rebuild");
    if (plan.kind !== "rebuild") return;
    for (const teams of SUPPORTED_LEAGUE_SIZES) {
      for (const preset of SCORING_PRESETS) {
        expect(
          plan.shapes.some((s) => s.teams === teams && s.scoringId === preset.id),
        ).toBe(true);
      }
    }
  });
});

describe("the staleness threshold", () => {
  it("is two full cycles plus slack, derived from the cron cadence", () => {
    // Not a chosen number. The rebuild runs at 11:00 and 23:00 UTC, so a healthy board is at
    // most twelve hours old; twenty-six is two cycles plus two hours, the smallest threshold
    // that does not fire on a single late or slow run. A warning that appears routinely is a
    // warning nobody reads.
    expect(BOARD_REFRESH_INTERVAL_HOURS).toBe(12);
    expect(BOARD_STALE_AFTER_MS).toBe(26 * HOUR);
    expect(BOARD_STALE_AFTER_MS).toBeGreaterThan(2 * BOARD_REFRESH_INTERVAL_HOURS * HOUR);
  });

  it("does not fire on a board from the previous scheduled run", () => {
    const now = 1_000 * HOUR;
    const healthy: BoardHealthInput = {
      now,
      publishedAt: now - 12 * HOUR,
      lastAttemptAt: now - 12 * HOUR,
      lastAttemptFailed: false,
      refreshing: false,
    };
    expect(boardHealth(healthy)).toBe("fresh");
    // And not on one that is a full cycle late either.
    expect(boardHealth({ ...healthy, publishedAt: now - 24 * HOUR })).toBe("fresh");
  });

  it("fires once two scheduled runs have been missed", () => {
    const now = 1_000 * HOUR;
    expect(
      boardHealth({
        now,
        publishedAt: now - 27 * HOUR,
        lastAttemptAt: now - 27 * HOUR,
        lastAttemptFailed: false,
        refreshing: false,
      }),
    ).toBe("stale");
  });
});

describe("boardHealth", () => {
  const now = 1_000 * HOUR;
  const base: BoardHealthInput = {
    now,
    publishedAt: now - HOUR,
    lastAttemptAt: now - HOUR,
    lastAttemptFailed: false,
    refreshing: false,
  };

  it("says refreshing before it says anything else", () => {
    // A warning about a board that is already being replaced sends somebody to fix what is
    // fixing itself.
    expect(boardHealth({ ...base, refreshing: true, publishedAt: null })).toBe(
      "refreshing",
    );
    expect(
      boardHealth({
        ...base,
        refreshing: true,
        lastAttemptFailed: true,
        publishedAt: now - 100 * HOUR,
      }),
    ).toBe("refreshing");
  });

  it("reports a failed attempt over a fresh timestamp", () => {
    // The exact state this issue exists for: a board hours old, looking entirely healthy,
    // and not the board the last run was trying to produce.
    expect(boardHealth({ ...base, lastAttemptFailed: true })).toBe(
      "last-refresh-failed",
    );
    expect(describeBoardHealth("last-refresh-failed", base)).toContain("runbook");
  });

  it("separates never-built from stale", () => {
    // They lead to different actions: wait or run the refresh, against this league shape has
    // never worked.
    expect(boardHealth({ ...base, publishedAt: null })).toBe("never-built");
    expect(boardHealth({ ...base, publishedAt: null, lastAttemptFailed: true })).toBe(
      "never-built",
    );
    expect(boardHealth({ ...base, publishedAt: now - 200 * HOUR })).toBe("stale");
  });

  it("describes every state without leaving a hole", () => {
    for (const health of [
      "fresh",
      "stale",
      "last-refresh-failed",
      "refreshing",
      "never-built",
    ] as const) {
      expect(describeBoardHealth(health, base).length).toBeGreaterThan(10);
    }
    expect(describeBoardHealth("never-built", { now, publishedAt: null })).not.toContain(
      "null",
    );
  });
});
