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
 * - Every model-versus-baseline difference is reported with a standard error clustered by
 *   player, not as a bare point estimate. Player-weeks repeat the same player up to
 *   seventeen times, so treating them as independent understates the error and overstates
 *   how much any comparison here has established. See `lib/core/stats.ts`.
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
  LEAGUE_MEAN_IMPLIED_TEAM_TOTAL,
  type ModelConfig,
} from "@/lib/nfl/model/config";
import {
  type PairedError,
  bootstrapPairedComparison,
  pairedComparison,
  quantile,
} from "@/lib/core/stats";
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

/**
 * Resamples in the block bootstrap, and the seed that drives it.
 *
 * The seed is arbitrary but fixed and written down, so every interval this script prints is
 * reproducible rather than a number that shifts between runs. Two thousand resamples put
 * the Monte Carlo error on the bootstrap standard error at roughly 1.6%, which is well
 * inside the tolerance at which it is being used — as a distribution-free check on the
 * analytic figure, not as a replacement for it.
 */
const BOOTSTRAP_RESAMPLES = 2_000;
const BOOTSTRAP_SEED = 8_675_309;

/** Where the published figures are written for the interface to import. */
const PUBLISHED_METRICS_PATH = join(
  process.cwd(),
  "lib/nfl/model/published-metrics.json",
);

/**
 * How certain the headline edge is.
 *
 * The product published `edgeVsPriorGamesMean` for a long time with nothing beside it, so a
 * reader had no way to tell a measured result from a coin landing the same way twice. Every
 * figure here describes the model-versus-prior-games-mean comparison on the evaluation
 * season — the one the interface quotes.
 */
interface PublishedSignificance {
  comparison: string;
  /** Distinct players. The effective sample size, and far smaller than `sampleSize`. */
  clusters: number;
  /** `priorGamesMeanMae − modelMae`, in fantasy points. */
  meanDelta: number;
  clusteredStandardError: number;
  /** What assuming independence would have given. Published to show the size of the gap. */
  iidStandardError: number;
  degreesOfFreedom: number;
  t: number;
  pValue: number;
  confidenceInterval: [number, number];
  percentConfidenceInterval: [number, number];
  minimumDetectableEffect: number;
  minimumDetectablePercent: number;
  /** The smallest measured effect that could be reported as significant on this sample. */
  minimumSignificantEffect: number;
  minimumSignificantPercent: number;
  bootstrap: {
    resamples: number;
    seed: number;
    standardError: number;
    confidenceInterval: [number, number];
    percentConfidenceInterval: [number, number];
  };
}

