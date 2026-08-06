import { type CsvRow, num, str } from "./csv";
import { normalizeTeam } from "./teams";

/**
 * The weekly injury report.
 *
 * The strongest pre-kickoff signal found anywhere in this project's scoping, and the only
 * one that is genuinely absent from the box score: whether a team told the league, before
 * the game, that a player might not be himself.
 *
 * Two hazards shape this file.
 *
 * **The header drifts between seasons.** 2024 carries `game_type` and `date_modified`;
 * 2025 carries `game_type` *and* `season_type` and no `date_modified`. Filtering on
 * `season_type` alone discards 100% of 2024 and yields a clean-looking result built from
 * nothing — a debugging cycle was already lost to exactly that. `game_type` is present in
 * both and is what this parses.
 *
 * **Fields contain newlines.** 48 records in the 2024 file have a `practice_status` of
 * `"\n    "` — a quoted field spanning lines. Splitting the file on newlines shifts every
 * subsequent column. `lib/nfl/csv.ts` handles it; this is recorded so nobody re-introduces
 * a faster parse.
 *
 * Leakage is answered in `docs/data-sources.md` and summarised on `InjuryReport.dateModified`.
 */

/**
 * The game-status designation a team publishes before kickoff.
 *
 * `none` means the player appears on the report — usually with a practice limitation — but
 * carries no game designation. That is not the same as being absent from the report
 * altogether, and conflating them would put every healthy player in the same bucket as
 * everyone listed and cleared.
 */
export type GameStatus = "out" | "doubtful" | "questionable" | "none" | "unknown";

/** How much of the week's practice the player took part in. */
export type PracticeStatus =
  | "full"
  | "limited"
  | "did-not-participate"
  | "none"
  | "unknown";

export interface InjuryReport {
  season: number;
  week: number;
  /** `gsis_id` upstream, joining directly to `stats_player_week`. */
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  gameStatus: GameStatus;
  practiceStatus: PracticeStatus;
  primaryInjury: string;
  /**
   * When upstream last touched this row, or `null`.
   *
   * Present in 2024 and absent in 2025, which is the whole difficulty with establishing
   * that this data is pre-kickoff. Where it exists it is checkable — and it checks out.
   * See `docs/data-sources.md`.
   */
  dateModified: string | null;
}

/** Counts of values the parser did not recognise, so drift is visible rather than coerced. */
export interface InjuryParseReport {
  reports: InjuryReport[];
  /** Rows whose `report_status` was not a known designation, keyed by the raw value. */
  unknownGameStatus: Map<string, number>;
  /** Rows whose `practice_status` was not a known participation level. */
  unknownPracticeStatus: Map<string, number>;
}

const GAME_STATUS: ReadonlyMap<string, GameStatus> = new Map([
  ["out", "out"],
  ["doubtful", "doubtful"],
  ["questionable", "questionable"],
]);

const PRACTICE_STATUS: ReadonlyMap<string, PracticeStatus> = new Map([
  ["full participation in practice", "full"],
  ["limited participation in practice", "limited"],
  ["did not participate in practice", "did-not-participate"],
]);

/**
 * Maps an upstream designation onto the closed union.
 *
 * A blank — including the whitespace-and-newline blanks upstream actually ships — is
 * `none`. Anything else unrecognised is `unknown` **and counted**, never quietly folded
 * into `none`: upstream ships a literal `Note` in both columns, and silently treating that
 * as "no designation" is how a new status value would go unnoticed for a season.
 */
export function toGameStatus(raw: string): GameStatus {
  const key = raw.trim().toLowerCase();
  if (key === "") return "none";
  return GAME_STATUS.get(key) ?? "unknown";
}

export function toPracticeStatus(raw: string): PracticeStatus {
  const key = raw.trim().toLowerCase();
  if (key === "") return "none";
  return PRACTICE_STATUS.get(key) ?? "unknown";
}

function count(map: Map<string, number>, raw: string): void {
  const key = raw.trim();
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Parses the regular-season rows of one season's injury file.
 *
 * Filtered on `game_type`, which both header shapes carry. `season_type` exists only from
 * 2025 and filtering on it discards every earlier season in silence.
 *
 * A row with no `gsis_id` is dropped: it cannot be joined to a projection, so keeping it
 * would inflate the row count without adding a usable record.
 */
export function toRegularSeasonInjuries(rows: readonly CsvRow[]): InjuryParseReport {
  const reports: InjuryReport[] = [];
  const unknownGameStatus = new Map<string, number>();
  const unknownPracticeStatus = new Map<string, number>();

  for (const row of rows) {
    if (str(row, "game_type") !== "REG") continue;
    const playerId = str(row, "gsis_id");
    if (playerId === "") continue;

    const rawGame = str(row, "report_status");
    const rawPractice = str(row, "practice_status");
    const gameStatus = toGameStatus(rawGame);
    const practiceStatus = toPracticeStatus(rawPractice);
    if (gameStatus === "unknown") count(unknownGameStatus, rawGame);
    if (practiceStatus === "unknown") count(unknownPracticeStatus, rawPractice);

    reports.push({
      season: num(row, "season"),
      week: num(row, "week"),
      playerId,
      name: str(row, "full_name"),
      position: str(row, "position").toUpperCase(),
      team: normalizeTeam(str(row, "team")),
      gameStatus,
      practiceStatus,
      primaryInjury: str(row, "report_primary_injury"),
      // Absent from 2025 entirely, so `null` is the normal case rather than an error.
      dateModified: str(row, "date_modified") || null,
    });
  }

  return { reports, unknownGameStatus, unknownPracticeStatus };
}

/** Key for joining a report to a player-week. */
export function injuryKey(playerId: string, season: number, week: number): string {
  return `${season}:${week}:${playerId}`;
}

/**
 * Indexes reports for lookup against a projection.
 *
 * A player can appear once per week, so a later row for the same key replaces an earlier
 * one. That is deliberate and matches upstream, where a corrected row supersedes.
 */
export function indexInjuries(
  reports: readonly InjuryReport[],
): Map<string, InjuryReport> {
  const index = new Map<string, InjuryReport>();
  for (const report of reports) {
    index.set(injuryKey(report.playerId, report.season, report.week), report);
  }
  return index;
}
