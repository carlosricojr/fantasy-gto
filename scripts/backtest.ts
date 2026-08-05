/**
 * Model backtest.
 *
 * This script is the sole authority for any accuracy claim the product makes. It
 * downloads real nflverse data, replays historical weeks using only information that was
 * available before kickoff, and reports MAE against baselines.
 *
 * `pnpm backtest` scores the development and tuning sets. `pnpm backtest -- --holdout`
 * scores the holdout and is the only run that rewrites the published figures. Downloads are
 * cached under `.cache/nflverse`.
 *
 * Method, and why each choice matters:
 *
 * - Hyperparameters were chosen on the tuning seasons and are frozen in `config.ts`. The
 *   holdout is therefore genuinely out-of-sample, and stays that way only because scoring
 *   it takes a flag.
 * - Defense-vs-position factors always come from the *preceding* season. Building them from
 *   the season being evaluated would leak the outcome into the prediction.
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

/**
 * The evaluation protocol, named rather than spelled as loop literals.
 *
 * Development seasons are free to explore. Tuning seasons are where hyperparameters may be
 * selected. The holdout is evaluated **once per hypothesis, at a pre-registered decision
 * point**, and `pnpm backtest` does not touch it without `--holdout`.
 *
 * The floor is 2013, not 2012 as originally scoped. The stated reason for 2012 was that
 * `snap_counts` begins there; it does not. `snap_counts_2012.csv` answers HTTP 200 with a
 * valid sixteen-column header and **zero data rows**, and the release is first populated in
 * 2013. A split whose first development season carries no snap data is a split that cannot
 * carry every planned feature, which was the criterion that chose the floor in the first
 * place. See `docs/data-sources.md`.
 */
const DEVELOPMENT_SEASONS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021] as const;
const TUNING_SEASONS = [2022, 2023, 2024] as const;
const HOLDOUT_SEASON = 2025;

/**
 * How many prior seasons of a player's history a projection may see.
 *
 * Two, which is what the frozen configuration was given when it was evaluated on the
 * holdout — the script loaded 2023, 2024, and 2025, so a 2025 projection saw two prior
 * seasons. That was previously implicit in the loadout rather than stated, and it was not
 * even consistent: evaluating 2024 from the same loadout gave a projection only *one* prior
 * season, because 2025 sits after it chronologically and is sliced away.
 *
 * Naming it matters more than it looks. Expanding the window without fixing the lookback
 * would hand every projection up to thirteen seasons of history, which changes the holdout
 * prediction itself — and a changed holdout prediction is a fresh evaluation of the holdout,
 * spent on a refactor.
 */
const SEASON_HISTORY_LOOKBACK = 2;

/**
 * The exact season loadout that produced every published figure.
 *
 * Restricting a player's history to this set reproduces the frozen pipeline exactly for
 * *both* things it is the authority for: the holdout evaluation, and the calibration
 * factors derived on 2024. One set covers both because the chronological slice already
 * drops everything after the week being projected, so including 2025 here cannot leak into
 * a 2024 projection.
 */
const FROZEN_HISTORY_SEASONS: readonly number[] = [2023, 2024, HOLDOUT_SEASON];

/** The season the calibration factors in `config.ts` were derived on. */
const CALIBRATION_SEASON = 2024;

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
  /** The level both intervals are built at, as a percentage. The page states it in words. */
  confidenceLevel: number;
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
    confidenceLevel: number;
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
  /**
   * The same comparison against the weaker baseline.
   *
   * Carried because the document quotes its figures and the honesty rule is that a
   * published number must be one the code produces. It was stated in prose with nothing
   * asserting it, which is the failure the artifact exists to prevent — happening to the
   * second-most-quoted comparison in the file.
   */
  significanceVsLastThree: PublishedSignificance;
}
/** Every season that has to be loaded: each evaluated season plus its lookback. */
function seasonsToLoad(evaluated: readonly number[]): number[] {
  const wanted = new Set<number>();
  for (const season of evaluated) {
    for (let back = 0; back <= SEASON_HISTORY_LOOKBACK; back += 1) {
      wanted.add(season - back);
    }
  }
  for (const season of FROZEN_HISTORY_SEASONS) wanted.add(season);
  return [...wanted].sort((a, b) => a - b);
}

