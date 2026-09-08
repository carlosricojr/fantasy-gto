import { normalizeName } from "./match";
import {
  type AdpCurve,
  type AdpCurveSample,
  fitAdpCurves,
} from "./value";
import {
  type Position,
} from "../scoring/types";
import {
  type SleeperScoringProfile,
  scoreSleeperWeek,
} from "../scoring/sleeper";

/** Raw, regular-season row from the verified Sleeper historical-stat endpoint. */
export interface SleeperHistoryWeek {
  playerId: string;
  position: string;
  team: string | null;
  season: number;
  week: number;
  stats: Readonly<Record<string, unknown>>;
}

export interface CustomBoardIdentity {
  playerId: string;
  sleeperId: string | null;
  name: string;
  position: string;
  team: string | null;
}

export interface CustomMarketEntry {
  name: string;
  position: string;
  team: string | null;
  adp: number;
  stdev: number | null;
  bye: number | null;
}

export interface CustomQuantileBand {
  p10: number;
  p90: number;
}

export interface SleeperCustomHistory {
  /** Scored totals by completed historical season, keyed by stable entity id. */
  seasonTotals: ReadonlyMap<number, ReadonlyMap<string, number>>;
  /** Scored total in the latest supplied historical season, keyed by stable entity id. */
  latestSeasonTotals: ReadonlyMap<string, number>;
  /** Games played in that same season, keyed by stable entity id. */
  latestSeasonGames: ReadonlyMap<string, number>;
  /** Empirical weekly-score / own-season-mean ratios, by position. */
  bands: ReadonlyMap<Position, CustomQuantileBand>;
  /**
   * Additive, pooled weekly residual spread for positions whose score can be zero or
   * negative. This is intentionally not a lognormal/rate band: `score - own-season mean`
   * remains defined for every historical K/DST entity-week, including a bad defense whose
   * season total was zero or below.
   */
  weeklyStdDev: ReadonlyMap<"K" | "DST", number>;
}

/** Custom-board D/ST IDs never depend on a market provider's display name. */
export function customDstId(team: string): string {
  return `dst-${team.trim().toUpperCase()}`;
}

/** Sleeper calls team defenses DEF; the product's canonical position is DST. */
export function sleeperPosition(position: string): Position | null {
  const normalized = position.trim().toUpperCase();
  if (normalized === "DEF" || normalized === "D/ST") return "DST";
  if (normalized === "PK") return "K";
  return (["QB", "RB", "WR", "TE", "K", "DST"] as const).includes(
    normalized as Position,
  )
    ? (normalized as Position)
    : null;
}

/**
 * Scores only verified historical weekly rows under the exact imported Sleeper rules.
 *
 * No source-score column or forecast endpoint is trusted here: the scorer receives the
 * raw category counters and rejects incomplete K/DST inputs. Values therefore describe
 * historical custom scoring, not a calibrated forecast or title probability.
 */
