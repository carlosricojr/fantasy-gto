/** Offline development/tuning benchmark. Never loads 2025 or changes production gates. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseCsv } from "../lib/nfl/csv";
import { PPR } from "../lib/nfl/scoring/presets";
import { scoreDefense, scoreKicker, scoreOffense } from "../lib/nfl/scoring/score";
import { toDefenseStatLine, toKickerStatLine, toRegularSeasonPlayerWeeks, toTeamWeek } from "../lib/nfl/stats/parse";
import { parseContests, parseMarketLines, schedulesUrl, teamWeeklyStatsUrl, weeklyStatsUrl } from "../lib/sources/nflverse";
import { priorSeasonCoverageBaseline, type ScoredHistoryWeek } from "../lib/nfl/model/coverage-baseline";
import { weeksBetween } from "../lib/nfl/season";
import { buildDefenseFactors, impliedTeamTotal, meanImpliedTotalBefore, projectPlayer } from "../lib/nfl/model/project";
import { DVP_SHRINKAGE } from "../lib/nfl/model/config";
import { pairedComparison, type PairedError } from "../lib/core/stats";
import type { PlayerWeek } from "../lib/nfl/stats/parse";
import { assertCoverageAuditRows, hasExplicitCounters } from "../lib/nfl/model/coverage-audit-data";

const cacheDir = join(process.cwd(), ".cache", "nflverse");
const sourceFiles: { url: string; sha256: string }[] = [];
async function cached(url: string): Promise<string> {
  const path = join(cacheDir, new URL(url).pathname.split("/").pop()!);
  let text: string;
  if (existsSync(path)) text = readFileSync(path, "utf8");
  else {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Source unavailable: ${response.status} ${url}`);
    text = await response.text();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, text);
  }
  sourceFiles.push({ url, sha256: createHash("sha256").update(text).digest("hex") });
  return text;
}
const mean = (values: readonly number[]) => values.reduce((sum, x) => sum + x, 0) / values.length;
const buckets = new Map<string, PairedError[]>();
function record(cohort: string, season: number, playerId: string, actual: number, predicted: number, baseline: number) {
  const key = `${season < 2022 ? "development" : "tuning"}/${cohort}`;
  const rows = buckets.get(key) ?? [];
  if (![actual, predicted, baseline].every(Number.isFinite)) throw new Error(`Non-finite audit observation in ${key}`);
  rows.push({ cluster: playerId, model: Math.abs(actual - predicted), baseline: Math.abs(actual - baseline) });
  buckets.set(key, rows);
}
async function main() {
  if (process.argv.length > 2) throw new Error("This audit accepts no flags and never evaluates the 2025 holdout.");
  const rawGames = parseCsv(await cached(schedulesUrl())).filter(row => Number(row.season) <= 2024);
  const contests = parseContests(rawGames);
  const lines = new Map(parseMarketLines(rawGames).map(row => [row.contestId, row]));
  const playerHistory = new Map<string, PlayerWeek[]>();
  const kickerHistory = new Map<string, ScoredHistoryWeek[]>();
  const defenseHistory = new Map<string, ScoredHistoryWeek[]>();
  const seasons = new Map<number, PlayerWeek[]>();
  const skipped = { kickerMissingStats: 0, defenseMissingStats: 0, missingGame: 0 };
  for (let season = 2011; season <= 2024; season++) {
    const raw = parseCsv(await cached(weeklyStatsUrl(season)));
    // Aggregate/non-fantasy rows have blank player identities upstream; they never
    // enter this audit. Fantasy-position identities must still resolve exactly.
    assertCoverageAuditRows(raw.filter(row => ["QB", "RB", "FB", "WR", "TE", "K"].includes(row.position)), season, "player_id");
    const weeks = toRegularSeasonPlayerWeeks(raw);
    seasons.set(season, weeks);
    const factors = buildDefenseFactors(seasons.get(season - 1) ?? [], PPR, DVP_SHRINKAGE);
    for (const row of weeks.sort((a, b) => a.period.index - b.period.index || a.competitor.id.localeCompare(b.competitor.id))) {
      const position = row.competitor.position;
      if (!["QB", "RB", "WR", "TE"].includes(position)) continue;
      const prior = (playerHistory.get(row.competitor.id) ?? []).filter(p => p.period.season >= season - 2);
      const latest = prior.at(-1);
      const cohort = prior.length > 0 && prior.length < 4 ? "skill-limited-1to3" : latest && prior.length >= 4 && weeksBetween(latest.period, row.period) > 4 ? "skill-returning-gap-over4" : null;
      if (season >= 2013 && cohort !== null) {
        const games = contests.filter(g => g.period.season === season && g.period.index === row.period.index && (g.homeTeam === row.competitor.team || g.awayTeam === row.competitor.team));
        const game = games.length === 1 ? games[0] : null;
        if (!game) skipped.missingGame++;
        else {
          const line = lines.get(game.id);
          const team = row.competitor.team!;
          const totals = contests.filter(g => g.period.season === season && g.period.index < row.period.index && (g.homeTeam === team || g.awayTeam === team)).flatMap(g => {
            const market = lines.get(g.id); const total = market ? impliedTeamTotal(market.total, market.spread, team, g.homeTeam, g.awayTeam) : null;
            return total === null ? [] : [{ week: g.period.index, impliedTotal: total }];
          });
          const prediction = projectPlayer({ competitorId: row.competitor.id, position, period: row.period, history: prior, scoring: PPR, defenseFactors: factors,
            game: { opponent: game.homeTeam === team ? game.awayTeam : game.homeTeam, impliedTeamTotal: line ? impliedTeamTotal(line.total, line.spread, team, game.homeTeam, game.awayTeam) : null,
              teamMeanImpliedTotal: meanImpliedTotalBefore(totals, row.period.index) } });
          record(cohort, season, row.competitor.id, scoreOffense(row.stats, PPR).total, prediction.mean, mean(prior.map(p => scoreOffense(p.stats, PPR).total)));
        }
      }
      prior.push(row); playerHistory.set(row.competitor.id, prior);
    }
    for (const row of raw.filter(r => r.season_type === "REG" && r.position === "K").sort((a, b) => Number(a.week) - Number(b.week))) {
      const required = ["fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59", "fg_made_60_", "fg_missed", "pat_made", "pat_missed"];
      if (!hasExplicitCounters(row, required)) { skipped.kickerMissingStats++; continue; }
      const observation = { period: { season, index: Number(row.week) }, points: scoreKicker(toKickerStatLine(row), PPR).total };
      const prior = kickerHistory.get(row.player_id) ?? [];
      const prediction = priorSeasonCoverageBaseline(prior, observation.period);
      if (season >= 2013 && prediction && prior.length >= 3) record("K-prior-season-mean-v-last3", season, row.player_id, observation.points, prediction.points, mean(prior.slice(-3).map(p => p.points)));
      prior.push(observation); kickerHistory.set(row.player_id, prior);
    }
    if (season < 2012) continue;
    const teamRows = parseCsv(await cached(teamWeeklyStatsUrl(season)));
    assertCoverageAuditRows(teamRows, season, "team");
    for (const row of teamRows.filter(r => r.season_type === "REG").sort((a, b) => Number(a.week) - Number(b.week))) {
      const identity = toTeamWeek(row);
      if (!identity) throw new Error("Unresolved team-week");
      const required = ["def_sacks", "def_interceptions", "fumble_recovery_opp", "def_tds", "special_teams_tds", "def_safeties"];
      if (!hasExplicitCounters(row, required)) { skipped.defenseMissingStats++; continue; }
      const game = contests.find(g => g.period.season === season && g.period.index === identity.period.index && (g.homeTeam === identity.team || g.awayTeam === identity.team));
      if (!game?.result) { skipped.missingGame++; continue; }
      const allowed = game.homeTeam === identity.team ? game.result.awayScore : game.result.homeScore;
      const observation = { period: identity.period, points: scoreDefense(toDefenseStatLine(row, allowed), PPR).total };
      const prior = defenseHistory.get(identity.team) ?? [];
      const prediction = priorSeasonCoverageBaseline(prior, observation.period);
      if (season >= 2013 && prediction && prior.length >= 3) record("DST-conventional-prior-season-mean-v-last3", season, identity.team, observation.points, prediction.points, mean(prior.slice(-3).map(p => p.points)));
      prior.push(observation); defenseHistory.set(identity.team, prior);
    }
  }
  console.log(JSON.stringify({ protocol: "Fixed methods; development/tuning only; appearances conditional on playing; no current injury/roster eligibility accuracy or custom DST scoring claim", skipped,
    results: Object.fromEntries([...buckets].map(([key, rows]) => [key, pairedComparison(rows)])), sourceFiles,
    holdout: "2025 PLAYER/TEAM STATS NOT LOADED; 2025 SCHEDULE ROWS EXCLUDED BEFORE PARSING; HOLDOUT NOT EVALUATED" }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
