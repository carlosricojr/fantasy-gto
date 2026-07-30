import type {
  DefenseScoringRules,
  KickerScoringRules,
  OffenseScoringRules,
  ScoringRules,
  ScoringTier,
} from "./types";

/**
 * Scoring presets.
 *
 * The offensive values match the formula used by nflverse's `fantasy_points` /
 * `fantasy_points_ppr` columns, which was derived empirically rather than recalled:
 * across 6,020 real 2025 player-weeks, these values reproduce both columns exactly.
 * That agreement is asserted in `score.test.ts`, so a regression here fails loudly.
 *
 * The same values are the long-standing ESPN defaults, which is why one table serves as
 * both our canonical scoring and the baseline we validate against.
 */

const BASE_OFFENSE: OffenseScoringRules = {
  // One point per 25 passing yards.
  passingYardsPerPoint: 0.04,
  passingTd: 4,
  passingInterception: -2,
  // One point per 10 rushing or receiving yards.
  rushingYardsPerPoint: 0.1,
  rushingTd: 6,
  receptionPoints: 0,
  receivingYardsPerPoint: 0.1,
  receivingTd: 6,
  fumbleLost: -2,
  twoPointConversion: 2,
  specialTeamsTd: 6,
};

const KICKER: KickerScoringRules = {
  fg0to19: 3,
  fg20to29: 3,
  fg30to39: 3,
  fg40to49: 4,
  fg50to59: 5,
  fg60plus: 5,
  fgMissed: -1,
  patMade: 1,
  patMissed: -1,
};

/**
 * The standard points-allowed ladder. Bands are inclusive of `min` and exclusive of
 * `max`, so they tile the whole range without overlap or gaps.
 */
const POINTS_ALLOWED_TIERS: readonly ScoringTier[] = [
  { min: 0, max: 1, points: 10 },
  { min: 1, max: 7, points: 7 },
  { min: 7, max: 14, points: 4 },
  { min: 14, max: 21, points: 1 },
  { min: 21, max: 28, points: 0 },
  { min: 28, max: 35, points: -1 },
  { min: 35, max: null, points: -4 },
];

const DEFENSE: DefenseScoringRules = {
  sack: 1,
  interception: 2,
  fumbleRecovery: 2,
  defensiveTd: 6,
  specialTeamsTd: 6,
  safety: 2,
  pointsAllowedTiers: POINTS_ALLOWED_TIERS,
  yardsAllowedTiers: null,
};

function withReceptionPoints(
  id: string,
  label: string,
  receptionPoints: number,
): ScoringRules {
  return {
    id,
    label,
    offense: { ...BASE_OFFENSE, receptionPoints },
    kicker: KICKER,
    defense: DEFENSE,
  };
}

/** No points per reception. */
export const STANDARD: ScoringRules = withReceptionPoints(
  "standard",
  "Standard",
  0,
);

/** Half a point per reception. */
export const HALF_PPR: ScoringRules = withReceptionPoints(
  "half_ppr",
  "Half PPR",
  0.5,
);

/** One point per reception. The most common format, and the product default. */
export const PPR: ScoringRules = withReceptionPoints("ppr", "PPR", 1);

export const SCORING_PRESETS: readonly ScoringRules[] = [PPR, HALF_PPR, STANDARD];

export const DEFAULT_SCORING: ScoringRules = PPR;

/** Looks up a preset by id, falling back to the default rather than throwing. */
export function scoringPresetById(id: string | null | undefined): ScoringRules {
  return SCORING_PRESETS.find((preset) => preset.id === id) ?? DEFAULT_SCORING;
}
