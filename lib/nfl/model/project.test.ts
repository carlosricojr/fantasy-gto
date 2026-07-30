import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/nfl/csv";
import { PPR, STANDARD } from "@/lib/nfl/scoring/presets";
import { round2 } from "@/lib/nfl/scoring/score";
import type { Position } from "@/lib/nfl/scoring/types";
import { type PlayerWeek, toRegularSeasonPlayerWeeks } from "@/lib/nfl/stats/parse";

import { CALIBRATION, MODEL_VERSION, OUTCOME_QUANTILES } from "./config";
import {
  type GameContext,
  buildDefenseFactors,
  ema,
  impliedTeamTotal,
  projectPlayer,
} from "./project";

const weeks = toRegularSeasonPlayerWeeks(
  parseCsv(
    readFileSync(join(__dirname, "../../../tests/fixtures/stats_player_week_sample.csv"), "utf8"),
  ),
);

function historyFor(name: string): PlayerWeek[] {
  return weeks
    .filter((w) => w.competitor.name === name)
    .sort((a, b) => a.period.index - b.period.index);
}

const NO_GAME: GameContext = {
  opponent: null,
  impliedTeamTotal: null,
  teamMeanImpliedTotal: null,
};

function project(history: PlayerWeek[], position: Position, game: GameContext | null = null) {
  return projectPlayer({
    competitorId: "test",
    position,
    period: { season: 2025, index: 9 },
    history,
    game,
    scoring: PPR,
  });
}

describe("ema", () => {
  it("returns 0 for no observations", () => {
    expect(ema([], 0.15)).toBe(0);
  });

  it("returns the single value when there is one observation", () => {
    expect(ema([12.5], 0.15)).toBeCloseTo(12.5, 10);
  });

  it("equals the arithmetic mean when alpha is 0", () => {
    expect(ema([1, 2, 3, 4], 0)).toBeCloseTo(2.5, 10);
  });

  it("returns the most recent value when alpha is 1", () => {
    expect(ema([1, 2, 3, 99], 1)).toBeCloseTo(99, 10);
  });

  it("weights recent observations more heavily", () => {
    // Same values, opposite order: the one ending high must score higher.
    expect(ema([0, 20], 0.15)).toBeGreaterThan(ema([20, 0], 0.15));
  });

  it("stays within the range of its inputs", () => {
    const values = [4, 19, 7, 22, 11];
    const result = ema(values, 0.15);
    expect(result).toBeGreaterThanOrEqual(Math.min(...values));
    expect(result).toBeLessThanOrEqual(Math.max(...values));
  });

  it("is scale invariant", () => {
    const values = [3, 9, 15];
    expect(ema(values.map((v) => v * 7), 0.15)).toBeCloseTo(ema(values, 0.15) * 7, 10);
  });
});

describe("impliedTeamTotal", () => {
  // A 47.5 total with the home side favoured by 8.5 splits 28.0 / 19.5.
  it("gives the favoured home team the larger share", () => {
    expect(impliedTeamTotal(47.5, 8.5, "PHI", "PHI", "DAL")).toBeCloseTo(28, 10);
    expect(impliedTeamTotal(47.5, 8.5, "DAL", "PHI", "DAL")).toBeCloseTo(19.5, 10);
  });

  it("treats a negative spread as the home team being the underdog", () => {
    expect(impliedTeamTotal(44, -3, "KC", "KC", "BUF")).toBeCloseTo(20.5, 10);
    expect(impliedTeamTotal(44, -3, "BUF", "KC", "BUF")).toBeCloseTo(23.5, 10);
  });

  it("splits evenly on a pick'em", () => {
    expect(impliedTeamTotal(42, 0, "GB", "GB", "CHI")).toBeCloseTo(21, 10);
  });

  it("always sums to the game total", () => {
    const home = impliedTeamTotal(51, 6.5, "SF", "SF", "SEA")!;
    const away = impliedTeamTotal(51, 6.5, "SEA", "SF", "SEA")!;
    expect(home + away).toBeCloseTo(51, 10);
  });

  it("returns null without a usable total or for an uninvolved team", () => {
    expect(impliedTeamTotal(null, 3, "SF", "SF", "SEA")).toBeNull();
    expect(impliedTeamTotal(0, 3, "SF", "SF", "SEA")).toBeNull();
    expect(impliedTeamTotal(45, 3, "DAL", "SF", "SEA")).toBeNull();
  });
});

