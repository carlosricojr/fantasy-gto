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
 * **Offensive values are verified.** They match the formula behind nflverse's
 * `fantasy_points` / `fantasy_points_ppr` columns, derived empirically rather than
 * recalled: a one-off run over 6,020 real 2025 player-weeks reproduced both columns
 * exactly. What the suite guards continuously is narrower — `score.test.ts` re-checks that
 * agreement on every offensive row of the checked-in fixture — so a regression fails
 * loudly, but against roughly a hundred rows rather than the original six thousand.
 *
 * **Kicker and D/ST values are not.** No upstream column scores them, so there is nothing
 * to reproduce and nothing in the suite checks them against an external source. They are
 * the conventional ladder used by mainstream platforms, and they should be read as a
 * reasonable default rather than a verified one. Both are implemented and unit-tested for
 * internal consistency — the tiers tile the range without overlap or gaps — but neither
 * position is projected today (see the known gaps in the README), so nothing the product
 * shows depends on them yet. Wiring either into projections means validating these tiers
 * against the specific platform being mirrored first.
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
 * The conventional points-allowed ladder. Bands are inclusive of `min` and exclusive of
 * `max`, so they tile the whole range without overlap or gaps.
 *
 * Not validated against any external source — see the module header. Platforms differ on
 * these tiers and commissioners routinely change them.
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
