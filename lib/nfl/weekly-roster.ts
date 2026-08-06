import { type CsvRow, num, str } from "./csv";
import { normalizeTeam } from "./teams";

/**
 * Weekly rosters — who was on which team, week by week.
 *
 * The one source that answers "which team is this player on?" **before a game has been
 * played**. Everything else in this project derives a player's team from an appearance,
 * which works from week 2 onward and is useless in the days before week 1 — the window in
 * which a user most wants a projection.
 *
 * That is not a hypothetical gap. `runProjectWeek` resolves teams from current-season
 * appearances, so at week 1 pre-kickoff nobody resolves, the team-coverage gate fails, and
 * the run deliberately writes nothing rather than serve a board of the two Thursday teams.
 * `convex/tests/ingest.test.ts` reproduces exactly that.
 *
 * Keyed on `gsis_id` + `week`, so it joins directly — no bridge needed.
 *
 * Parsing is pure; fetching is `lib/sources/nflverse.ts`.
 */

/**
 * Roster status, as a closed union.
 *
 * Measured on the 2025 file: `ACT` 27,377, `DEV` 8,783, `RES` 5,763, `INA` 3,593,
 * `CUT` 951, `RET` 361, and `EXE`, `TRD`, `TRC` at 7 each. Only `ACT` is a player who can
 * be projected; the rest are on the file and must not be.
 *
 * All nine are mapped explicitly. An unrecognised value maps to `unknown` and is counted
 * rather than folded into `active`, because a new code silently read as active would put a
 * practice-squad or injured-reserve player on a board as though he were starting. Leaving a
 * value that upstream *does* ship in the unknown bucket would be almost as bad in the other
 * direction: the counter is a drift alarm, and an alarm that fires on normal data stops
 * being read.
 */
export type RosterStatus =
  | "active"
  | "cut"
  | "practice-squad"
  | "reserve"
  | "inactive"
  | "retired"
  | "traded"
  | "unknown";

export interface WeeklyRosterEntry {
  season: number;
  week: number;
  /** `gsis_id` — the same identifier `stats_player_week` calls `player_id`. */
  playerId: string;
  name: string;
  position: string;
  team: string | null;
  status: RosterStatus;
}

export interface WeeklyRosterReport {
  entries: WeeklyRosterEntry[];
  /** Status values the parser did not recognise, so drift is visible rather than coerced. */
  unknownStatus: Map<string, number>;
}

const STATUS: ReadonlyMap<string, RosterStatus> = new Map([
  ["act", "active"],
  ["cut", "cut"],
  ["dev", "practice-squad"],
  ["res", "reserve"],
  ["ina", "inactive"],
  ["ret", "retired"],
  ["exe", "reserve"],
  ["trd", "traded"],
  ["trc", "traded"],
]);

export function toRosterStatus(raw: string): RosterStatus {
  const key = raw.trim().toLowerCase();
  if (key === "") return "unknown";
  return STATUS.get(key) ?? "unknown";
}

/**
 * Parses the regular-season rows of one season's weekly rosters.
 *
 * Filtered on `game_type`, matching every other nflverse parse here. A row with no
 * `gsis_id` is dropped: it cannot be joined to a projection or a history, so keeping it
 * would inflate the count without adding a usable record. Twenty-nine such rows exist in
 * the 2025 file, so this branch is live rather than defensive.
 */
export function toWeeklyRoster(rows: readonly CsvRow[]): WeeklyRosterReport {
  const entries: WeeklyRosterEntry[] = [];
  const unknownStatus = new Map<string, number>();

  for (const row of rows) {
    if (str(row, "game_type") !== "REG") continue;
    const playerId = str(row, "gsis_id");
    if (playerId === "") continue;

    const rawStatus = str(row, "status");
    const status = toRosterStatus(rawStatus);
    if (status === "unknown") {
      const key = rawStatus.trim();
      unknownStatus.set(key, (unknownStatus.get(key) ?? 0) + 1);
    }

    entries.push({
      season: num(row, "season"),
      week: num(row, "week"),
      playerId,
      name: str(row, "full_name"),
      position: str(row, "position").toUpperCase(),
      team: normalizeTeam(str(row, "team")),
      status,
    });
  }

  return { entries, unknownStatus };
}

/**
 * Every player's roster status for a given week, active or not.
 *
 * Separate from `teamsForWeek` because the two answer different questions. That one asks
 * "who can be projected"; this one asks "what does the roster say about this player" — and
 * a caller needs the second to know that a player it has *other* evidence for, such as an
 * appearance earlier in the season, has since been cut. Without it a player who played
 * weeks 1 to 5 and was released before week 6 is reinstated by his own history.
 *
 * **An active entry wins outright**, whatever its position. That is not arbitrary: it is
 * what keeps this function agreeing with `teamsForWeek`, which filters to active entries
 * before taking the first. A mid-week transaction ordered `[TRD@SF, ACT@MIN]` — and `TRD`
 * is a live code — would otherwise have `teamsForWeek` return MIN while this returned
 * `traded`, and a caller trusting both would drop a player who is plainly on a roster. An
 * earlier revision claimed "first entry wins, matching `teamsForWeek`", which was false in
 * exactly that case. Among non-active entries the first still wins, so the result stays a
 * function of file order rather than iteration order.
 */
export function statusesForWeek(
  entries: readonly WeeklyRosterEntry[],
  week: number,
): Map<string, RosterStatus> {
  const statuses = new Map<string, RosterStatus>();
  for (const entry of entries) {
    if (entry.week !== week) continue;
    const existing = statuses.get(entry.playerId);
    if (existing === "active") continue;
    if (existing !== undefined && entry.status !== "active") continue;
    statuses.set(entry.playerId, entry.status);
  }
  return statuses;
}

/**
 * The team each active player is on in a given week.
 *
 * Only `active` entries contribute. A cut, retired, or practice-squad player is on the file
 * and is not going to take a snap, and projecting one would put a name on the board that no
 * lineup can legitimately start.
 *
 * A player appears at most once per team per week, but a mid-week transaction can list him
 * on two. The first **active** entry wins — non-active entries are filtered before the
 * duplicate check — which makes the result a function of file order rather than of
 * iteration order. That is the same determinism rule `parseSeasonRoster` already follows,
 * and the reason is the same: a board that reshuffles between runs reads as a bug.
 * `statusesForWeek` resolves the same duplicate the same way, deliberately — with one
 * documented asymmetry: this function additionally requires a team `normalizeTeam` can
 * resolve, so an active entry carrying an unrecognised code appears there as `active` and
 * is absent here. Every code upstream ships is covered by `teams.ts`, so that is a
 * statement about the contract rather than an observed case.
 */
export function teamsForWeek(
  entries: readonly WeeklyRosterEntry[],
  week: number,
): Map<string, string> {
  const teams = new Map<string, string>();
  for (const entry of entries) {
    if (entry.week !== week) continue;
    if (entry.status !== "active") continue;
    if (entry.team === null) continue;
    if (teams.has(entry.playerId)) continue;
    teams.set(entry.playerId, entry.team);
  }
  return teams;
}
