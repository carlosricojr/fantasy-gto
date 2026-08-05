import type { TeamAbbr } from "../teams";

/** Roster positions the product scores and projects. */
export const POSITIONS = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
export type Position = (typeof POSITIONS)[number];

/**
 * A single player's production in a single game, normalized from upstream.
 *
 * Every field is a count or a yardage total, never a rate, so the scoring engine is a
 * pure linear function of this record and nothing has to be re-derived downstream.
 */
export interface StatLine {
  // Passing
  passingYards: number;
  passingTds: number;
  passingInterceptions: number;
  passing2ptConversions: number;
  // Rushing
  rushingYards: number;
  rushingTds: number;
  rushing2ptConversions: number;
  // Receiving
  receptions: number;
  receivingYards: number;
  receivingTds: number;
  receiving2ptConversions: number;
  // Turnovers charged to the player, from any phase.
  fumblesLost: number;
  // Return and special teams touchdowns.
  specialTeamsTds: number;
}

/** Field goal distance bands, matching how every mainstream platform scores kickers. */
export interface FieldGoalsByDistance {
  made0to19: number;
  made20to29: number;
  made30to39: number;
  made40to49: number;
  made50to59: number;
  made60plus: number;
  missed: number;
}

/** A kicker's production in a single game. */
export interface KickerStatLine extends FieldGoalsByDistance {
  patMade: number;
  patMissed: number;
}

/** A team defense's production in a single game. */
export interface DefenseStatLine {
  sacks: number;
  interceptions: number;
  fumbleRecoveries: number;
  defensiveTds: number;
  specialTeamsTds: number;
  safeties: number;
  /** Points the defense's own team conceded. Drives the tiered bonus. */
  pointsAllowed: number;
  /** Total yards conceded. Only used when the ruleset enables yardage tiers. */
  yardsAllowed: number | null;
}

/** Points awarded per unit of a counting statistic. */
export interface OffenseScoringRules {
  passingYardsPerPoint: number;
  passingTd: number;
  passingInterception: number;
  rushingYardsPerPoint: number;
  rushingTd: number;
  receptionPoints: number;
  receivingYardsPerPoint: number;
  receivingTd: number;
  fumbleLost: number;
  twoPointConversion: number;
  specialTeamsTd: number;
}

export interface KickerScoringRules {
  fg0to19: number;
  fg20to29: number;
  fg30to39: number;
  fg40to49: number;
  fg50to59: number;
  fg60plus: number;
  fgMissed: number;
  patMade: number;
  patMissed: number;
}

/** An inclusive-lower, exclusive-upper band mapping a conceded total to a bonus. */
export interface ScoringTier {
  /** Inclusive lower bound. */
  min: number;
  /** Exclusive upper bound. `null` means unbounded. */
  max: number | null;
  points: number;
}

export interface DefenseScoringRules {
  sack: number;
  interception: number;
  fumbleRecovery: number;
  defensiveTd: number;
  specialTeamsTd: number;
  safety: number;
  pointsAllowedTiers: readonly ScoringTier[];
  /** Optional; most ESPN leagues do not use yardage tiers. */
  yardsAllowedTiers: readonly ScoringTier[] | null;
}

export interface ScoringRules {
  readonly id: string;
  readonly label: string;
  readonly offense: OffenseScoringRules;
  readonly kicker: KickerScoringRules;
  readonly defense: DefenseScoringRules;
}

/** One named, signed term in a score. Components always sum to the total. */
export interface ScoreComponent {
  label: string;
  points: number;
}

/**
 * A score plus the itemized terms that produced it.
 *
 * The breakdown is not a debugging aid — it is what the product shows the user to explain
 * a number, so it is part of the contract and is asserted in tests to sum to `total`.
 */
export interface ScoreBreakdown {
  total: number;
  components: ScoreComponent[];
}

/** An empty stat line, for players who did not record a given phase of production. */
export const EMPTY_STAT_LINE: StatLine = {
  passingYards: 0,
  passingTds: 0,
  passingInterceptions: 0,
  passing2ptConversions: 0,
  rushingYards: 0,
  rushingTds: 0,
  rushing2ptConversions: 0,
  receptions: 0,
  receivingYards: 0,
  receivingTds: 0,
  receiving2ptConversions: 0,
  fumblesLost: 0,
  specialTeamsTds: 0,
};

/** Identity of a scored entity: a player, or a team for defenses. */
export interface PlayerRef {
  playerId: string;
  name: string;
  position: Position;
  team: TeamAbbr | null;
}
