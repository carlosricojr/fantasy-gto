import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseCsv, num, str } from "@/lib/nfl/csv";
import { MODEL_BLEND_WEIGHT, SEASON_EMA_ALPHA } from "@/lib/nfl/draft/config";
import {
  type AdpCurveSet,
  adpImpliedPoints,
  blendedSeasonValue,
  fitAdpCurves,
  seasonProjection,
} from "@/lib/nfl/draft/value";
import { buildMarketIndex } from "@/lib/nfl/draft/match";
import { MODELLED_POSITIONS, normalizeMarketPosition } from "@/lib/nfl/draft/config";
import { adpUrl, parseAdp } from "@/lib/sources/adp";

/**
 * Draft valuation backtest.
 *
 * The authority for every claim `/draft` makes about how well it ranks players. The
 * question it answers is deliberately uncomfortable: **does our model beat the market?**
 * The answer is no, and the design follows from that.
 *
 * Discipline matches the weekly backtest. The blend weight is chosen on the tuning season
 * and then applied, unchanged, to a season that was not looked at while choosing it.
 * Re-tuning against the evaluation season would make the published figure meaningless.
 *
 * Metric is Spearman rank correlation against actual season points, plus the mean actual
 * points of each method's top 24 and top 48. Rank correlation is the right measure for a
 * draft: nobody cares whether a projection said 240 or 260, they care who to take first.
 */

const TUNING_SEASON = 2023;
const EVALUATION_SEASON = 2024;
/** Sweep range for the blend weight. 0 is pure market, 1 is pure model. */
const BLEND_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];

const LEAGUE_TEAMS = 12;
const SCORING_ID = "ppr";

const CACHE_DIR = join(process.cwd(), ".cache", "nflverse");
const ADP_CACHE_DIR = join(process.cwd(), ".cache", "adp");
const PUBLISHED_PATH = join(
  process.cwd(),
  "lib/nfl/draft/published-draft-metrics.json",
);

interface PublishedDraftMetrics {
  tuningSeason: number;
  evaluationSeason: number;
  chosenBlendWeight: number;
  sampleSize: number;
  spearman: { adpOnly: number; modelOnly: number; blended: number };
  topN: Record<string, { adpOnly: number; modelOnly: number; blended: number }>;
  /** Improvement of the blend over the market alone, in percent of correlation. */
  /**
   * Blend against market, as a **percentage**, not a fraction.
   *
   * Named for the unit because every sibling here is a correlation in [-1, 1], and a bare
   * `-0.72` beside three of those reads as a fraction — which is a hundredfold error in
   * the one field the honesty ledger is most often quoted from.
   */
  edgeOverMarketPercent: number;
}

