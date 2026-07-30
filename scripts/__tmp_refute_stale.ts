/**
 * TEMPORARY verification harness. Faithful offline replica of convex/ingest.ts projectWeek.
 * Delete after use.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DVP_SHRINKAGE } from "@/lib/nfl/model/config";
import {
  type ImpliedTotalEntry,
  buildDefenseFactors,
  impliedTeamTotal,
  meanImpliedTotalBefore,
  projectPlayer,
} from "@/lib/nfl/model/project";
import { DEFAULT_SCORING, SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { NflverseProvider } from "@/lib/sources/nflverse";
import type { PlayerWeek } from "@/lib/nfl/stats/parse";

const CACHE_DIR = join(process.cwd(), ".cache", "nflverse");
const cachedFetch = async (url: string): Promise<string> =>
  readFileSync(join(CACHE_DIR, url.split("/").pop() ?? "x.csv"), "utf8");

async function projectWeek(season: number, week: number) {
  const provider = new NflverseProvider(cachedFetch);

  const currentSeason = await provider.playerWeeks(season);
  if (!currentSeason.ok) throw new Error(currentSeason.reason);
  const priorSeason = await provider.playerWeeks(season - 1);
  const priorWeeks: PlayerWeek[] = priorSeason.ok ? priorSeason.data : [];

  const contestsResult = await provider.allContests();
  const linesResult = await provider.allMarketLines();
  if (!contestsResult.ok) throw new Error(contestsResult.reason);
  if (!linesResult.ok) throw new Error(linesResult.reason);

  const lineByContest = new Map(linesResult.data.map((l) => [l.contestId, l]));

  const teamTotals = new Map<string, ImpliedTotalEntry[]>();
  const weekContestByTeam = new Map<string, (typeof contestsResult.data)[number]>();
  for (const contest of contestsResult.data) {
    if (contest.period.season !== season) continue;
    const line = lineByContest.get(contest.id);
    if (contest.period.index === week) {
      weekContestByTeam.set(contest.homeTeam, contest);
      weekContestByTeam.set(contest.awayTeam, contest);
    }
    if (!line) continue;
    for (const team of [contest.homeTeam, contest.awayTeam]) {
      const implied = impliedTeamTotal(
        line.total,
        line.spread,
        team,
        contest.homeTeam,
        contest.awayTeam,
      );
      if (implied === null) continue;
      const bucket = teamTotals.get(team) ?? [];
      bucket.push({ week: contest.period.index, impliedTotal: implied });
      teamTotals.set(team, bucket);
    }
  }

  const history = new Map<string, PlayerWeek[]>();
  for (const playerWeek of [...priorWeeks, ...currentSeason.data]) {
    const isFuture =
      playerWeek.period.season === season && playerWeek.period.index >= week;
    if (isFuture) continue;
    const bucket = history.get(playerWeek.competitor.id) ?? [];
    bucket.push(playerWeek);
    history.set(playerWeek.competitor.id, bucket);
  }
  for (const bucket of history.values()) {
    bucket.sort(
      (a, b) => a.period.season - b.period.season || a.period.index - b.period.index,
    );
  }

  const rulesets = [DEFAULT_SCORING.id]
    .map((id) => SCORING_PRESETS.find((p) => p.id === id))
    .filter((p): p is (typeof SCORING_PRESETS)[number] => p !== undefined);

  const anyCurrentSeason = new Set(currentSeason.data.map((p) => p.competitor.id));

  const out: Array<{
    playerId: string;
    name: string;
    position: string;
    team: string | null;
    mean: number;
    lastSeason: number;
    lastWeek: number;
    anyCurrent: boolean;
    hasContest: boolean;
    games: number;
  }> = [];

  for (const scoring of rulesets) {
    const defenseFactors = buildDefenseFactors(priorWeeks, scoring, DVP_SHRINKAGE);
    for (const [playerId, bucket] of history) {
      const latest = bucket[bucket.length - 1];
      const position = latest.competitor.position;
      if ((position as string) === "DST") continue;

      const team = latest.competitor.team;
      const contest = team ? weekContestByTeam.get(team) : undefined;
      const line = contest ? lineByContest.get(contest.id) : undefined;
      const opponent = contest
        ? contest.homeTeam === team
          ? contest.awayTeam
          : contest.homeTeam
        : null;

      const projection = projectPlayer({
        competitorId: playerId,
        position,
        period: { season, index: week },
        history: bucket,
        game: {
          opponent,
          impliedTeamTotal:
            contest && line && team
              ? impliedTeamTotal(
                  line.total,
                  line.spread,
                  team,
                  contest.homeTeam,
                  contest.awayTeam,
                )
              : null,
          teamMeanImpliedTotal: team
            ? meanImpliedTotalBefore(teamTotals.get(team) ?? [], week)
            : null,
        },
        scoring,
        defenseFactors,
      });

      if (projection.mean <= 0) continue;

      out.push({
        playerId,
        name: latest.competitor.name,
        position,
        team,
        mean: projection.mean,
        lastSeason: latest.period.season,
        lastWeek: latest.period.index,
        anyCurrent: anyCurrentSeason.has(playerId),
        hasContest: contest !== undefined,
        games: bucket.length,
      });
    }
  }

  out.sort((a, b) => b.mean - a.mean || (a.playerId < b.playerId ? -1 : 1));
  return out;
}

async function main() {
  for (const week of [1, 6, 10, 14]) {
    const rows = await projectWeek(2025, week);
    const stale = rows.filter((r) => !r.anyCurrent);
    // QB board (what the position filter shows)
    const qbs = rows.filter((r) => r.position === "QB");
    const staleQb = qbs.filter((r) => !r.anyCurrent);
    console.log(
      `\n[QB board wk${week}] ${qbs.length} QBs, ${staleQb.length} never played in 2025.`,
    );
    for (const q of staleQb.slice(0, 8)) {
      console.log(
        `    QB rank ${qbs.indexOf(q) + 1}: ${q.name} mean=${q.mean} team=${q.team} lastPlayed=${q.lastSeason}wk${q.lastWeek}`,
      );
    }
    // top-300 pool = the lineup optimiser's selectable pool
    const pool300 = rows.slice(0, 300);
    console.log(
      `[lineup pool wk${week}] ${pool300.filter((r) => !r.anyCurrent).length} of top 300 never played in 2025`,
    );
    const staleWithContest = stale.filter((r) => r.hasContest);
    console.log(`\n=== 2025 week ${week} ===`);
    console.log(`stored projection rows: ${rows.length}`);
    console.log(
      `rows for players with ZERO 2025 games anywhere: ${stale.length} (${(
        (stale.length / rows.length) *
        100
      ).toFixed(1)}%)`,
    );
    console.log(`  of those, listed team HAS a week-${week} game: ${staleWithContest.length}`);
    const top100 = rows.slice(0, 100);
    const staleTop = top100.filter((r) => !r.anyCurrent);
    console.log(`stale players inside top 100: ${staleTop.length}`);
    for (const s of staleTop) {
      console.log(
        `   rank ${rows.indexOf(s) + 1}: ${s.name} (${s.position}, team ${s.team}) mean=${s.mean} lastPlayed=${s.lastSeason}wk${s.lastWeek} contest=${s.hasContest}`,
      );
    }
    for (const name of ["Jimmy Garoppolo", "Derek Carr"]) {
      const idx = rows.findIndex((r) => r.name === name);
      if (idx >= 0) {
        const r = rows[idx];
        console.log(
          `   [lookup] ${name}: rank ${idx + 1}/${rows.length} mean=${r.mean} team=${r.team} lastPlayed=${r.lastSeason}wk${r.lastWeek} anyCurrent=${r.anyCurrent} contest=${r.hasContest} games=${r.games}`,
        );
      } else {
        console.log(`   [lookup] ${name}: NOT stored`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
