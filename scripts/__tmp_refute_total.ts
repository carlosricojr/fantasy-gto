/** TEMPORARY. Measures per-ruleset row counts inside convex/ingest.ts projectWeek. */
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
import { SCORING_PRESETS } from "@/lib/nfl/scoring/presets";
import { NflverseProvider } from "@/lib/sources/nflverse";
import type { PlayerWeek } from "@/lib/nfl/stats/parse";

const CACHE_DIR = join(process.cwd(), ".cache", "nflverse");
const cachedFetch = async (url: string): Promise<string> =>
  readFileSync(join(CACHE_DIR, url.split("/").pop() ?? "x.csv"), "utf8");

const WRITE_BATCH = 100;
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function run(season: number, week: number) {
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
      const implied = impliedTeamTotal(line.total, line.spread, team, contest.homeTeam, contest.awayTeam);
      if (implied === null) continue;
      const bucket = teamTotals.get(team) ?? [];
      bucket.push({ week: contest.period.index, impliedTotal: implied });
      teamTotals.set(team, bucket);
    }
  }

  const history = new Map<string, PlayerWeek[]>();
  for (const playerWeek of [...priorWeeks, ...currentSeason.data]) {
    if (playerWeek.period.season === season && playerWeek.period.index >= week) continue;
    const bucket = history.get(playerWeek.competitor.id) ?? [];
    bucket.push(playerWeek);
    history.set(playerWeek.competitor.id, bucket);
  }
  for (const bucket of history.values()) {
    bucket.sort((a, b) => a.period.season - b.period.season || a.period.index - b.period.index);
  }

  const rulesets = SCORING_PRESETS;
  const counts: Array<{ id: string; rows: number }> = [];
  let written = 0;
  const totals: number[] = [];
  const trace: Array<{ processed: number; total: number }> = [];

  for (const scoring of rulesets) {
    const defenseFactors = buildDefenseFactors(priorWeeks, scoring, DVP_SHRINKAGE);
    const rows: unknown[] = [];
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
              ? impliedTeamTotal(line.total, line.spread, team, contest.homeTeam, contest.awayTeam)
              : null,
          teamMeanImpliedTotal: team ? meanImpliedTotalBefore(teamTotals.get(team) ?? [], week) : null,
        },
        scoring,
        defenseFactors,
      });
      if (projection.mean <= 0) continue;
      rows.push({ playerId });
    }
    counts.push({ id: scoring.id, rows: rows.length });
    totals.push(rows.length * rulesets.length);
    for (const batch of chunk(rows, WRITE_BATCH)) {
      written += batch.length;
      trace.push({ processed: written, total: rows.length * rulesets.length });
    }
  }

  console.log(`\n=== ${season} week ${week} (rulesets: ${rulesets.map((r) => r.id).join(", ")}) ===`);
  console.log("per-ruleset row counts:", counts);
  console.log("distinct reported totals:", [...new Set(totals)]);
  const last = trace[trace.length - 1];
  console.log("final progress row:", last, "processed>total?", last.processed > last.total);
}

async function main() {
  for (const week of [1, 5, 10, 17]) await run(2025, week);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