describe("buildDefenseFactors", () => {
  it("shrinks thin samples toward neutral", () => {
    const factors = buildDefenseFactors(weeks, PPR, 30);
    for (const value of factors.values()) {
      expect(value).toBeGreaterThan(0.5);
      expect(value).toBeLessThan(1.5);
    }
  });

  it("shrinks harder as the shrinkage constant grows", () => {
    const light = buildDefenseFactors(weeks, PPR, 1);
    const heavy = buildDefenseFactors(weeks, PPR, 10_000);
    for (const [key, value] of heavy) {
      expect(Math.abs(value - 1)).toBeLessThanOrEqual(Math.abs((light.get(key) ?? 1) - 1) + 1e-9);
    }
  });

  it("produces no factors from an empty input", () => {
    expect(buildDefenseFactors([], PPR, 30).size).toBe(0);
  });
});

describe("projectPlayer", () => {
  const chase = historyFor("Ja'Marr Chase");

  it("has usable fixture history", () => {
    expect(chase.length).toBeGreaterThanOrEqual(5);
  });

  it("contributions sum exactly to the mean", () => {
    const projection = project(chase, "WR");
    const summed = round2(projection.contributions.reduce((s, c) => s + c.points, 0));
    expect(summed).toBe(projection.mean);
  });

  it("keeps floor <= mean <= ceiling", () => {
    const projection = project(chase, "WR");
    expect(projection.floor).toBeLessThanOrEqual(projection.mean);
    expect(projection.mean).toBeLessThanOrEqual(projection.ceiling);
    expect(projection.floor).toBeGreaterThanOrEqual(0);
  });

  it("derives the band from the position's measured quantiles", () => {
    const projection = project(chase, "WR");
    expect(projection.ceiling).toBe(round2(projection.mean * OUTCOME_QUANTILES.WR.p90));
  });

  it("is deterministic", () => {
    const first = project(chase, "WR");
    for (let i = 0; i < 10; i += 1) expect(project(chase, "WR")).toEqual(first);
  });

  it("stamps the model version so a projection is reproducible", () => {
    expect(project(chase, "WR").modelVersion).toBe(MODEL_VERSION);
  });

  it("handles a player with no history without throwing", () => {
    const projection = project([], "WR");
    expect(projection.mean).toBe(0);
    expect(projection.floor).toBe(0);
    expect(Number.isFinite(projection.mean)).toBe(true);
  });

  it("handles a single game of history", () => {
    const projection = project(chase.slice(0, 1), "WR");
    expect(projection.mean).toBeGreaterThan(0);
  });

  it("always includes a recent-production term for a scoring player", () => {
    const keys = project(chase, "WR").contributions.map((c) => c.key);
    expect(keys).toContain("base.form");
  });

  it("gives every contribution a non-empty label and explanation", () => {
    for (const contribution of project(chase, "WR").contributions) {
      expect(contribution.label.length).toBeGreaterThan(0);
      expect(contribution.detail.length).toBeGreaterThan(0);
      expect(Number.isFinite(contribution.points)).toBe(true);
    }
  });

  it("responds to scoring rules", () => {
    const ppr = projectPlayer({
      competitorId: "x",
      position: "WR",
      period: { season: 2025, index: 9 },
      history: chase,
      game: null,
      scoring: PPR,
    });
    const standard = projectPlayer({
      competitorId: "x",
      position: "WR",
      period: { season: 2025, index: 9 },
      history: chase,
      game: null,
      scoring: STANDARD,
    });
    expect(ppr.mean).toBeGreaterThan(standard.mean);
  });

  it("applies the calibration factor in the expected direction", () => {
    // Every skill-position factor is below 1, so calibration must reduce the projection.
    const projection = project(chase, "WR");
    const calibration = projection.contributions.find((c) => c.key === "model.calibration");
    expect(CALIBRATION.WR).toBeLessThan(1);
    expect(calibration?.points).toBeLessThan(0);
  });

  describe("game environment", () => {
    const highScoring: GameContext = {
      opponent: null,
      impliedTeamTotal: 30,
      teamMeanImpliedTotal: 22,
    };
    const lowScoring: GameContext = {
      opponent: null,
      impliedTeamTotal: 15,
      teamMeanImpliedTotal: 22,
    };

    it("raises a projection in a game the market expects to be high scoring", () => {
      expect(project(chase, "WR", highScoring).mean).toBeGreaterThan(
        project(chase, "WR", NO_GAME).mean,
      );
    });

    it("lowers a projection in a game the market expects to be low scoring", () => {
      expect(project(chase, "WR", lowScoring).mean).toBeLessThan(
        project(chase, "WR", NO_GAME).mean,
      );
    });

    it("does not adjust when the game matches the team's own norm", () => {
      const neutral: GameContext = {
        opponent: null,
        impliedTeamTotal: 22,
        teamMeanImpliedTotal: 22,
      };
      expect(project(chase, "WR", neutral).mean).toBe(project(chase, "WR", NO_GAME).mean);
    });

    it("clamps the adjustment on an extreme line", () => {
      const absurd: GameContext = {
        opponent: null,
        impliedTeamTotal: 500,
        teamMeanImpliedTotal: 22,
      };
      const clamped: GameContext = {
        opponent: null,
        impliedTeamTotal: 22 * 1.2,
        teamMeanImpliedTotal: 22,
      };
      expect(project(chase, "WR", absurd).mean).toBe(project(chase, "WR", clamped).mean);
    });
  });

  describe("matchup", () => {
    it("raises against a soft defense and lowers against a strong one", () => {
      const game: GameContext = {
        opponent: "NYJ",
        impliedTeamTotal: null,
        teamMeanImpliedTotal: null,
      };
      const soft = projectPlayer({
        competitorId: "x",
        position: "WR",
        period: { season: 2025, index: 9 },
        history: chase,
        game,
        scoring: PPR,
        defenseFactors: new Map([["NYJ:WR", 1.1]]),
      });
      const strong = projectPlayer({
        competitorId: "x",
        position: "WR",
        period: { season: 2025, index: 9 },
        history: chase,
        game,
        scoring: PPR,
        defenseFactors: new Map([["NYJ:WR", 0.9]]),
      });
      expect(soft.mean).toBeGreaterThan(strong.mean);
    });

    it("ignores a matchup with no factor available", () => {
      const game: GameContext = {
        opponent: "NYJ",
        impliedTeamTotal: null,
        teamMeanImpliedTotal: null,
      };
      const withEmpty = projectPlayer({
        competitorId: "x",
        position: "WR",
        period: { season: 2025, index: 9 },
        history: chase,
        game,
        scoring: PPR,
        defenseFactors: new Map(),
      });
      expect(withEmpty.mean).toBe(project(chase, "WR", NO_GAME).mean);
    });
  });

  it("projects every fantasy-scorable player in the fixture without error", () => {
    // The fixture also contains IDP defenders, which `toRegularSeasonPlayerWeeks`
    // correctly drops: they are not scored as individual fantasy players. What remains
    // is the skill-position cast plus kickers.
    const names = [...new Set(weeks.map((w) => w.competitor.name))];
    let projected = 0;
    for (const name of names) {
      const history = historyFor(name);
      if (history.length === 0) continue;
      const position = history[0].competitor.position;
      const projection = project(history, position);
      expect(Number.isFinite(projection.mean), `${name} produced a non-finite mean`).toBe(
        true,
      );
      expect(projection.floor).toBeLessThanOrEqual(projection.ceiling);
      projected += 1;
    }
    expect(projected).toBe(names.length);
    expect(projected).toBeGreaterThanOrEqual(12);
  });

  it("drops non-scorable positions from the parsed fixture", () => {
    const positions = new Set(weeks.map((w) => w.competitor.position));
    expect([...positions].sort()).toEqual(["K", "QB", "RB", "TE", "WR"]);
  });
});
