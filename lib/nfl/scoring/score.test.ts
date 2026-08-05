import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { num, parseCsv } from "../csv";
import { toRegularSeasonPlayerWeeks } from "../stats/parse";

import { HALF_PPR, PPR, STANDARD, scoringPresetById } from "./presets";
import { resolveTier, round2, scoreDefense, scoreKicker, scoreOffense } from "./score";
import { EMPTY_STAT_LINE, type DefenseStatLine, type KickerStatLine } from "./types";

const statsCsv = readFileSync(
  join(__dirname, "../../../tests/fixtures/stats_player_week_sample.csv"),
  "utf8",
);

function offense(overrides: Partial<typeof EMPTY_STAT_LINE>) {
  return { ...EMPTY_STAT_LINE, ...overrides };
}

const NO_KICKS: KickerStatLine = {
  made0to19: 0,
  made20to29: 0,
  made30to39: 0,
  made40to49: 0,
  made50to59: 0,
  made60plus: 0,
  missed: 0,
  patMade: 0,
  patMissed: 0,
};

const NO_DEFENSE: DefenseStatLine = {
  sacks: 0,
  interceptions: 0,
  fumbleRecoveries: 0,
  defensiveTds: 0,
  specialTeamsTds: 0,
  safeties: 0,
  pointsAllowed: 0,
  yardsAllowed: null,
};

