import { type CsvRow, num, str } from "./csv";

/**
 * The player directory: identity, age, experience, and draft capital.
 *
 * The model has no concept of age. Career phase, aging curves, and the whole trajectory
 * framing are impossible without one, and this is the only free source that carries a birth
 * date for essentially every player who has taken a snap.
 *
 * It is also the **bridge between two identifier systems**. `stats_player_week` is keyed on
 * `gsis_id`; `snap_counts` is keyed on `pfr_player_id`; nothing joins them directly. This
 * file carries both, and is the only reason snap share is reachable at all.
 *
 * Parsing lives here and stays pure. Fetching is `lib/sources/nflverse.ts`, which is the
 * only layer allowed to do I/O.
 */

/** One player, as upstream describes them. */
export interface PlayerProfile {
  /** `gsis_id` upstream — the same identifier `stats_player_week` calls `player_id`. */
  playerId: string;
  name: string;
  position: string;
  /** ISO `YYYY-MM-DD`, or `null` when upstream has none. Present on 99.8% of rows. */
  birthDate: string | null;
  /**
   * Pro Football Reference's identifier, or `null`.
   *
   * The join key for `snap_counts`. Absent on about a tenth of skill-position rows, and
   * **not** absent at random — see `docs/data-sources.md`.
   */
  pfrId: string | null;
  /** First season the player appeared, or `null`. */
  rookieSeason: number | null;
  /** Last season the player appeared, or `null` for an active player. */
  lastSeason: number | null;
  /** Completed seasons, as upstream counts them. */
  yearsExperience: number | null;
  draft: { year: number; round: number; pick: number } | null;
  status: string;
}

/** Reads a column as a positive integer, or `null` when blank or unparseable. */
function intOrNull(row: CsvRow, key: string): number | null {
  const raw = str(row, key);
  if (raw === "") return null;
  const value = num(row, key, Number.NaN);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses one player row.
 *
 * A row with no `gsis_id` is dropped: it cannot be joined to any production history, so it
 * would contribute a profile with nothing to attach it to. Upstream carries several
 * thousand such rows, mostly for players who never appeared in the modern statistics era.
 */
export function toPlayerProfile(row: CsvRow): PlayerProfile | null {
  const playerId = str(row, "gsis_id");
  if (playerId === "") return null;

  const draftYear = intOrNull(row, "draft_year");
  const draftRound = intOrNull(row, "draft_round");
  const draftPick = intOrNull(row, "draft_pick");

  return {
    playerId,
    name: str(row, "display_name"),
    position: str(row, "position").toUpperCase(),
    // Blank rather than absent is how upstream spells "unknown", and an empty string would
    // parse as an epoch date somewhere downstream. Kept explicitly null.
    birthDate: str(row, "birth_date") || null,
    pfrId: str(row, "pfr_id") || null,
    rookieSeason: intOrNull(row, "rookie_season"),
    lastSeason: intOrNull(row, "last_season"),
    yearsExperience: intOrNull(row, "years_of_experience"),
    // All three or nothing. A draft record missing its round is not a usable draft record,
    // and filling the gap with a zero would price an undrafted player as a first-rounder.
    draft:
      draftYear !== null && draftRound !== null && draftPick !== null
        ? { year: draftYear, round: draftRound, pick: draftPick }
        : null,
    status: str(row, "status"),
  };
}

export function toPlayerProfiles(rows: readonly CsvRow[]): PlayerProfile[] {
  const out: PlayerProfile[] = [];
  for (const row of rows) {
    const parsed = toPlayerProfile(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * Age in whole years on a given date.
 *
 * The clock is a parameter, never `Date.now()`. That is what makes an age feature
 * backtestable: replaying week 6 of 2017 has to compute the age the player was *then*, and a
 * function that reads the wall clock would silently give every historical row today's age
 * and quietly destroy any aging curve fitted on it. `lib/purity.test.ts` enforces the rule;
 * this docstring records why it exists.
 *
 * Both arguments are ISO `YYYY-MM-DD`. Returns `null` if either is missing or unparseable,
 * rather than a number that looks like an age.
 */
export function ageAt(birthDate: string | null, asOf: string): number | null {
  if (!birthDate) return null;
  const born = parseIsoDate(birthDate);
  const on = parseIsoDate(asOf);
  if (born === null || on === null) return null;

  let age = on.year - born.year;
  // Not yet had this year's birthday. Comparing month and day directly rather than
  // differencing timestamps keeps this exact across leap days and time zones — a
  // millisecond difference divided by 365.25 puts someone born on 29 February a day out
  // three years in four.
  if (on.month < born.month || (on.month === born.month && on.day < born.day)) {
    age -= 1;
  }
  return age;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function parseIsoDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Indexes profiles by their Pro Football Reference identifier.
 *
 * The bridge `snap_counts` needs. Players with no `pfr_id` are simply absent from the map,
 * which is what makes an unmatched snap row countable rather than silently zero.
 */
export function pfrBridge(profiles: readonly PlayerProfile[]): Map<string, PlayerProfile> {
  const bridge = new Map<string, PlayerProfile>();
  for (const profile of profiles) {
    if (profile.pfrId !== null) bridge.set(profile.pfrId, profile);
  }
  return bridge;
}
