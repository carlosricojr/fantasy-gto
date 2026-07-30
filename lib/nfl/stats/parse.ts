import type { Competitor, Period } from "@/lib/core/domain";
import { type CsvRow, num, str } from "@/lib/nfl/csv";
import { normalizeTeam } from "@/lib/nfl/teams";
import type { KickerStatLine, Position, StatLine } from "@/lib/nfl/scoring/types";

/**
 * Pure mapping from an nflverse `stats_player_week` row to domain types.
 *
 * Kept free of any I/O so it can be exercised directly against checked-in fixtures. The
 * fetching half lives in `nflverse.ts`.
 *
 * Column names are taken from the current `stats_player` release and differ from the
 * retired `player_stats` release in ways that fail silently rather than loudly — the old
 * release spelled these `interceptions`, `sacks`, and `recent_team`. Reading a name that
 * does not exist yields zero, so a stale name produces a plausible-looking projection
 * built from nothing. `docs/data-sources.md` records the verified spellings.
 */

/** Positions that are scored as individual fantasy players. */
const SCORABLE_POSITIONS: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE", "K"]);

/** Maps an upstream position code to ours, or `null` if it is not fantasy-scorable. */
export function toPosition(raw: string): Position | null {
  const code = raw.trim().toUpperCase();
  // Fullbacks are scored as running backs; every mainstream platform does this.
  if (code === "FB") return "RB";
  return SCORABLE_POSITIONS.has(code) ? (code as Position) : null;
}

export function toPeriod(row: CsvRow): Period {
  return { season: num(row, "season"), index: num(row, "week") };
}

/**
 * A competitor whose position is known to be fantasy-scorable.
 *
 * The shared `Competitor` carries `position` as an open string so the core stays
 * sport-agnostic. This narrows it back down for NFL code, which lets the scoring engine
 * and the model index position-keyed tables without a cast or a runtime check.
 */
export interface NflCompetitor extends Competitor {
  position: Position;
}

export function toCompetitor(row: CsvRow): NflCompetitor | null {
  const id = str(row, "player_id");
  const position = toPosition(str(row, "position"));
  if (id === "" || position === null) return null;
  return {
    id,
    name: str(row, "player_display_name") || str(row, "player_name"),
    position,
    team: normalizeTeam(str(row, "team")),
  };
}

/**
 * Extracts offensive production.
 *
 * Fumbles are summed across the three phases upstream tracks them in. Only fumbles
 * *lost* are charged, because a recovered fumble costs the fantasy team nothing.
 */
export function toStatLine(row: CsvRow): StatLine {
  return {
    passingYards: num(row, "passing_yards"),
    passingTds: num(row, "passing_tds"),
    passingInterceptions: num(row, "passing_interceptions"),
    passing2ptConversions: num(row, "passing_2pt_conversions"),
    rushingYards: num(row, "rushing_yards"),
    rushingTds: num(row, "rushing_tds"),
    rushing2ptConversions: num(row, "rushing_2pt_conversions"),
    receptions: num(row, "receptions"),
    receivingYards: num(row, "receiving_yards"),
    receivingTds: num(row, "receiving_tds"),
    receiving2ptConversions: num(row, "receiving_2pt_conversions"),
    fumblesLost:
      num(row, "sack_fumbles_lost") +
      num(row, "rushing_fumbles_lost") +
      num(row, "receiving_fumbles_lost"),
    specialTeamsTds: num(row, "special_teams_tds"),
  };
}

/**
 * Extracts kicking production.
 *
 * Upstream reports makes by distance band but only a single `fg_missed` total, so misses
 * are not attributable to a band. That is fine: no mainstream ruleset varies the penalty
 * by distance.
 */
export function toKickerStatLine(row: CsvRow): KickerStatLine {
  return {
    made0to19: num(row, "fg_made_0_19"),
    made20to29: num(row, "fg_made_20_29"),
    made30to39: num(row, "fg_made_30_39"),
    made40to49: num(row, "fg_made_40_49"),
    made50to59: num(row, "fg_made_50_59"),
    made60plus: num(row, "fg_made_60_"),
    missed: num(row, "fg_missed"),
    patMade: num(row, "pat_made"),
    patMissed: num(row, "pat_missed"),
  };
}

/** Usage signals. More stable week to week than fantasy points, so the model leans on them. */
export interface UsageLine {
  targets: number;
  carries: number;
  passAttempts: number;
  targetShare: number;
  airYardsShare: number;
  /** Weighted opportunity rating: combines target share and air yards share. */
  wopr: number;
}

export function toUsageLine(row: CsvRow): UsageLine {
  return {
    targets: num(row, "targets"),
    carries: num(row, "carries"),
    passAttempts: num(row, "attempts"),
    targetShare: num(row, "target_share"),
    airYardsShare: num(row, "air_yards_share"),
    wopr: num(row, "wopr"),
  };
}

/** A fully parsed player-week: identity, context, production, and usage. */
export interface PlayerWeek {
  competitor: NflCompetitor;
  period: Period;
  seasonType: string;
  contestId: string;
  opponent: string | null;
  stats: StatLine;
  kicking: KickerStatLine;
  usage: UsageLine;
}

/** Parses one row, or returns `null` if it is not a scorable fantasy player. */
export function toPlayerWeek(row: CsvRow): PlayerWeek | null {
  const competitor = toCompetitor(row);
  if (competitor === null) return null;
  return {
    competitor,
    period: toPeriod(row),
    seasonType: str(row, "season_type"),
    contestId: str(row, "game_id"),
    opponent: normalizeTeam(str(row, "opponent_team")),
    stats: toStatLine(row),
    kicking: toKickerStatLine(row),
    usage: toUsageLine(row),
  };
}

/**
 * Parses many rows, keeping only regular-season rows for scorable positions.
 *
 * Postseason weeks are excluded because fantasy leagues conclude before them, and mixing
 * them into a player's history would let January production leak into a September
 * projection.
 */
export function toRegularSeasonPlayerWeeks(rows: readonly CsvRow[]): PlayerWeek[] {
  const out: PlayerWeek[] = [];
  for (const row of rows) {
    if (str(row, "season_type") !== "REG") continue;
    const parsed = toPlayerWeek(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