describe("round2", () => {
  it("quantizes to two decimals", () => {
    expect(round2(10.68)).toBe(10.68);
    expect(round2(0.045)).toBe(0.05);
    expect(round2(1 / 3)).toBe(0.33);
  });

  it("rounds half away from zero and never yields -0", () => {
    expect(round2(-0.045)).toBe(-0.05);
    expect(round2(-0.001)).toBe(0);
    expect(Object.is(round2(-0.001), -0)).toBe(false);
  });

  it("rounds decimal half-ties correctly despite binary representation", () => {
    // 1.005 * 100 is 100.49999999999999, so a naive scale-and-round returns 1.00.
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(8.615)).toBe(8.62);
  });

  it("handles non-finite input without producing NaN", () => {
    expect(round2(Number.NaN)).toBe(0);
    expect(round2(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("tames binary floating point error", () => {
    // 0.04 * 3 is 0.12000000000000001 in IEEE-754.
    expect(round2(0.04 * 3)).toBe(0.12);
  });
});

describe("resolveTier", () => {
  const tiers = PPR.defense.pointsAllowedTiers;

  it.each([
    [0, 10],
    [1, 7],
    [6, 7],
    [7, 4],
    [13, 4],
    [14, 1],
    [20, 1],
    [21, 0],
    [27, 0],
    [28, -1],
    [34, -1],
    [35, -4],
    [70, -4],
  ])("scores %i points allowed as %i", (allowed, expected) => {
    expect(resolveTier(allowed, tiers)).toBe(expected);
  });

  it("treats bands as inclusive-min and exclusive-max, tiling without overlap", () => {
    for (let allowed = 0; allowed <= 60; allowed += 1) {
      const matches = tiers.filter(
        (t) => allowed >= t.min && (t.max === null || allowed < t.max),
      );
      expect(matches, `exactly one band must match ${allowed}`).toHaveLength(1);
    }
  });

  it("returns zero when no band matches", () => {
    expect(resolveTier(5, [{ min: 10, max: 20, points: 3 }])).toBe(0);
  });
});

describe("scoreOffense", () => {
  it("scores a full quarterback line", () => {
    // 300 * 0.04 = 12, +3 TD = 12, -1 INT = -2, 20 rush yds = 2, 1 rush TD = 6
    const result = scoreOffense(
      offense({
        passingYards: 300,
        passingTds: 3,
        passingInterceptions: 1,
        rushingYards: 20,
        rushingTds: 1,
      }),
      PPR,
    );
    expect(result.total).toBe(30);
  });

  it.each([
    [PPR, 20.5],
    [HALF_PPR, 18],
    [STANDARD, 15.5],
  ])("varies reception credit by ruleset (%s)", (rules, expected) => {
    // 5 receptions, 95 yards, 1 TD => 9.5 + 6 = 15.5 before reception points.
    const result = scoreOffense(
      offense({ receptions: 5, receivingYards: 95, receivingTds: 1 }),
      rules,
    );
    expect(result.total).toBe(expected);
  });

  it("charges fumbles lost and credits two-point conversions", () => {
    expect(scoreOffense(offense({ fumblesLost: 2 }), PPR).total).toBe(-4);
    expect(
      scoreOffense(offense({ rushing2ptConversions: 1, receiving2ptConversions: 1 }), PPR)
        .total,
    ).toBe(4);
  });

  it("credits return touchdowns", () => {
    expect(scoreOffense(offense({ specialTeamsTds: 1 }), PPR).total).toBe(6);
  });

  it("scores an empty line as zero with no components", () => {
    const result = scoreOffense(EMPTY_STAT_LINE, PPR);
    expect(result.total).toBe(0);
    expect(result.components).toEqual([]);
  });

  it("omits zero-valued components but keeps negative ones", () => {
    const result = scoreOffense(offense({ receivingYards: 50, fumblesLost: 1 }), PPR);
    const labels = result.components.map((c) => c.label);
    expect(labels).toContain("Receiving yards");
    expect(labels).toContain("Fumbles lost");
    expect(labels).not.toContain("Passing yards");
  });
});

describe("scoreKicker", () => {
  it("scores field goals by distance band", () => {
    // 3 + 4 + 5 = 12, plus 2 extra points.
    const result = scoreKicker(
      { ...NO_KICKS, made30to39: 1, made40to49: 1, made50to59: 1, patMade: 2 },
      PPR,
    );
    expect(result.total).toBe(14);
  });

  it("penalizes misses", () => {
    expect(scoreKicker({ ...NO_KICKS, made20to29: 1, missed: 2 }, PPR).total).toBe(1);
    expect(scoreKicker({ ...NO_KICKS, patMade: 3, patMissed: 1 }, PPR).total).toBe(2);
  });

  it("scores a perfect long-range day", () => {
    expect(scoreKicker({ ...NO_KICKS, made60plus: 2 }, PPR).total).toBe(10);
  });
});

describe("scoreDefense", () => {
  it("combines turnovers, pressure, and the points-allowed tier", () => {
    // 3 sacks = 3, 2 INT = 4, 1 fumble = 2, 1 TD = 6, shutout = 10
    const result = scoreDefense(
      {
        ...NO_DEFENSE,
        sacks: 3,
        interceptions: 2,
        fumbleRecoveries: 1,
        defensiveTds: 1,
        pointsAllowed: 0,
      },
      PPR,
    );
    expect(result.total).toBe(25);
  });

  it.each([
    [0, 10],
    [3, 7],
    [10, 4],
    [17, 1],
    [24, 0],
    [31, -1],
    [42, -4],
  ])("applies the tier for %i points allowed", (allowed, expected) => {
    expect(scoreDefense({ ...NO_DEFENSE, pointsAllowed: allowed }, PPR).total).toBe(
      expected,
    );
  });

  it("ignores yardage tiers unless the ruleset defines them", () => {
    const withYards = { ...NO_DEFENSE, pointsAllowed: 24, yardsAllowed: 250 };
    expect(scoreDefense(withYards, PPR).total).toBe(0);

    const yardageRules = {
      ...PPR,
      defense: {
        ...PPR.defense,
        yardsAllowedTiers: [{ min: 0, max: 300, points: 5 }],
      },
    };
    expect(scoreDefense(withYards, yardageRules).total).toBe(5);
  });

  it("credits safeties", () => {
    expect(
      scoreDefense({ ...NO_DEFENSE, safeties: 1, pointsAllowed: 24 }, PPR).total,
    ).toBe(2);
  });
});

describe("breakdown invariant", () => {
  it("components always sum to the total", () => {
    const cases = [
      scoreOffense(
        offense({
          passingYards: 287,
          passingTds: 2,
          passingInterceptions: 1,
          rushingYards: 31,
          receptions: 3,
          receivingYards: 44,
          fumblesLost: 1,
        }),
        PPR,
      ),
      scoreKicker({ ...NO_KICKS, made40to49: 2, made50to59: 1, missed: 1, patMade: 3 }, PPR),
      scoreDefense(
        { ...NO_DEFENSE, sacks: 5, interceptions: 1, pointsAllowed: 17 },
        PPR,
      ),
    ];
    for (const result of cases) {
      const summed = round2(result.components.reduce((a, c) => a + c.points, 0));
      expect(summed).toBe(result.total);
    }
  });
});

describe("scoringPresetById", () => {
  it("resolves known ids and falls back to PPR", () => {
    expect(scoringPresetById("standard").id).toBe("standard");
    expect(scoringPresetById("half_ppr").id).toBe("half_ppr");
    expect(scoringPresetById("nonsense").id).toBe("ppr");
    expect(scoringPresetById(null).id).toBe("ppr");
  });
});

/**
 * The strongest test in the suite: our engine must reproduce upstream's own fantasy point
 * columns exactly. Those columns were derived empirically (interception -2, fumble lost
 * -2) and agree on every offensive player-week in the source data, so any drift in the
 * scoring tables or the column mapping fails here.
 */
describe("agreement with upstream fantasy point columns", () => {
  const weeks = toRegularSeasonPlayerWeeks(parseCsv(statsCsv)).filter(
    (w) => w.competitor.position !== "K",
  );
  const rowsById = new Map(
    parseCsv(statsCsv).map((r) => [`${r.player_id}:${r.week}`, r]),
  );

  it("has a meaningful number of rows to check", () => {
    expect(weeks.length).toBeGreaterThan(50);
  });

  it("matches fantasy_points for standard scoring on every row", () => {
    for (const week of weeks) {
      const row = rowsById.get(`${week.competitor.id}:${week.period.index}`);
      expect(row).toBeDefined();
      const expected = round2(num(row!, "fantasy_points"));
      const actual = scoreOffense(week.stats, STANDARD).total;
      expect(
        actual,
        `${week.competitor.name} week ${week.period.index} standard`,
      ).toBeCloseTo(expected, 2);
    }
  });

  it("matches fantasy_points_ppr for PPR scoring on every row", () => {
    for (const week of weeks) {
      const row = rowsById.get(`${week.competitor.id}:${week.period.index}`);
      const expected = round2(num(row!, "fantasy_points_ppr"));
      const actual = scoreOffense(week.stats, PPR).total;
      expect(
        actual,
        `${week.competitor.name} week ${week.period.index} PPR`,
      ).toBeCloseTo(expected, 2);
    }
  });

  it("half-PPR sits exactly halfway between standard and PPR", () => {
    for (const week of weeks) {
      const standard = scoreOffense(week.stats, STANDARD).total;
      const ppr = scoreOffense(week.stats, PPR).total;
      const half = scoreOffense(week.stats, HALF_PPR).total;
      expect(half).toBeCloseTo(round2((standard + ppr) / 2), 2);
    }
  });
});