export function buildSleeperCustomHistory(
  weeks: readonly SleeperHistoryWeek[],
  profile: SleeperScoringProfile,
): SleeperCustomHistory {
  const bySeasonEntity = new Map<string, { position: Position; points: number[] }>();
  for (const week of weeks) {
    const position = sleeperPosition(week.position);
    if (position === null) continue;
    const entity = position === "DST"
      ? week.team === null ? null : customDstId(week.team)
      : week.playerId;
    if (entity === null) {
      throw new Error(`Sleeper historical DST row for ${week.season} week ${week.week} has no team.`);
    }
    let score: number;
    try {
      score = scoreSleeperWeek(week.stats, position, profile).total;
    } catch (error) {
      throw new Error(
        `Sleeper historical ${position} ${entity} in ${week.season} week ${week.week} cannot be custom-scored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const key = `${week.season}|${entity}`;
    const existing = bySeasonEntity.get(key);
    if (existing) {
      if (existing.position !== position) {
        throw new Error(`Sleeper historical entity ${entity} has conflicting positions in ${week.season}.`);
      }
      existing.points.push(score);
    } else {
      bySeasonEntity.set(key, { position, points: [score] });
    }
  }
  if (bySeasonEntity.size === 0) throw new Error("Sleeper historical statistics had no scoreable draft positions.");

  const latestSeason = Math.max(...weeks.map((week) => week.season));
  const latestSeasonTotals = new Map<string, number>();
  const latestSeasonGames = new Map<string, number>();
  const seasonTotals = new Map<number, Map<string, number>>();
  const ratios = new Map<Position, number[]>();
  const residuals = new Map<"K" | "DST", number[]>();
  for (const [key, entry] of bySeasonEntity) {
    const [seasonText, entity] = key.split("|", 2);
    const season = Number(seasonText);
    const total = entry.points.reduce((sum, points) => sum + points, 0);
    const mean = total / entry.points.length;
    const totals = seasonTotals.get(season) ?? new Map<string, number>();
    totals.set(entity, total);
    seasonTotals.set(season, totals);
    if (season === latestSeason) {
      latestSeasonTotals.set(entity, total);
      latestSeasonGames.set(entity, entry.points.length);
    }
    if (entry.position === "K" || entry.position === "DST") {
      const bucket = residuals.get(entry.position) ?? [];
      for (const points of entry.points) bucket.push(points - mean);
      residuals.set(entry.position, bucket);
    }
    // A zero own-season mean has no multiplicative spread. Dropping it is deliberate:
    // dividing a zero-score K/DST season by zero would manufacture an infinite band.
    if (mean <= 0) continue;
    const bucket = ratios.get(entry.position) ?? [];
    for (const points of entry.points) bucket.push(points / mean);
    ratios.set(entry.position, bucket);
  }

  const bands = new Map<Position, CustomQuantileBand>();
  for (const position of ["QB", "RB", "WR", "TE", "K", "DST"] as const) {
    const values = ratios.get(position) ?? [];
    if (values.length < 2) {
      throw new Error(`Sleeper custom history has insufficient ${position} weekly scores to measure an outcome band.`);
    }
    bands.set(position, { p10: quantile(values, 0.1), p90: quantile(values, 0.9) });
  }
  const weeklyStdDev = new Map<"K" | "DST", number>();
  for (const position of ["K", "DST"] as const) {
    const values = residuals.get(position) ?? [];
    if (values.length < 2) {
      throw new Error(`Sleeper custom history has insufficient ${position} residuals for additive weekly spread.`);
    }
    const spread = (quantile(values, 0.9) - quantile(values, 0.1)) / (2 * 1.2815515655446004);
    if (!(spread > 0) || !Number.isFinite(spread)) {
      throw new Error(`Sleeper custom history has no usable ${position} additive weekly spread.`);
    }
    weeklyStdDev.set(position, spread);
  }
  return { seasonTotals, latestSeasonTotals, latestSeasonGames, bands, weeklyStdDev };
}

/**
 * Fits one ADP-to-historical-points curve per draftable position.
 *
 * There is intentionally no pooled fallback: a custom K/DST rule can change those
 * positions independently, and borrowing a skill-player or PPR curve would be invented
 * pricing. Missing current identities among retired historical players are simply absent
 * from `current`; ambiguity in a current market join fails before a curve is written.
 */
export function fitRequiredCustomCurves(input: {
  season: number;
  current: readonly CustomBoardIdentity[];
  market: readonly CustomMarketEntry[];
  latestSeasonTotals: ReadonlyMap<string, number>;
  /**
   * Older completed ADP/score pairs, retained for sparse K/DST markets. Each source is
   * matched independently so no season's ADP is paired with another season's outcome.
   */
  additionalSources?: readonly {
    market: readonly CustomMarketEntry[];
    seasonTotals: ReadonlyMap<string, number>;
  }[];
}): Readonly<Record<Position, AdpCurve>> {
  const byNamePosition = new Map<string, CustomBoardIdentity[]>();
  const defensesByTeam = new Map<string, CustomBoardIdentity[]>();
  for (const identity of input.current) {
    const position = sleeperPosition(identity.position);
    if (position === null) continue;
    if (position === "DST") {
      if (identity.team === null) continue;
      const team = identity.team.trim().toUpperCase();
      defensesByTeam.set(team, [...(defensesByTeam.get(team) ?? []), identity]);
      continue;
    }
    const key = `${normalizeName(identity.name)}|${position}`;
    byNamePosition.set(key, [...(byNamePosition.get(key) ?? []), identity]);
  }
  const samples: AdpCurveSample[] = [];
  const sampled = new Set<string>();
  const sources = [
    { market: input.market, seasonTotals: input.latestSeasonTotals },
    ...(input.additionalSources ?? []),
  ];
  for (const [sourceIndex, source] of sources.entries()) {
    for (const entry of source.market) {
      const position = sleeperPosition(entry.position);
      if (position === null) continue;
      // A defense's stable identity is its NFL team, not its provider display name. Market
      // labels change across seasons (and sometimes within one), while the canonical custom
      // board ID remains `dst-${team}`. Skill positions retain the stricter name join.
      const candidates = position === "DST"
        ? entry.team === null ? [] : defensesByTeam.get(entry.team.trim().toUpperCase()) ?? []
        : byNamePosition.get(`${normalizeName(entry.name)}|${position}`) ?? [];
      if (candidates.length > 1) {
        throw new Error(`Custom market identity ${entry.name} (${position}) matches multiple current roster identities.`);
      }
      const current = candidates[0];
      if (!current) continue;
      const entity = position === "DST"
        ? current.team === null ? null : customDstId(current.team)
        : current.sleeperId;
      const total = entity === null ? undefined : source.seasonTotals.get(entity);
      const sampleKey = `${sourceIndex}|${current.playerId}`;
      if (total === undefined || sampled.has(sampleKey)) continue;
      sampled.add(sampleKey);
      samples.push({ adp: entry.adp, actualSeasonPoints: total, position });
    }
  }
  const fitted = fitAdpCurves(samples, input.season);
  if (fitted.pooled === null) {
    throw new Error("Sleeper custom history did not yield a usable ADP curve.");
  }
  const required = ["QB", "RB", "WR", "TE", "K", "DST"] as const;
  const missing = required.filter((position) => fitted.byPosition[position] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Sleeper custom history lacks a position-specific ADP curve for ${missing.join(", ")}; no pooled or preset curve was substituted.`,
    );
  }
  return Object.fromEntries(required.map((position) => [position, fitted.byPosition[position]!])) as Record<Position, AdpCurve>;
}

/**
 * Custom scoring can assign a negative season value to a defense. The preset-board
 * helper intentionally clips to zero because its historical scoring cannot represent
 * those outcomes; applying that policy here would invent a more favorable custom price.
 */
export function customAdpImpliedPoints(
  adp: number,
  position: Position,
  curves: Readonly<Record<Position, AdpCurve>>,
): number | null {
  if (!Number.isFinite(adp)) return null;
  if (adp <= 0) return 0;
  const curve = curves[position];
  if (curve === undefined) return null;
  const value = curve.intercept + curve.slope * Math.log(adp);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function quantile(values: readonly number[], probability: number): number {
  const ordered = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (ordered.length === 0) throw new Error("Cannot measure a quantile from no finite values.");
  const index = (ordered.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower);
}