/** The history a projection for `season` may see, under the uniform lookback. */
function historyWindow(season: number): number[] {
  return Array.from(
    { length: SEASON_HISTORY_LOOKBACK + 1 },
    (_, back) => season - back,
  );
}

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

/**
 * Refuses a season that parsed cleanly and means nothing.
 *
 * The failure this exists for is not a missing file — that throws loudly. It is a file that
 * answers 200, carries every expected column, and is empty or unpopulated. Both forms are
 * real in these releases: `snap_counts_2012.csv` has a valid header and zero rows, and the
 * `stats_player_week` files for 2004 through 2008 have all 145 columns with **0%** of skill
 * rows carrying a target share, a WOPR, or even a target. `num()` reads a missing or blank
 * cell as zero, so those seasons produce a complete, plausible, entirely fictional usage
 * signal and a backtest that reports a confident number built from nothing.
 *
 * Coverage is therefore asserted per season rather than assumed, on the column that would
 * fail first and silently. See `docs/data-sources.md`.
 */
const MIN_USAGE_COVERAGE = 0.5;

function assertSeasonUsable(season: number, weeks: readonly PlayerWeek[]): void {
  if (weeks.length === 0) {
    throw new Error(`${season}: parsed to zero regular-season player-weeks`);
  }
  const receivers = weeks.filter((w) =>
    ["WR", "TE", "RB"].includes(w.competitor.position),
  );
  if (receivers.length === 0) {
    throw new Error(`${season}: parsed ${weeks.length} rows but no skill positions`);
  }
  const withUsage = receivers.filter((w) => w.usage.targetShare > 0).length;
  const coverage = withUsage / receivers.length;
  if (coverage < MIN_USAGE_COVERAGE) {
    throw new Error(
      `${season}: only ${(coverage * 100).toFixed(1)}% of ${receivers.length} skill ` +
        `player-weeks carry a target share, below the ${MIN_USAGE_COVERAGE * 100}% floor. ` +
        `The release is present but unpopulated; the usage term would be built from zeros.`,
    );
  }
}

