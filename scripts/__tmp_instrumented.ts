/**
 * Model backtest.
 *
 * This script is the sole authority for any accuracy claim the product makes. It
 * downloads real nflverse data, replays historical weeks using only information that was
 * available before kickoff, and reports MAE against baselines.
 *
 * Run with `pnpm backtest`. Downloads are cached under `.cache/nflverse`.
 *
 * Method, and why each choice matters:
 *
 * - Hyperparameters were chosen on the tuning season and are frozen in `config.ts`. The
 *   evaluation season is therefore genuinely out-of-sample.
 * - Defense-vs-position factors always come from the *prior* season. Building them from
 *   the evaluation season would leak the outcome into the prediction.
 * - Only rosterable players are scored: at least `MIN_PRIOR_GAMES` of history and a
 *   recent average of at least `MIN_RECENT_AVERAGE`. Including deep-bench players with no
 *   usage would flatter every model equally and measure nothing.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  type ImpliedTotalEntry,
  buildDefenseFactors,
  impliedTeamTotal,
  meanImpliedTotalBefore,
  projectPlayer,
} from "@/lib/nfl/model/project";
import { DVP_SHRINKAGE, CALIBRATION } from "@/lib/nfl/model/config";
import { PPR } from "@/lib/nfl/scoring/presets";
import { scoreOffense } from "@/lib/nfl/scoring/score";
import type { Position } from "@/lib/nfl/scoring/types";
import {
  NflverseProvider,
  schedulesUrl,
  weeklyStatsUrl,
} from "@/lib/sources/nflverse";
import type { PlayerWeek } from "@/lib/nfl/stats/parse";

const TUNING_SEASON = 2024;
const EVALUATION_SEASON = 2025;
const PRIOR_SEASON = 2023;

const MIN_PRIOR_GAMES = 4;
const MIN_RECENT_AVERAGE = 6;
const RECENT_WINDOW = 8;

const CACHE_DIR = join(process.cwd(), ".cache", "nflverse");

/** Caches downloads on disk so repeated runs are fast and reproducible. */
async function cachedFetch(url: string): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, url.split("/").pop() ?? "download.csv");
  if (existsSync(file)) return readFileSync(file, "utf8");
  process.stdout.write(`  downloading ${url.split("/").pop()}...\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const text = await response.text();
  writeFileSync(file, text);
  return text;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

interface Evaluation {
  position: Position;
  predicted: number;
  actual: number;
}

async function main(): Promise<void> {
  process.stdout.write("Fantasy GTO model backtest\n\n");

  const provider = new NflverseProvider(cachedFetch);

  // Warm the cache explicitly so the download messages appear before the work.
  await cachedFetch(schedulesUrl());
  for (const season of [PRIOR_SEASON, TUNING_SEASON, EVALUATION_SEASON]) {
    await cachedFetch(weeklyStatsUrl(season));
  }

  const contestsResult = await provider.allContests();
  const linesResult = await provider.allMarketLines();
  if (!contestsResult.ok || !linesResult.ok) {
    throw new Error("Could not load schedule or market data");
  }
  const contestById = new Map(contestsResult.data.map((c) => [c.id, c]));
  const lineById = new Map(linesResult.data.map((l) => [l.contestId, l]));

  // Each team's implied total per week, kept as a series rather than collapsed to a
  // season average. The Vegas adjustment compares this week against the team's own norm,
  // and that norm must be computed only from weeks already played — averaging the full
  // season would leak later form into an earlier projection and inflate the result.
  const teamTotals = new Map<string, ImpliedTotalEntry[]>();
  for (const contest of contestsResult.data) {
    const line = lineById.get(contest.id);
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
      const key = `${contest.period.season}:${team}`;
      const bucket = teamTotals.get(key) ?? [];
      bucket.push({ week: contest.period.index, impliedTotal: implied });
      teamTotals.set(key, bucket);
    }
  }

  const seasons = new Map<number, PlayerWeek[]>();
  for (const season of [PRIOR_SEASON, TUNING_SEASON, EVALUATION_SEASON]) {
    const result = await provider.playerWeeks(season);
    if (!result.ok) throw new Error(`${season}: ${result.reason}`);
    seasons.set(season, result.data);
  }

  const defenseFactors = new Map<number, Map<string, number>>([
    [
      TUNING_SEASON,
      buildDefenseFactors(seasons.get(PRIOR_SEASON)!, PPR, DVP_SHRINKAGE),
    ],
    [
      EVALUATION_SEASON,
      buildDefenseFactors(seasons.get(TUNING_SEASON)!, PPR, DVP_SHRINKAGE),
    ],
  ]);

  // Chronological history per player across all loaded seasons.
  const history = new Map<string, PlayerWeek[]>();
  for (const season of [PRIOR_SEASON, TUNING_SEASON, EVALUATION_SEASON]) {
    for (const week of seasons.get(season)!) {
      const bucket = history.get(week.competitor.id) ?? [];
      bucket.push(week);
      history.set(week.competitor.id, bucket);
    }
  }
  for (const bucket of history.values()) {
    bucket.sort(
      (a, b) => a.period.season - b.period.season || a.period.index - b.period.index,
    );
  }

  function evaluate(season: number): {
    model: Evaluation[];
    seasonMean: Evaluation[];
    lastThree: Evaluation[];
    uncal: Evaluation[];
  } {
    const model: Evaluation[] = [];
    const uncal: Evaluation[] = [];
    const seasonMean: Evaluation[] = [];
    const lastThree: Evaluation[] = [];
    const factors = defenseFactors.get(season);

    for (const bucket of history.values()) {
      for (let i = 0; i < bucket.length; i += 1) {
        const week = bucket[i];
        if (week.period.season !== season) continue;
        const position = week.competitor.position;
        if (position === "K") continue;

        const prior = bucket.slice(0, i);
        if (prior.length < MIN_PRIOR_GAMES) continue;

        const priorPoints = prior.map((w) => scoreOffense(w.stats, PPR).total);
        const recent = priorPoints.slice(-RECENT_WINDOW);
        if (mean(recent) < MIN_RECENT_AVERAGE) continue;

        const actual = scoreOffense(week.stats, PPR).total;
        const contest = contestById.get(week.contestId);
        const line = contest ? lineById.get(contest.id) : undefined;
        const team = week.competitor.team;

        const implied =
          contest && line && team
            ? impliedTeamTotal(line.total, line.spread, team, contest.homeTeam, contest.awayTeam)
            : null;

        const projection = projectPlayer({
          competitorId: week.competitor.id,
          position,
          period: week.period,
          history: prior,
          game: {
            opponent: week.opponent,
            impliedTeamTotal: implied,
            // Only weeks already played, so nothing after kickoff informs the baseline.
            teamMeanImpliedTotal: team
              ? meanImpliedTotalBefore(
                  teamTotals.get(`${week.period.season}:${team}`) ?? [],
                  week.period.index,
                )
              : null,
          },
          scoring: PPR,
          defenseFactors: factors,
        });

        model.push({ position, predicted: projection.mean, actual });
        uncal.push({ position, predicted: projection.mean / CALIBRATION[position], actual });
        seasonMean.push({ position, predicted: mean(priorPoints), actual });
        lastThree.push({ position, predicted: mean(priorPoints.slice(-3)), actual });
      }
    }
    return { model, seasonMean, lastThree, uncal };
  }

  function mae(rows: readonly Evaluation[], position?: Position): number {
    const subset = position ? rows.filter((r) => r.position === position) : rows;
    return mean(subset.map((r) => Math.abs(r.predicted - r.actual)));
  }

  function bias(rows: readonly Evaluation[]): number {
    return mean(rows.map((r) => r.actual - r.predicted));
  }

  const positions: Position[] = ["QB", "RB", "WR", "TE"];

  for (const season of [TUNING_SEASON, EVALUATION_SEASON]) {
    const label =
      season === TUNING_SEASON ? "TUNING (in-sample)" : "EVALUATION (out-of-sample)";
    const { model, seasonMean, lastThree, uncal } = evaluate(season);

    process.stdout.write(`\n${season} — ${label}    n = ${model.length}\n`);
    process.stdout.write(
      `${"model".padEnd(28)}${"ALL".padStart(9)}${positions
        .map((p) => p.padStart(8))
        .join("")}\n`,
    );
    process.stdout.write(`${"-".repeat(69)}\n`);

    const rows: Array<[string, Evaluation[]]> = [
      ["FGTO model", model],
      ["baseline: season mean", seasonMean],
      ["baseline: last 3 games", lastThree],
    ];
    for (const [name, data] of rows) {
      process.stdout.write(
        `${name.padEnd(28)}${mae(data).toFixed(4).padStart(9)}${positions
          .map((p) => mae(data, p).toFixed(3).padStart(8))
          .join("")}\n`,
      );
    }

    // INSTRUMENTATION
    {
      const actuals = model.map((r) => r.actual).sort((a, b) => a - b);
      const meanActual = mean(actuals);
      const median = actuals[Math.floor(actuals.length / 2)];
      const p25 = actuals[Math.floor(actuals.length * 0.25)];
      const p75 = actuals[Math.floor(actuals.length * 0.75)];
      const meanPred = mean(model.map((r) => r.predicted));
      process.stdout.write(`  INSTR UNCALIBRATED mae=${mae(uncal).toFixed(4)} bias=${bias(uncal).toFixed(4)}\n`);
      process.stdout.write(
        `  INSTR season=${season} n=${actuals.length} meanActual=${meanActual.toFixed(4)} medianActual=${median.toFixed(4)} p25=${p25.toFixed(2)} p75=${p75.toFixed(2)} meanPredicted=${meanPred.toFixed(4)}\n`,
      );
      for (const p of positions) {
        const sub = model.filter((r) => r.position === p).map((r) => r.actual);
        process.stdout.write(
          `  INSTR ${p}: n=${sub.length} meanActual=${mean(sub).toFixed(3)}\n`,
        );
      }
    }

    const modelMae = mae(model);
    const baseMae = mae(seasonMean);
    const lastMae = mae(lastThree);
    process.stdout.write(
      `\n  bias (actual - predicted): ${bias(model) >= 0 ? "+" : ""}${bias(model).toFixed(3)}\n`,
    );
    process.stdout.write(
      `  vs season mean:  ${(((baseMae - modelMae) / baseMae) * 100).toFixed(2)}%\n`,
    );
    process.stdout.write(
      `  vs last 3 games: ${(((lastMae - modelMae) / lastMae) * 100).toFixed(2)}%\n`,
    );
  }

  process.stdout.write(
    "\nThe out-of-sample figure is the only one the product may quote.\n" +
      "Update docs/model-validation.md in the same commit as any model change.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`backtest failed: ${String(error)}\n`);
  process.exitCode = 1;
});