async function cached(dir: string, file: string, url: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  if (existsSync(path)) return readFileSync(path, "utf8");
  process.stdout.write(`  downloading ${file}...\n`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const text = await response.text();
  writeFileSync(path, text);
  return text;
}

interface PlayerSeason {
  id: string;
  name: string;
  position: string;
  perGamePoints: number[];
  games: number;
  total: number;
}

/** Per-player weekly PPR points for a regular season, in week order. */
async function loadSeason(season: number): Promise<Map<string, PlayerSeason>> {
  const csv = await cached(
    CACHE_DIR,
    `stats_player_week_${season}.csv`,
    `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${season}.csv`,
  );
  const rows = parseCsv(csv);
  const byPlayer = new Map<string, PlayerSeason>();
  const weekly: Array<{ id: string; week: number; points: number }> = [];

  for (const row of rows) {
    if (str(row, "season_type") !== "REG") continue;
    let position = str(row, "position").toUpperCase();
    if (position === "FB") position = "RB";
    // The production list, not a copy of it. A backtest filtering on a different set of
    // positions than the ingest measures a board nobody is served.
    if (
      !MODELLED_POSITIONS.includes(position as (typeof MODELLED_POSITIONS)[number])
    ) {
      continue;
    }

    const id = str(row, "player_id");
    if (id === "") continue;
    const points = num(row, "fantasy_points_ppr");

    if (!byPlayer.has(id)) {
      byPlayer.set(id, {
        id,
        name: str(row, "player_display_name") || str(row, "player_name"),
        position,
        perGamePoints: [],
        games: 0,
        total: 0,
      });
    }
    const player = byPlayer.get(id)!;
    player.games += 1;
    player.total += points;
    weekly.push({ id, week: num(row, "week"), points });
  }

  // Ordered by week so the EMA weights recent games last, matching the weekly model.
  weekly.sort((a, b) => a.week - b.week);
  for (const entry of weekly) byPlayer.get(entry.id)!.perGamePoints.push(entry.points);

  return byPlayer;
}

async function loadAdp(season: number) {
  const name = `adp_${SCORING_ID}_${LEAGUE_TEAMS}_${season}.json`;
  const raw = await cached(ADP_CACHE_DIR, name, adpUrl(SCORING_ID, LEAGUE_TEAMS, season));

  // Unparseable is the same problem as the error envelope below and needs the same
  // treatment, which it was not getting: `JSON.parse` threw before the cleanup could run,
  // so a truncated write — an interrupted run, a full disk — or an HTML error page poisoned
  // the cache permanently. Every later run read the same file and failed the same way, and
  // the only fix was to know to clear the directory by hand.
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    rmSync(join(ADP_CACHE_DIR, name), { force: true });
    throw new Error(
      `The cached ADP board for ${season} is not valid JSON. It has been deleted; run ` +
        `this again to download a fresh one.`,
    );
  }

  const entries = parseAdp(payload);
  if (entries === null) {
    // The error envelope arrives with HTTP 200, so `cached` has already written it to
    // disk. Left there it is served for every later run, and the failure becomes
    // permanent until somebody clears the directory by hand — a cached "no board" that
    // looks identical to genuinely having no board.
    rmSync(join(ADP_CACHE_DIR, name), { force: true });
    throw new Error(
      `No ADP published for ${season}. The backtest needs both a tuning and an ` +
        `evaluation season with a market board.`,
    );
  }
  return entries;
}

/**
 * Spearman rank correlation, with ties handled.
 *
 * Mid-ranks rather than sort positions, and Pearson on the ranks rather than the
 * `1 - 6·Σd²/(n(n²−1))` shortcut. The shortcut is only valid when nothing is tied, and ties
 * are reachable: `seasonProjection`, `adpImpliedPoints` and `blendedSeasonValue` all round
 * to two decimals, so two players routinely share a value. Ranking those by sort position
 * gave them different ranks decided by input order, which made the published figure depend
 * on the order rows came out of a CSV.
 *
 * With no ties the two forms agree exactly, so an unchanged number after this change is
 * evidence the data had none — not evidence the change did nothing.
 */
function spearman(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 3) return Number.NaN;

  const rank = (values: number[]): number[] => {
    const order = values
      .map((v, i) => [v, i] as const)
      .sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(n);
    let i = 0;
    while (i < order.length) {
      // Everything equal to `order[i]` shares the average of the positions they span.
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const midRank = (i + j) / 2;
      for (let k = i; k <= j; k += 1) ranks[order[k][1]] = midRank;
      i = j + 1;
    }
    return ranks;
  };

  const ra = rank(pairs.map((p) => p[0]));
  const rb = rank(pairs.map((p) => p[1]));
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / n;
  const ma = mean(ra);
  const mb = mean(rb);

  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = ra[i] - ma;
    const db = rb[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  // Zero variance means every value tied, so there is no ordering to correlate with.
  if (va === 0 || vb === 0) return Number.NaN;
  return cov / Math.sqrt(va * vb);
}

interface Universe {
  ids: string[];
  actual: Map<string, number>;
  model: Map<string, number>;
  market: Map<string, number>;
}

/**
 * Builds the evaluated universe for a season.
 *
 * Restricted to players the market had an opinion about, because those are the players a
 * draft is actually about. Scoring the model against the whole league would flatter it:
 * separating starters from practice-squad players is easy and nobody needs help with it.
 */