async function main(): Promise<void> {
  process.stdout.write("Fantasy GTO model backtest\n\n");

  const startedAt = process.hrtime.bigint();
  const wantsHoldout = process.argv.includes("--holdout");
  const evaluatedSeasons = [...DEVELOPMENT_SEASONS, ...TUNING_SEASONS];
  // The holdout's own seasons are loaded either way, because the calibration factors are
  // derived under `FROZEN_HISTORY_SEASONS` and that set names them. Loading a season is not
  // evaluating it; only `runHoldout` scores 2025.
  const loadSeasons = seasonsToLoad(evaluatedSeasons);

  const provider = new NflverseProvider(cachedFetch);

  // Warm the cache explicitly so the download messages appear before the work.
  await cachedFetch(schedulesUrl());
  for (const season of loadSeasons) {
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
  for (const season of loadSeasons) {
    const result = await provider.playerWeeks(season);
    if (!result.ok) throw new Error(`${season}: ${result.reason}`);
    assertSeasonUsable(season, result.data);
    seasons.set(season, result.data);
  }

  // Defense-vs-position always comes from the season before the one being evaluated.
  // Building it from the evaluated season would leak the outcome into the prediction.
  const defenseFactors = new Map<number, Map<string, number>>();
  for (const season of loadSeasons) {
    const previous = seasons.get(season - 1);
    if (previous) {
      defenseFactors.set(season, buildDefenseFactors(previous, PPR, DVP_SHRINKAGE));
    }
  }

  // Chronological history per player across every loaded season. The window a given
  // projection may actually see is applied per evaluation, not here.
  const history = new Map<string, PlayerWeek[]>();
  for (const season of loadSeasons) {
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

  const orderedCompetitorIds = [...history.keys()].sort();

  const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  process.stdout.write(
    `loaded ${loadSeasons.length} seasons (${loadSeasons[0]}–${loadSeasons[loadSeasons.length - 1]}), ` +
      `${[...seasons.values()].reduce((n, s) => n + s.length, 0).toLocaleString("en-US")} ` +
      `player-weeks, ${history.size.toLocaleString("en-US")} players, in ${elapsedSeconds.toFixed(1)}s\n`,
  );

  /**
   * Scores one season.
   *
   * `historySeasons` is the set of seasons a projection is allowed to see. It is the whole
   * of the evaluation protocol expressed as a parameter: pass `FROZEN_HISTORY_SEASONS` and
   * this reproduces the pipeline the published figures came from, pass `historyWindow(s)`
   * and every season is treated identically under the uniform lookback.
   *
   * Without it, "load more seasons" and "leave the holdout prediction alone" are in direct
   * conflict, because the model's history is whatever happens to be in memory.
   */
  function evaluate(
    season: number,
    config: ModelConfig = DEFAULT_MODEL_CONFIG,
    historySeasons: readonly number[] = historyWindow(season),
  ): {
    model: Evaluation[];
    allPriorMean: Evaluation[];
    lastThree: Evaluation[];
  } {
    const allowed = new Set(historySeasons);
    const model: Evaluation[] = [];
    // Named for what it is: the mean of every prior game inside the history window, which
    // spans up to three seasons. Calling it a "season-to-date mean" would be wrong, and
    // restricting it to the current season would hand the model an unfair advantage early
    // in the year — the baseline should see exactly the history the model sees.
    const allPriorMean: Evaluation[] = [];
    const lastThree: Evaluation[] = [];
    const factors = defenseFactors.get(season);

    // Players in a canonical order rather than in whatever order they first appeared in the
    // loaded files. Every mean below is a floating-point sum, so the order the rows are
    // produced in decides the last digit or two of every published figure — and that order
    // used to change whenever the set of loaded seasons changed. Sorting makes the artifact
    // a function of the data alone.
    for (const competitorId of orderedCompetitorIds) {
      const bucket = history.get(competitorId)!;
      for (let i = 0; i < bucket.length; i += 1) {
        const week = bucket[i];
        if (week.period.season !== season) continue;
        const position = week.competitor.position;
        if (position === "K") continue;

        // Chronologically prior *and* inside the window. The slice already drops everything
        // after the week being projected, so the filter only ever removes seasons that are
        // too far back — which is why one allowed-set reproduces the frozen pipeline for
        // both the holdout and the calibration season.
        const prior = bucket.slice(0, i).filter((w) => allowed.has(w.period.season));
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
        `    ${result.confidenceLevel}% CI on delta MAE       [${result.interval[0].toFixed(4)}, ${result.interval[1].toFixed(4)}]\n` +
        `    ${result.confidenceLevel}% CI on the edge        [${result.percentInterval[0].toFixed(2)}%, ${result.percentInterval[1].toFixed(2)}%]\n` +
        `    MDE at 80% power           ${result.minimumDetectableEffect.toFixed(4)}   ` +
        `(${result.minimumDetectablePercent.toFixed(2)}%)\n` +
        `    smallest significant       ${result.minimumSignificantEffect.toFixed(4)}   ` +
        `(${result.minimumSignificantPercent.toFixed(2)}%)\n` +
        `    bootstrap, ${boot.resamples} resamples, seed ${boot.seed}\n` +
        `      SE                       ${boot.standardError.toFixed(4)}\n` +
        `      ${boot.confidenceLevel}% CI on delta MAE     [${boot.interval[0].toFixed(4)}, ${boot.interval[1].toFixed(4)}]\n` +
        `      ${boot.confidenceLevel}% CI on the edge      [${boot.percentInterval[0].toFixed(2)}%, ${boot.percentInterval[1].toFixed(2)}%]\n`,
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
  let calibrationEffect: PublishedMetrics["calibration"] | null = null;

  /** One comparison, in the shape the artifact publishes. */
  function toPublished(
    comparison: string,
    measured: ReturnType<typeof reportComparison>,
  ): PublishedSignificance {
    const { result, boot } = measured;
    return {
      comparison,
      clusters: result.clusters,
      meanDelta: result.meanDelta,
      clusteredStandardError: result.standardError,
      iidStandardError: result.iidStandardError,
      degreesOfFreedom: result.degreesOfFreedom,
      t: result.t,
      pValue: result.pValue,
      confidenceLevel: result.confidenceLevel,
      confidenceInterval: [...result.interval],
      percentConfidenceInterval: [...result.percentInterval],
      minimumDetectableEffect: result.minimumDetectableEffect,
      minimumDetectablePercent: result.minimumDetectablePercent,
      minimumSignificantEffect: result.minimumSignificantEffect,
      minimumSignificantPercent: result.minimumSignificantPercent,
      bootstrap: {
        resamples: boot.resamples,
        seed: boot.seed,
        confidenceLevel: boot.confidenceLevel,
        standardError: boot.standardError,
        confidenceInterval: [...boot.interval],
        percentConfidenceInterval: [...boot.percentInterval],
      },
    };
  }

  /**
   * Scores a whole set of seasons and reports it pooled.
   *
   * Pooling is the entire point of the expanded window. The clustered standard error falls
   * roughly as one over the square root of the number of *players*, and a player appearing
   * across nine seasons is still one cluster — which is correct, since the model misreads
   * him the same way every year, and treating each of his seasons as independent evidence
   * would rebuild the error the clustering exists to remove.
   *
   * Per-season rows are printed too, because a set whose seasons disagree is telling you
   * something a pooled mean hides.
   */
  function evaluateSet(
    label: string,
    setSeasons: readonly number[],
    config: ModelConfig = DEFAULT_MODEL_CONFIG,
  ) {
    const model: Evaluation[] = [];
    const allPriorMean: Evaluation[] = [];
    const lastThree: Evaluation[] = [];

    process.stdout.write(
      `\n${"=".repeat(78)}\n${label}: ${setSeasons[0]}–${setSeasons[setSeasons.length - 1]}\n${"=".repeat(78)}\n` +
        `${"season".padEnd(10)}${"n".padStart(8)}${"players".padStart(9)}` +
        `${"model".padStart(10)}${"prior-mean".padStart(12)}${"last-3".padStart(10)}${"edge".padStart(9)}\n`,
    );
    for (const season of setSeasons) {
      const scored = evaluate(season, config);
      const m = mae(scored.model);
      const b = mae(scored.allPriorMean);
      process.stdout.write(
        `${String(season).padEnd(10)}${String(scored.model.length).padStart(8)}` +
          `${String(new Set(scored.model.map((r) => r.competitorId)).size).padStart(9)}` +
          `${m.toFixed(4).padStart(10)}${b.toFixed(4).padStart(12)}` +
          `${mae(scored.lastThree).toFixed(4).padStart(10)}` +
          `${`${(((b - m) / b) * 100).toFixed(2)}%`.padStart(9)}\n`,
      );
      model.push(...scored.model);
      allPriorMean.push(...scored.allPriorMean);
      lastThree.push(...scored.lastThree);
    }

    process.stdout.write(`${"-".repeat(78)}\n`);
    process.stdout.write(
      `${"POOLED".padEnd(10)}${String(model.length).padStart(8)}` +
        `${String(new Set(model.map((r) => r.competitorId)).size).padStart(9)}` +
        `${mae(model).toFixed(4).padStart(10)}${mae(allPriorMean).toFixed(4).padStart(12)}` +
        `${mae(lastThree).toFixed(4).padStart(10)}` +
        `${`${(((mae(allPriorMean) - mae(model)) / mae(allPriorMean)) * 100).toFixed(2)}%`.padStart(9)}\n`,
    );
    process.stdout.write(
      `\n  bias (actual - predicted): ${bias(model) >= 0 ? "+" : ""}${bias(model).toFixed(3)}\n` +
        `  per position: ${positions.map((p) => `${p} ${mae(model, p).toFixed(3)}`).join("  ")}\n`,
    );

    const vsPriorGamesMean = reportComparison(
      "baseline: mean of prior games",
      model,
      allPriorMean,
    );
    reportComparison("baseline: last 3 games", model, lastThree);
    return { model, allPriorMean, lastThree, vsPriorGamesMean };
  }

  evaluateSet("DEVELOPMENT — free exploration", DEVELOPMENT_SEASONS);
  evaluateSet("TUNING — hyperparameter selection only", TUNING_SEASONS);

  /**
   * The holdout, behind a flag.
   *
   * `pnpm backtest` cannot reach this. Evaluating 2025 is a deliberate act taken once per
   * hypothesis at a pre-registered decision point, and the single most valuable property
   * this repository has is that the frozen configuration was chosen before 2025 was ever
   * looked at. A default run that quietly scored it would spend that property on every
   * routine invocation.
   *
   * It runs under `FROZEN_HISTORY_SEASONS` rather than the uniform lookback, so it
   * reproduces the published figures exactly rather than approximately.
   */
  function runHoldout(): {
    published: Omit<
      PublishedMetrics,
      "calibration" | "significance" | "significanceVsLastThree"
    >;
    significance: PublishedSignificance;
    significanceVsLastThree: PublishedSignificance;
  } {
    const season = HOLDOUT_SEASON;
    const { model, allPriorMean, lastThree } = evaluate(
      season,
      DEFAULT_MODEL_CONFIG,
      FROZEN_HISTORY_SEASONS,
    );

    process.stdout.write(
      `\n${"=".repeat(78)}\nHOLDOUT ${season} — frozen pipeline, out-of-sample    n = ${model.length}\n${"=".repeat(78)}\n`,
    );
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

    const vsPriorGamesMean = reportComparison(
      "baseline: mean of prior games",
      model,
      allPriorMean,
    );
    const vsLastThree = reportComparison("baseline: last 3 games", model, lastThree);

    reportQuantiles(model);
    return {
      significance: toPublished("baseline: mean of prior games", vsPriorGamesMean),
      significanceVsLastThree: toPublished("baseline: last 3 games", vsLastThree),
      published: {
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
      },
    };
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
    // Under the frozen history seasons, not the uniform lookback. `CALIBRATION` in
    // `config.ts` was derived from this exact pipeline and then frozen before the holdout
    // was evaluated; re-deriving it under the wider window would move the constants, and
    // copying those back in would move the published holdout figure — which is a fresh
    // evaluation of the holdout, spent on a refactor. The constants stay reproducible
    // because the pipeline that produced them is preserved rather than replaced.
    const uncalibrated = evaluate(
      CALIBRATION_SEASON,
      { ...DEFAULT_MODEL_CONFIG, calibrate: false },
      FROZEN_HISTORY_SEASONS,
    ).model;

    process.stdout.write(
      `\n${"=".repeat(69)}\nCALIBRATION FACTORS, derived on ${CALIBRATION_SEASON} with calibration off\n` +
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
      season: CALIBRATION_SEASON,
      offMae: mae(uncalibrated),
      onMae: mae(
        evaluate(CALIBRATION_SEASON, DEFAULT_MODEL_CONFIG, FROZEN_HISTORY_SEASONS).model,
      ),
    };
  }

  // Sweeps are opt-in because they re-evaluate the whole tuning season many times over.
  // They exist so every claim in docs/model-validation.md is reproducible rather than
  // merely asserted — the project's rule is that a number the code cannot produce may not
  // be published.
  if (process.argv.includes("--sweeps")) {
    process.stdout.write(
      `\n\n${"=".repeat(69)}\nPARAMETER SWEEPS on the tuning set ${TUNING_SEASONS[0]}–${TUNING_SEASONS[TUNING_SEASONS.length - 1]}\n` +
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
        // Pooled across the whole tuning set, which is the point of widening it: a sweep
        // resolved on one season picks its optimum out of noise the size of the effect.
        const result = mae(
          TUNING_SEASONS.flatMap((season) => evaluate(season, variant.config).model),
        );
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

  if (!wantsHoldout) {
    process.stdout.write(
      `\n${"=".repeat(78)}\n` +
        `HOLDOUT ${HOLDOUT_SEASON} NOT EVALUATED.\n` +
        `${"=".repeat(78)}\n` +
        `This run scored the development and tuning sets only, and did not rewrite\n` +
        `${PUBLISHED_METRICS_PATH.replace(`${process.cwd()}/`, "")}.\n\n` +
        `Run \`pnpm backtest -- --holdout\` to score it. Do that once per hypothesis, at a\n` +
        `decision point written down in advance — not to see how a change landed.\n`,
    );
    return;
  }

  const holdout = runHoldout();

  if (calibrationEffect === null) throw new Error("calibration effect not measured");
  writeFileSync(
    PUBLISHED_METRICS_PATH,
    `${JSON.stringify(
      {
        ...holdout.published,
        calibration: calibrationEffect,
        significance: holdout.significance,
        significanceVsLastThree: holdout.significanceVsLastThree,
      },
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
