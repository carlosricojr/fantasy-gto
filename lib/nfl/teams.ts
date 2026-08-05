/**
 * NFL team identity.
 *
 * Every abbreviation here was enumerated directly from the upstream `games.csv`
 * (seasons 1999–2026) rather than recalled. That file contains exactly 35 distinct
 * abbreviations: the 32 current teams plus three retired ones for relocated franchises
 * (`OAK`, `SD`, `STL`), with Houston absent before its 2002 expansion.
 *
 * Getting this wrong is not cosmetic. A team code that fails to normalize silently
 * splits one franchise's history into two, which corrupts every opponent adjustment and
 * every multi-season average computed for it.
 */

/** The 32 abbreviations currently in use, exactly as upstream spells them. */
export const CURRENT_TEAMS = [
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
  "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
  "LA", "LAC", "LV", "MIA", "MIN", "NE", "NO", "NYG",
  "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
] as const;

export type TeamAbbr = (typeof CURRENT_TEAMS)[number];

const CURRENT_SET: ReadonlySet<string> = new Set(CURRENT_TEAMS);

/**
 * Franchise relocations present in the upstream data.
 *
 * Upstream uses `LA` for the Rams, never `LAR`. Mapping `STL` to `LA` (rather than to a
 * `LAR` that does not exist upstream) is what keeps the join keys consistent.
 */
const RELOCATIONS: Readonly<Record<string, TeamAbbr>> = {
  OAK: "LV", // Oakland Raiders through 2019
  SD: "LAC", // San Diego Chargers through 2016
  STL: "LA", // St. Louis Rams through 2015
};

/**
 * Spellings that never appear upstream but are common in hand-made CSVs, other fantasy
 * platforms, and user input. Accepting them makes roster import forgiving without
 * loosening anything about how upstream data itself is interpreted.
 */
const INPUT_ALIASES: Readonly<Record<string, TeamAbbr>> = {
  LAR: "LA",
  RAM: "LA",
  WSH: "WAS",
  WFT: "WAS",
  JAC: "JAX",
  KAN: "KC",
  GNB: "GB",
  SFO: "SF",
  TAM: "TB",
  NWE: "NE",
  NOR: "NO",
  ARZ: "ARI",
  BLT: "BAL",
  CLV: "CLE",
  HST: "HOU",
  LVR: "LV",
};

/**
 * Normalizes any known spelling to a current abbreviation, or returns `null`.
 *
 * `null` rather than a thrown error or a passthrough: an unrecognized team is a data
 * quality signal the caller should surface or drop deliberately, and silently passing it
 * through would let a typo become a phantom 33rd team.
 */
export function normalizeTeam(raw: string | null | undefined): TeamAbbr | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase();
  if (key === "" || key === "NA") return null;
  if (CURRENT_SET.has(key)) return key as TeamAbbr;
  return RELOCATIONS[key] ?? INPUT_ALIASES[key] ?? null;
}

/**
 * True if the value is already a current team code.
 *
 * Deliberately not `normalizeTeam(raw) !== null`. That form returns true for `LAR`, `OAK`,
 * and `WSH`, which narrows them to `TeamAbbr` even though none is a member of
 * `CURRENT_TEAMS` — so a caller relying on the guard rather than on `normalizeTeam`'s
 * return value keeps an un-normalized key, which is the split-franchise bug this module
 * exists to prevent. Use `normalizeTeam` to accept aliases; use this only to test a value
 * that should already be canonical.
 */
export function isTeam(raw: string | null | undefined): raw is TeamAbbr {
  return raw !== null && raw !== undefined && (CURRENT_TEAMS as readonly string[]).includes(raw);
}

/**
 * Teams playing at home in a fixed-roof or retractable-roof stadium.
 *
 * Used only as a fallback when a game row carries no `roof` value. The game row is
 * always preferred, because a retractable roof's actual state on the day is a property
 * of the game, not of the venue.
 */
const INDOOR_HOME_TEAMS: ReadonlySet<TeamAbbr> = new Set<TeamAbbr>([
  "ARI", "ATL", "DAL", "DET", "HOU", "IND", "LA", "LAC", "LV", "MIN", "NO",
]);

export function hasIndoorHomeStadium(team: TeamAbbr): boolean {
  return INDOOR_HOME_TEAMS.has(team);
}