async function buildUniverse(target: number, curves: AdpCurveSet): Promise<Universe> {
  const [twoBack, oneBack, targetSeason] = await Promise.all([
    loadSeason(target - 2),
    loadSeason(target - 1),
    loadSeason(target),
  ]);
  const adp = await loadAdp(target);

  // The same index the curve fit uses, rather than the hand-rolled map this used to
  // carry. That version was not wrong — it skipped ambiguous names — but it was strictly
  // weaker: it dropped *both* players whenever two names normalised the same way, where
  // the index separates them when their positions differ and refuses only when position
  // cannot. Every player it dropped left the evaluated universe, so `sampleSize` in
  // published-draft-metrics.json was smaller than the same matching rule would give, and
  // the two halves of this one script measured on different join rules.
  const index = buildMarketIndex([...targetSeason.values()], normalizeMarketPosition);

  const ids: string[] = [];
  const actual = new Map<string, number>();
  const model = new Map<string, number>();
  const market = new Map<string, number>();

  for (const entry of adp) {
    const matched = index.find(entry.name, entry.position);
    if (matched === null) continue;
    const id = matched.id;
    // Two ADP rows can resolve to one roster player — `normalizeName` collapses
    // punctuation and generational suffixes, so "A.J. Brown" and "AJ Brown" both land
    // here. Pushed twice, the player is counted twice by `spearman` with identical ranks
    // on both sides, can contribute his points twice to one `topN` mean, and inflates the
    // `sampleSize` published as a distinct player count.
    if (actual.has(id)) continue;

    const history = [
      ...(twoBack.get(id)?.perGamePoints ?? []),
      ...(oneBack.get(id)?.perGamePoints ?? []),
    ];
    if (history.length === 0) continue;

    ids.push(id);
    actual.set(id, targetSeason.get(id)!.total);
    model.set(
      id,
      seasonProjection({
        perGamePoints: history,
        priorSeasonGames: oneBack.get(id)?.games ?? 0,
        alpha: SEASON_EMA_ALPHA,
      }),
    );
    const implied = adpImpliedPoints(entry.adp, entry.position, curves);
    if (implied === null) {
      ids.pop();
      actual.delete(id);
      model.delete(id);
      continue;
    }
    market.set(id, implied);
  }

  return { ids, actual, model, market };
}

/** The curve is always fitted on a season already played, never on the target. */
async function curveFor(season: number): Promise<AdpCurveSet> {
  const played = await loadSeason(season);
  const adp = await loadAdp(season);
  // Position-qualified, and ambiguous names refused. A plain name-keyed map takes the
  // last write, which injects one player's season points against another player's ADP —
  // straight into the curve the published blend figures are computed from.
  const index = buildMarketIndex([...played.values()], normalizeMarketPosition);

  // Deduplicated by roster player, the same guard `buildUniverse` carries and for the same
  // reason: `parseAdp` does not deduplicate by name and `normalizeName` collapses two
  // spellings of one player onto one roster id. There it cost one rank; here the duplicate
  // pair enters the least-squares fit twice and biases the slope and intercept of the
  // curve that prices *every* player on the board — and this runs for the tuning curve and
  // the evaluation curve both, so it reaches every figure in published-draft-metrics.json.
  const seen = new Set<string>();
  const samples = adp
    .map((entry) => {
      const player = index.find(entry.name, entry.position);
      if (player === null || seen.has(player.id)) return null;
      seen.add(player.id);
      return {
        adp: entry.adp,
        actualSeasonPoints: player.total,
        position: entry.position || player.position,
      };
    })
    .filter(
      (s): s is { adp: number; actualSeasonPoints: number; position: string } =>
        s !== null,
    );

  const curves = fitAdpCurves(samples, season);
  if (curves.pooled === null) throw new Error(`Could not fit an ADP curve on ${season}.`);
  return curves;
}

function score(universe: Universe, weight: number) {
  const blended = new Map(
    universe.ids.map((id) => [
      id,
      blendedSeasonValue(universe.model.get(id)!, universe.market.get(id)!, weight),
    ]),
  );
  return spearman(universe.ids.map((id) => [blended.get(id)!, universe.actual.get(id)!]));
}

function topN(universe: Universe, values: Map<string, number>, n: number): number {
  // Ties broken by id, so the figure does not depend on the order the ADP board happened to
  // arrive in. Ties are routine rather than exotic: `seasonProjection`, `adpImpliedPoints`
  // and `blendedSeasonValue` all round to two decimals, which is the same premise the
  // mid-rank correction in `spearman` rests on. One straddling the boundary at rank 24 or 48
  // changes the mean — and these means are published, so a number that moves with input
  // order is a number the document cannot stand behind.
  //
  // The id order is arbitrary; that is not the point. Reproducibility is.
  const ordered = [...universe.ids].sort(
    (a, b) => values.get(b)! - values.get(a)! || (a < b ? -1 : a > b ? 1 : 0),
  );
  const taken = ordered.slice(0, n);
  return taken.reduce((sum, id) => sum + universe.actual.get(id)!, 0) / taken.length;
}

