import type { SleeperScoringProfile } from "./scoring/sleeper";
import type { Position } from "./scoring/types";

/** A source timestamp is distinct from the time we downloaded its response. */
export interface SleeperProjectionPlayer {
  playerId: string;
  position: Position;
  team: string | null;
  opponent: string | null;
  gameId: string | null;
  providerUpdatedAt: number | null;
  stats: Readonly<Record<string, unknown>>;
  /** Provider totals, not a claim that our custom rules were applied. */
  reportedPoints: { standard: number | null; half_ppr: number | null; ppr: number | null };
}

export interface SleeperProjectionSnapshot {
  season: number;
  week: number;
  source: "sleeper";
  company: "rotowire";
  sourceUrl: string;
  retrievedAt: number;
  /** Oldest row timestamp; null if any projected row has no source timestamp. */
  providerUpdatedAt: number | null;
  players: SleeperProjectionPlayer[];
  excludedRows: number;
}

export type SourceFreshness = "fresh" | "stale" | "unknown" | "future";

/** Consumers choose a freshness budget; a successful download cannot refresh old data. */
export function sleeperProjectionFreshness(
  providerUpdatedAt: number | null,
  now: number,
  maxAgeMs: number,
): SourceFreshness {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new Error("Freshness requires a finite clock and positive age budget.");
  }
  if (providerUpdatedAt === null || !Number.isFinite(providerUpdatedAt) || providerUpdatedAt <= 0) return "unknown";
  if (providerUpdatedAt > now) return "future";
  return now - providerUpdatedAt > maxAgeMs ? "stale" : "fresh";
}

const OFFENSE = new Set(["pass_yd", "pass_td", "pass_int", "pass_2pt", "rush_yd", "rush_td", "rush_2pt", "rec", "rec_yd", "rec_td", "rec_2pt", "fum_lost", "st_td", "st_ff", "st_fum_rec", "fum_rec_td"]);
const KICKING = new Set(["fgm_0_19", "fgm_20_29", "fgm_30_39", "fgm_40_49", "fgm_50_59", "fgm_60p", "fgmiss", "xpm", "xpmiss"]);
const DEFENSE = new Set(["sack", "int", "fum_rec", "ff", "safe", "blk_kick", "def_td", "def_st_td", "def_st_ff", "def_st_fum_rec"]);

export type SleeperProjectionScore =
  | { ok: true; points: number; components: { label: string; points: number }[] }
  | { ok: false; missingStats: string[]; unsupportedRules: string[] };

/**
 * Expected event counts score linearly. Missing projection counters are UNKNOWN, unlike
 * sparse completed-game events. Tiered defense scoring cannot use a bin of expected yards
 * or points: E[score(X)] is not score(E[X]). This deliberately fails those tiers closed.
 */
export function scoreSleeperProjection(
  player: Pick<SleeperProjectionPlayer, "position" | "stats">,
  profile: SleeperScoringProfile,
): SleeperProjectionScore {
  const missingStats: string[] = [];
  const unsupportedRules: string[] = [];
  const components: { label: string; points: number }[] = [];
  for (const [key, coefficient] of Object.entries(profile.coefficients).sort(([a], [b]) => a.localeCompare(b))) {
    if (coefficient === 0) continue;
    const tier = key.startsWith("pts_allow_") || key.startsWith("yds_allow_");
    const applicable = player.position === "DST" ? DEFENSE.has(key) || tier
      : OFFENSE.has(key) || (player.position === "K" && KICKING.has(key));
    if (!applicable) {
      if (!OFFENSE.has(key) && !KICKING.has(key) && !DEFENSE.has(key) && !tier) unsupportedRules.push(key);
      continue;
    }
    if (tier || !Number.isFinite(coefficient)) { unsupportedRules.push(key); continue; }
    const value = Object.hasOwn(player.stats, key) ? player.stats[key] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) { missingStats.push(key); continue; }
    const points = value * coefficient;
    if (!Number.isFinite(points)) { unsupportedRules.push(key); continue; }
    components.push({ label: key, points });
  }
  if (missingStats.length || unsupportedRules.length) return { ok: false, missingStats, unsupportedRules };
  const points = components.reduce((sum, component) => sum + component.points, 0);
  return Number.isFinite(points)
    ? { ok: true, points, components }
    : { ok: false, missingStats: [], unsupportedRules: ["score overflow"] };
}
