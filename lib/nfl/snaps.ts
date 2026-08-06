import { type CsvRow, num, str } from "./csv";
import type { PlayerProfile } from "./players";
import { normalizeTeam } from "./teams";

/**
 * Weekly snap counts — the role signal the box score cannot express.
 *
 * Two targets on 45 snaps and two targets on 12 snaps are the same row in `stats_player_week`
 * and completely different facts about a player's role. Role is also the half of the
 * trajectory decomposition that measurement showed is actually predictable: opportunity
 * carries r² 0.678 against 0.175 for points.
 *
 * **Keyed by `pfr_player_id`, not `gsis_id`.** It cannot join to weekly statistics directly.
 * The bridge is the player directory in `players.ts`, and rows that fail to bridge are
 * *counted* rather than dropped — an unjoinable snap row must be visible as a gap, never as
 * a zero, because zero snaps and unknown snaps are opposite facts about a player.
 *
 * Parsing is pure; fetching is `lib/sources/nflverse.ts`.
 */

export interface SnapCount {
  season: number;
  week: number;
  /** Pro Football Reference's identifier. Needs the bridge before it can meet a projection. */
  pfrPlayerId: string;
  name: string;
  position: string;
  team: string | null;
  opponent: string | null;
  offenseSnaps: number;
  /** Share of the team's offensive snaps, 0–1. */
  offenseShare: number;
  specialTeamsShare: number;
}

/** A snap count that has been matched to a player the rest of the system knows. */
export interface BridgedSnapCount extends SnapCount {
  /** `gsis_id`, so this can now meet a projection. */
  playerId: string;
}

export interface SnapBridgeReport {
  matched: BridgedSnapCount[];
  /** Rows whose `pfr_player_id` is absent from the directory, kept rather than discarded. */
  unmatched: SnapCount[];
  /** Distinct identifiers that failed to bridge. */
  unmatchedPlayers: Set<string>;
}

/**
 * Parses the regular-season rows of one season's snap counts.
 *
 * Filtered on `game_type`, matching every other nflverse parse here. A row with no
 * `pfr_player_id` is dropped: it cannot be bridged even in principle, so keeping it would
 * inflate the unmatched count with rows that were never candidates.
 */
export function toRegularSeasonSnaps(rows: readonly CsvRow[]): SnapCount[] {
  const out: SnapCount[] = [];
  for (const row of rows) {
    if (str(row, "game_type") !== "REG") continue;
    const pfrPlayerId = str(row, "pfr_player_id");
    if (pfrPlayerId === "") continue;

    out.push({
      season: num(row, "season"),
      week: num(row, "week"),
      pfrPlayerId,
      name: str(row, "player"),
      position: str(row, "position").toUpperCase(),
      team: normalizeTeam(str(row, "team")),
      opponent: normalizeTeam(str(row, "opponent")),
      offenseSnaps: num(row, "offense_snaps"),
      // Upstream ships this as a fraction, not a percentage: 0.9 means 90%.
      offenseShare: num(row, "offense_pct"),
      specialTeamsShare: num(row, "st_pct"),
    });
  }
  return out;
}

/**
 * Joins snap counts to the player directory, counting what does not match.
 *
 * The unmatched rows are returned rather than dropped, and that is the whole point of the
 * shape. A caller that silently discarded them would report snap share for the players it
 * could resolve and say nothing about the rest, which reads as complete coverage. A caller
 * that defaulted them to zero would be worse still: zero snaps means benched, and unknown
 * snaps means unknown, and no model should be unable to tell those apart.
 */
export function bridgeSnaps(
  snaps: readonly SnapCount[],
  directory: ReadonlyMap<string, PlayerProfile>,
): SnapBridgeReport {
  const matched: BridgedSnapCount[] = [];
  const unmatched: SnapCount[] = [];
  const unmatchedPlayers = new Set<string>();

  for (const snap of snaps) {
    const profile = directory.get(snap.pfrPlayerId);
    if (profile === undefined) {
      unmatched.push(snap);
      unmatchedPlayers.add(snap.pfrPlayerId);
      continue;
    }
    matched.push({ ...snap, playerId: profile.playerId });
  }

  return { matched, unmatched, unmatchedPlayers };
}

/** Key for meeting a projection: the same shape the injury index uses. */
export function snapKey(playerId: string, season: number, week: number): string {
  return `${season}:${week}:${playerId}`;
}

export function indexSnaps(
  snaps: readonly BridgedSnapCount[],
): Map<string, BridgedSnapCount> {
  const index = new Map<string, BridgedSnapCount>();
  for (const snap of snaps) {
    index.set(snapKey(snap.playerId, snap.season, snap.week), snap);
  }
  return index;
}