async function main(): Promise<void> {
  process.stdout.write(
    `\nDraft valuation backtest\n` +
      `  tuning ${TUNING_SEASON}, evaluation ${EVALUATION_SEASON}, ` +
      `${SCORING_ID.toUpperCase()} / ${LEAGUE_TEAMS}-team\n`,
  );

  // --- Tune ------------------------------------------------------------------------
  const tuningCurve = await curveFor(TUNING_SEASON - 1);
  const tuning = await buildUniverse(TUNING_SEASON, tuningCurve);
  process.stdout.write(
    `\n${TUNING_SEASON} — TUNING (choose the weight here)   n = ${tuning.ids.length}\n` +
      `  ADP curves fitted on ${tuningCurve.season}: ` +
      `${Object.keys(tuningCurve.byPosition).join(", ")} (pooled fallback ` +
      `${tuningCurve.pooled?.sampleSize ?? 0} players)\n` +
      `  ${"blend weight".padEnd(16)}${"spearman".padStart(10)}\n`,
  );
  let chosen = MODEL_BLEND_WEIGHT;
  let bestScore = -Infinity;
  for (const weight of BLEND_WEIGHTS) {
    const value = score(tuning, weight);
    // The same rule the evaluation block applies, on the half that chooses the weight. A
    // NaN score never satisfies `value > bestScore`, so the sweep would silently keep the
    // default and print it as though it had been selected on the data.
    if (!Number.isFinite(value)) {
      throw new Error(
        `The tuning season scored ${value} at blend weight ${weight}, so no weight can ` +
          `be chosen from it. Check that the tuning season matched any players at all.`,
      );
    }
    const marker = value > bestScore ? " <-" : "";
    if (value > bestScore) {
      bestScore = value;
      chosen = weight;
    }
    process.stdout.write(
      `  ${String(weight).padEnd(16)}${value.toFixed(4).padStart(10)}${marker}\n`,
    );
  }
  process.stdout.write(`  best on the tuning season: ${chosen}\n`);

  if (chosen !== MODEL_BLEND_WEIGHT) {
    process.stdout.write(
      `\n  NOTE: the tuning season now prefers ${chosen}, but the frozen constant is ` +
        `${MODEL_BLEND_WEIGHT}.\n  The frozen value is what ships. Changing it means ` +
        `re-running this and updating docs/draft-validation.md in the same commit.\n`,
    );
  }

  // --- Evaluate --------------------------------------------------------------------
  const evalCurve = await curveFor(EVALUATION_SEASON - 1);
  const evaluation = await buildUniverse(EVALUATION_SEASON, evalCurve);

  const adpOnly = spearman(
    evaluation.ids.map((id) => [evaluation.market.get(id)!, evaluation.actual.get(id)!]),
  );
  const modelOnly = spearman(
    evaluation.ids.map((id) => [evaluation.model.get(id)!, evaluation.actual.get(id)!]),
  );
  const blended = score(evaluation, MODEL_BLEND_WEIGHT);

  const blendValues = new Map(
    evaluation.ids.map((id) => [
      id,
      blendedSeasonValue(
        evaluation.model.get(id)!,
        evaluation.market.get(id)!,
        MODEL_BLEND_WEIGHT,
      ),
    ]),
  );

  // A zero correlation for the market would make the edge infinite or NaN, and it would be
  // printed next to real figures as though it meant something. Guarding the division alone
  // still publishes the damage: a NaN edge prints as "NaN%" beside real figures and
  // `JSON.stringify` writes it into published-draft-metrics.json as `null`, so a documented
  // number becomes absent without anything saying so. A negative baseline is worse than
  // absent — it inverts the sign of `edge` relative to the `blended > adpOnly` branch,
  // letting the script announce that blending improves on the market next to a negative
  // percentage. Either way the evaluation universe is broken and there is no figure to
  // report. All three, not only the baseline.
  //
  // Before the table, not after it. The guard used to sit below the loop that prints the
  // three rows, so an empty universe printed a full table of `NaN` — with `topN` dividing
  // by an empty `taken` on the way — and only then threw. The protection this comment
  // describes did not cover the one thing it names.
  if (!(adpOnly > 0) || !Number.isFinite(modelOnly) || !Number.isFinite(blended)) {
    throw new Error(
      `Rank correlations came out at market ${adpOnly}, model ${modelOnly}, blend ` +
        `${blended}. Every published figure is relative to the market baseline and none ` +
        `of the three is reportable unless all are finite and the baseline is positive. ` +
        `Check that the evaluation season matched any players at all.`,
    );
  }

  process.stdout.write(
    `\n${EVALUATION_SEASON} — EVALUATION (weight frozen at ${MODEL_BLEND_WEIGHT}, ` +
      `out-of-sample)   n = ${evaluation.ids.length}\n` +
      `  ADP curves fitted on ${evalCurve.season}: ` +
      `${Object.keys(evalCurve.byPosition).join(", ")} (pooled fallback ` +
      `${evalCurve.pooled?.sampleSize ?? 0} players)\n` +
      `  ${"method".padEnd(16)}${"spearman".padStart(10)}${"top24".padStart(9)}` +
      `${"top48".padStart(9)}\n${"-".repeat(46)}\n`,
  );
  const rows: Array<[string, number, Map<string, number>]> = [
    ["market (ADP)", adpOnly, evaluation.market],
    ["our model", modelOnly, evaluation.model],
    ["blended", blended, blendValues],
  ];
  for (const [label, sp, values] of rows) {
    process.stdout.write(
      `  ${label.padEnd(16)}${sp.toFixed(4).padStart(10)}` +
        `${topN(evaluation, values, 24).toFixed(1).padStart(9)}` +
        `${topN(evaluation, values, 48).toFixed(1).padStart(9)}\n`,
    );
  }

  const edge = ((blended - adpOnly) / adpOnly) * 100;
  const top24 = {
    market: topN(evaluation, evaluation.market, 24),
    blended: topN(evaluation, blendValues, 24),
  };

  // Reported from the numbers rather than asserted. An earlier version of this script
  // printed "blending beats both" unconditionally and then rendered a negative
  // improvement next to it, which is precisely the kind of claim the honesty rule exists
  // to catch — and it was wrong.
  process.stdout.write(
    `\n  The market out-ranks our model on its own: ${adpOnly.toFixed(4)} vs ` +
      `${modelOnly.toFixed(4)}.\n`,
  );
  if (blended > adpOnly) {
    process.stdout.write(
      `  Blending improves on the market: ${blended.toFixed(4)}, ` +
        `${edge.toFixed(1)}% better.\n`,
    );
  } else {
    process.stdout.write(
      `  Blending does NOT improve on the market: ${blended.toFixed(4)} against ` +
        `${adpOnly.toFixed(4)}, ${edge.toFixed(1)}%.\n` +
        `  Rank correlation does not support a claim that our model adds value here.\n`,
    );
  }
  process.stdout.write(
    `  Top 24 by each method scored ${top24.blended.toFixed(1)} (blend) against ` +
      `${top24.market.toFixed(1)} (market).\n` +
      `  The two metrics disagree, and one evaluation season of ${evaluation.ids.length} ` +
      `players cannot settle it.\n` +
      `  No ranking edge over the market may be claimed in the interface.\n`,
  );

  const published: PublishedDraftMetrics = {
    tuningSeason: TUNING_SEASON,
    evaluationSeason: EVALUATION_SEASON,
    chosenBlendWeight: MODEL_BLEND_WEIGHT,
    sampleSize: evaluation.ids.length,
    spearman: { adpOnly, modelOnly, blended },
    topN: Object.fromEntries(
      [24, 48].map((n) => [
        String(n),
        {
          adpOnly: topN(evaluation, evaluation.market, n),
          modelOnly: topN(evaluation, evaluation.model, n),
          blended: topN(evaluation, blendValues, n),
        },
      ]),
    ),
    edgeOverMarketPercent: edge,
  };
  writeFileSync(PUBLISHED_PATH, `${JSON.stringify(published, null, 2)}\n`);
  process.stdout.write(
    `\n  wrote ${PUBLISHED_PATH.replace(`${process.cwd()}/`, "")}\n` +
      `  Update docs/draft-validation.md in the same commit as any change here.\n`,
  );
}

void main();
