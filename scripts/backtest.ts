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
import {
  DEFAULT_MODEL_CONFIG,
  DVP_SHRINKAGE,
  type ModelConfig,
} from "@/lib/nfl/model/config";
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

  function evaluate(
    season: number,
    config: ModelConfig = DEFAULT_MODEL_CONFIG,
  ): {
    model: Evaluation[];
    allPriorMean: Evaluation[];
    lastThree: Evaluation[];
  } {
    const model: Evaluation[] = [];
    // Named for what it is: the mean of every prior game in the loaded history, which
    // spans up to three seasons. Calling it a "season-to-date mean" would be wrong, and
    // restricting it to the current season would hand the model an unfair advantage early
    // in the year — the baseline should see exactly the history the model sees.
    const allPriorMean: Evaluation[] = [];
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
          config,
        });

        model.push({ position, predicted: projection.mean, actual });
        allPriorMean.push({ position, predicted: mean(priorPoints), actual });
        lastThree.push({ position, predicted: mean(priorPoints.slice(-3)), actual });
      }
    }
    return { model, allPriorMean, lastThree };
  }

  function mae(rows: readonly Evaluation[], position?: Position): number {
    const subset = position ? rows.filter((r) => r.position === position) : rows;
    return mean(subset.map((r) => Math.abs(r.predicted - r.actual)));
  }

  function bias(rows: readonly Evaluation[]): number {
    return mean(rows.map((r) => r.actual - r.predicted));
  }

  /** Linear-interpolated quantile of a sorted copy. */
  function quantile(values: readonly number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * q;
    const lower = Math.floor(at);
    const upper = Math.min(lower + 1, sorted.length - 1);
    return sorted[lower] + (at - lower) * (sorted[upper] - sorted[lower]);
  }

  /**
   * The outcome quantiles behind every floor and ceiling shown in the interface.
   *
   * These were previously constants in `config.ts` marked as measured, with nothing
   * checked in that produced them — the exact failure the honesty rule exists to prevent.
   * They are now computed here, on the evaluation season, from the same predictions the
   * MAE table is built from.
   */
  function reportQuantiles(rows: readonly Evaluation[]): void {
    process.stdout.write(
      `\n  outcome quantiles (actual / predicted), for floor and ceiling\n` +
        `  ${"position".padEnd(10)}${"n".padStart(6)}${"p10".padStart(9)}${"p90".padStart(9)}\n`,
    );
    for (const position of positions) {
      const ratios = rows
        .filter((r) => r.position === position && r.predicted > 0)
        .map((r) => r.actual / r.predicted);
      process.stdout.write(
        `  ${position.padEnd(10)}${String(ratios.length).padStart(6)}` +
          `${quantile(ratios, 0.1).toFixed(3).padStart(9)}` +
          `${quantile(ratios, 0.9).toFixed(3).padStart(9)}\n`,
      );
    }
  }

  const positions: Position[] = ["QB", "RB", "WR", "TE"];

  for (const season of [TUNING_SEASON, EVALUATION_SEASON]) {
    const label =
      season === TUNING_SEASON ? "TUNING (in-sample)" : "EVALUATION (out-of-sample)";
    const { model, allPriorMean, lastThree } = evaluate(season);

    process.stdout.write(`\n${season} — ${label}    n = ${model.length}\n`);
    process.stdout.write(
      `${"model".padEnd(28)}${"ALL".padStart(9)}${positions
        .map((p) => p.padStart(8))
        .join("")}\n`,
    );
    process.stdout.write(`${"-".repeat(69)}\n`);

    const rows: Array<[string, Evaluation[]]> = [
      ["FGTO model", model],
      ["baseline: mean of prior games", allPriorMean],
      ["baseline: last 3 games", lastThree],
    ];
    for (const [name, data] of rows) {
      process.stdout.write(
        `${name.padEnd(28)}${mae(data).toFixed(4).padStart(9)}${positions
          .map((p) => mae(data, p).toFixed(3).padStart(8))
          .join("")}\n`,
      );
    }

    const modelMae = mae(model);
    const baseMae = mae(allPriorMean);
    const lastMae = mae(lastThree);
    process.stdout.write(
      `\n  bias (actual - predicted): ${bias(model) >= 0 ? "+" : ""}${bias(model).toFixed(3)}\n`,
    );
    process.stdout.write(
      `  vs prior-games mean: ${(((baseMae - modelMae) / baseMae) * 100).toFixed(2)}%\n`,
    );
    process.stdout.write(
      `  vs last 3 games: ${(((lastMae - modelMae) / lastMae) * 100).toFixed(2)}%\n`,
    );

    if (season === EVALUATION_SEASON) reportQuantiles(model);
  }

  // Sweeps are opt-in because they re-evaluate the whole tuning season many times over.
  // They exist so every claim in docs/model-validation.md is reproducible rather than
  // merely asserted — the project's rule is that a number the code cannot produce may not
  // be published.
  if (process.argv.includes("--sweeps")) {
    process.stdout.write(
      `\n\n${"=".repeat(69)}\nPARAMETER SWEEPS on ${TUNING_SEASON} (the tuning season)\n` +
        `${"=".repeat(69)}\n` +
        "Each row varies one parameter with the others at their frozen values.\n" +
        "This is how the frozen configuration was chosen.\n",
    );

    const sweep = (
      label: string,
      variants: Array<{ name: string; config: ModelConfig }>,
    ) => {
      process.stdout.write(`\n${label}\n${"-".repeat(69)}\n`);
      let best = { name: "", mae: Number.POSITIVE_INFINITY };
      for (const variant of variants) {
        const result = mae(evaluate(TUNING_SEASON, variant.config).model);
        if (result < best.mae) best = { name: variant.name, mae: result };
        process.stdout.write(`  ${variant.name.padEnd(34)}${result.toFixed(4)}\n`);
      }
      process.stdout.write(`  -> best: ${best.name} (${best.mae.toFixed(4)})\n`);
    };

    const base = DEFAULT_MODEL_CONFIG;

    sweep(
      "EMA alpha (lower = longer memory)",
      [0.05, 0.1, 0.15, 0.2, 0.3, 0.4].map((emaAlpha) => ({
        name: `alpha=${emaAlpha}`,
        config: { ...base, emaAlpha },
      })),
    );

    sweep(
      "Usage blend weight cap",
      [0, 0.2, 0.4, 0.6, 0.8].map((usageWeightCap) => ({
        name: `usageCap=${usageWeightCap}`,
        config: { ...base, usageWeightCap },
      })),
    );

    sweep(
      "Vegas weight, measured against the team's own prior weeks",
      [0, 0.25, 0.5, 0.75, 1].map((vegasWeight) => ({
        name: `team, w=${vegasWeight}`,
        config: { ...base, vegasWeight, vegasReference: "team" as const },
      })),
    );

    sweep(
      "Vegas weight, measured against the league average (the wrong reference)",
      [0, 0.25, 0.5, 0.75, 1].map((vegasWeight) => ({
        name: `league, w=${vegasWeight}`,
        config: { ...base, vegasWeight, vegasReference: "league" as const },
      })),
    );

    sweep(
      "Opponent defense-vs-position weight",
      [0, 0.25, 0.5, 0.75, 1].map((dvpWeight) => ({
        name: `dvp=${dvpWeight}`,
        config: { ...base, dvpWeight },
      })),
    );

    sweep("Calibration", [
      { name: "calibrated", config: base },
      { name: "uncalibrated", config: { ...base, calibrate: false } },
    ]);
  }

  process.stdout.write(
    "\nThe out-of-sample figure is the only one the product may quote.\n" +
      "Update docs/model-validation.md in the same commit as any model change.\n" +
      "Run with --sweeps to reproduce how the frozen parameters were chosen.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`backtest failed: ${String(error)}\n`);
  process.exitCode = 1;
});