/** The shape `/accuracy` and the landing page consume. */
interface PublishedMetrics {
  season: number;
  sampleSize: number;
  modelMae: number;
  priorGamesMeanMae: number;
  lastThreeMae: number;
  edgeVsPriorGamesMean: number;
  edgeVsLastThree: number;
  bias: number;
  perPositionMae: Record<string, number>;
  /** Measured on the tuning season, which is where calibration is fitted. */
  calibration: { season: number; onMae: number; offMae: number };
  significance: PublishedSignificance;
}
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
  /** The clustering unit. Kept per row so a comparison can be player-clustered. */
  competitorId: string;
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

        const competitorId = week.competitor.id;
        model.push({ competitorId, position, predicted: projection.mean, actual });
        allPriorMean.push({
          competitorId,
          position,
          predicted: mean(priorPoints),
          actual,
        });
        lastThree.push({
          competitorId,
          position,
          predicted: mean(priorPoints.slice(-3)),
          actual,
        });
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

  /**
   * Pairs a model row against the baseline row for the same player-week.
   *
   * `evaluate` pushes all three predictors inside one loop, so index `i` is the same
   * player-week in each. That is an invariant worth checking rather than trusting: pairing
   * against the wrong rows would still produce a plausible mean difference and a standard
   * error that means nothing, and nothing downstream would look wrong.
   */
  function paired(
    model: readonly Evaluation[],
    baseline: readonly Evaluation[],
  ): PairedError[] {
    if (model.length !== baseline.length) {
      throw new Error(
        `paired: ${model.length} model rows against ${baseline.length} baseline rows`,
      );
    }
    return model.map((row, i) => {
      if (baseline[i].competitorId !== row.competitorId) {
        throw new Error(`paired: rows misaligned at ${i}`);
      }
      return {
        cluster: row.competitorId,
        model: Math.abs(row.predicted - row.actual),
        baseline: Math.abs(baseline[i].predicted - baseline[i].actual),
      };
    });
  }

  /**
   * A p-value small enough to underflow is printed as a bound, never as zero.
   *
   * `p = 0` would claim a certainty no finite sample supports. The bound printed instead is
   * the smallest positive double there is, which is where the tail computation runs out —
   * the true value is below it, and how far below is not something this arithmetic knows.
   */
  function formatP(p: number): string {
    if (p === 0) return `< ${Number.MIN_VALUE.toExponential(0)}`;
    return p < 1e-4 ? `= ${p.toExponential(2)}` : `= ${p.toFixed(4)}`;
  }

  /**
   * Prints the difference against one baseline with its uncertainty.
   *
   * The minimum detectable effect is the line to read first when planning any change to the
   * model: an effect smaller than it cannot be told from noise on this sample no matter
   * what the run comes back with, so measuring one is not evidence, it is a coin flip with
   * extra steps.
   */
  function reportComparison(
    label: string,
    model: readonly Evaluation[],
    baseline: readonly Evaluation[],
  ) {
    const rows = paired(model, baseline);
    const result = pairedComparison(rows);
    const boot = bootstrapPairedComparison(rows, {
      resamples: BOOTSTRAP_RESAMPLES,
      seed: BOOTSTRAP_SEED,
    });
    const signed = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(4)}`;

    process.stdout.write(
      `\n  significance vs ${label}\n` +
        `    delta MAE                 ${signed(result.meanDelta)}   ` +
        `(${result.percentEdge >= 0 ? "+" : ""}${result.percentEdge.toFixed(2)}%)\n` +
        `    clustered SE               ${result.standardError.toFixed(4)}   ` +
        `G = ${result.clusters} players, n = ${result.n}\n` +
        // Reported as a ratio rather than as "understates by x%", because it does not
        // always understate. Clustering inflates the standard error only when a player's
        // paired differences reinforce each other; against the last-3-games baseline they
        // partly cancel, and the clustered figure comes out slightly smaller.
        `    i.i.d. SE                  ${result.iidStandardError.toFixed(4)}   ` +
        `clustered / i.i.d. = ${(result.standardError / result.iidStandardError).toFixed(2)}\n` +
        `    t                         ${signed(result.t)}   ` +
        `df = ${result.degreesOfFreedom}, p ${formatP(result.pValue)}\n` +
        `    95% CI on delta MAE       [${result.interval[0].toFixed(4)}, ${result.interval[1].toFixed(4)}]\n` +
        `    95% CI on the edge        [${result.percentInterval[0].toFixed(2)}%, ${result.percentInterval[1].toFixed(2)}%]\n` +
        `    MDE at 80% power           ${result.minimumDetectableEffect.toFixed(4)}   ` +
        `(${result.minimumDetectablePercent.toFixed(2)}%)\n` +
        `    smallest significant       ${result.minimumSignificantEffect.toFixed(4)}   ` +
        `(${result.minimumSignificantPercent.toFixed(2)}%)\n` +
        `    bootstrap, ${boot.resamples} resamples, seed ${boot.seed}\n` +
        `      SE                       ${boot.standardError.toFixed(4)}\n` +
        `      95% CI on delta MAE     [${boot.interval[0].toFixed(4)}, ${boot.interval[1].toFixed(4)}]\n` +
        `      95% CI on the edge      [${boot.percentInterval[0].toFixed(2)}%, ${boot.percentInterval[1].toFixed(2)}%]\n`,
    );
    return { result, boot };
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
    // A position with no rows renders as NaN rather than as 0.000, which is deliberate: a
    // zero here would read as a measured quantile of zero.
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

  /**
   * The league mean implied team total, which `LEAGUE_MEAN_IMPLIED_TEAM_TOTAL` freezes.
   *
   * Reported for the same reason the quantiles and calibration factors are: it was a
   * constant in `config.ts` marked as measured with nothing checked in that produced it,
   * and it is load-bearing — `project.ts` uses it as the Vegas reference for any team with
   * no prior week of its own.
   */
  function reportLeagueMeanImpliedTotal(): void {
    const all = [...teamTotals.values()].flat();
    if (all.length === 0) {
      // Printing NaN next to the frozen constant is the worst possible failure for the
      // number the honesty ledger is checked against — it reads as a mismatch.
      process.stdout.write(
        `\n  league mean implied team total: no market lines loaded, not computed\n`,
      );
      return;
    }
    const measured = mean(all.map((e) => e.impliedTotal));
    process.stdout.write(
      `\n  league mean implied team total\n` +
        `  across ${all.length} team-games: ${measured.toFixed(3)}\n` +
        `  (frozen in config.ts as ${LEAGUE_MEAN_IMPLIED_TEAM_TOTAL})\n`,
    );
  }

  const positions: Position[] = ["QB", "RB", "WR", "TE"];

  /**
   * The figures the marketing pages render, captured during the evaluation run.
   *
   * Written to `lib/nfl/model/published-metrics.json`, which `/accuracy` and the landing
   * page import. They previously transcribed these numbers into JSX by hand, which is the
   * same failure mode as a constant marked "measured" with nothing producing it: the
   * moment the model changes, the page states something no longer true and nothing
   * detects it.
   */
  let publishedMetrics: Omit<PublishedMetrics, "calibration" | "significance"> | null =
    null;
  let calibrationEffect: PublishedMetrics["calibration"] | null = null;
  let significance: PublishedSignificance | null = null;

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

    // Both baselines, both seasons. The tuning season's figures are in-sample and are not
    // a claim about accuracy, but their standard error is the one that sizes every future
    // hypothesis: an effect below the MDE printed there cannot be established on a single
    // season of this population, whichever season it is.
    const vsPriorGamesMean = reportComparison(
      "baseline: mean of prior games",
      model,
      allPriorMean,
    );
    reportComparison("baseline: last 3 games", model, lastThree);

    if (season === EVALUATION_SEASON) {
      reportQuantiles(model);
      significance = {
        comparison: "baseline: mean of prior games",
        clusters: vsPriorGamesMean.result.clusters,
        meanDelta: vsPriorGamesMean.result.meanDelta,
        clusteredStandardError: vsPriorGamesMean.result.standardError,
        iidStandardError: vsPriorGamesMean.result.iidStandardError,
        degreesOfFreedom: vsPriorGamesMean.result.degreesOfFreedom,
        t: vsPriorGamesMean.result.t,
        pValue: vsPriorGamesMean.result.pValue,
        confidenceInterval: [...vsPriorGamesMean.result.interval],
        percentConfidenceInterval: [...vsPriorGamesMean.result.percentInterval],
        minimumDetectableEffect: vsPriorGamesMean.result.minimumDetectableEffect,
        minimumDetectablePercent: vsPriorGamesMean.result.minimumDetectablePercent,
        minimumSignificantEffect: vsPriorGamesMean.result.minimumSignificantEffect,
        minimumSignificantPercent: vsPriorGamesMean.result.minimumSignificantPercent,
        bootstrap: {
          resamples: vsPriorGamesMean.boot.resamples,
          seed: vsPriorGamesMean.boot.seed,
          standardError: vsPriorGamesMean.boot.standardError,
          confidenceInterval: [...vsPriorGamesMean.boot.interval],
          percentConfidenceInterval: [...vsPriorGamesMean.boot.percentInterval],
        },
      };
      publishedMetrics = {
        season,
        sampleSize: model.length,
        modelMae,
        priorGamesMeanMae: baseMae,
        lastThreeMae: lastMae,
        edgeVsPriorGamesMean: ((baseMae - modelMae) / baseMae) * 100,
        edgeVsLastThree: ((lastMae - modelMae) / lastMae) * 100,
        bias: bias(model),
        perPositionMae: Object.fromEntries(
          positions.map((p) => [p, mae(model, p)]),
        ) as Record<string, number>,
      };
    }
  }

  /**
   * Derives the per-position calibration factors.
   *
   * These are `mean(actual) / mean(predicted)` on the **tuning** season with calibration
   * switched off — the same computation that produced the constants in `config.ts`. It is
   * printed here so those constants are reproducible rather than asserted, which is the
   * rule the rest of this script exists to satisfy.
   */
  function reportCalibration(): void {
    const uncalibrated = evaluate(TUNING_SEASON, {
      ...DEFAULT_MODEL_CONFIG,
      calibrate: false,
    }).model;

    process.stdout.write(
      `\n${"=".repeat(69)}\nCALIBRATION FACTORS, derived on ${TUNING_SEASON} with calibration off\n` +
        `${"=".repeat(69)}\n` +
        `  ${"position".padEnd(10)}${"n".padStart(6)}${"mean pred".padStart(11)}` +
        `${"mean actual".padStart(13)}${"factor".padStart(9)}\n`,
    );
    for (const position of positions) {
      const rows = uncalibrated.filter((r) => r.position === position);
      const predicted = mean(rows.map((r) => r.predicted));
      const actual = mean(rows.map((r) => r.actual));
      const factor = predicted === 0 ? 1 : actual / predicted;
      process.stdout.write(
        `  ${position.padEnd(10)}${String(rows.length).padStart(6)}` +
          `${predicted.toFixed(3).padStart(11)}${actual.toFixed(3).padStart(13)}` +
          `${factor.toFixed(4).padStart(9)}\n`,
      );
    }
    process.stdout.write(
      "  These are the values in CALIBRATION (lib/nfl/model/config.ts).\n",
    );

    // Both sides of the calibration comparison, so `/accuracy` can render the effect
    // instead of transcribing it from the sweeps table.
    calibrationEffect = {
      season: TUNING_SEASON,
      offMae: mae(uncalibrated),
      onMae: mae(evaluate(TUNING_SEASON).model),
    };
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

  reportCalibration();
  reportLeagueMeanImpliedTotal();

  if (publishedMetrics === null) throw new Error("evaluation season produced no metrics");
  if (calibrationEffect === null) throw new Error("calibration effect not measured");
  if (significance === null) throw new Error("significance not measured");
  writeFileSync(
    PUBLISHED_METRICS_PATH,
    `${JSON.stringify(
      { ...publishedMetrics, calibration: calibrationEffect, significance },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `\n  wrote ${PUBLISHED_METRICS_PATH.replace(`${process.cwd()}/`, "")}\n`,
  );

  process.stdout.write(
    "\nThe out-of-sample figure is the only one the product may quote, and it is quoted\n" +
      "with the interval printed beside it rather than on its own.\n" +
      "Update docs/model-validation.md in the same commit as any model change.\n" +
      "Run with --sweeps to reproduce how the frozen parameters were chosen.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`backtest failed: ${String(error)}\n`);
  process.exitCode = 1;
});
