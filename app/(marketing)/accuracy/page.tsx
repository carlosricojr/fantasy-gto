import type { Metadata } from "next";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import metrics from "@/lib/nfl/model/published-metrics.json";

export const metadata: Metadata = {
  title: "How accurate is this? — Fantasy GTO",
  description:
    "The graded scorecard for our projections: how close we get, where we miss, and what actually moved the needle.",
};

const REPO = "https://github.com/carlosricojr/fantasy-gto";
const VALIDATION_DOC = `${REPO}/blob/main/docs/model-validation.md`;

/**
 * The published accuracy page.
 *
 * Every measured figure here is imported from `published-metrics.json`, which the backtest
 * script writes, so a model change cannot leave the page asserting something no longer
 * true. An earlier version transcribed the numbers by hand, which is the same failure mode
 * as a constant marked "measured" with nothing producing it.
 *
 * The comparative claims are derived rather than written down, for the same reason the
 * numbers are: the leaderboard sorts by measured error, the headline quotes whichever
 * baseline actually scored better, the "we win by" wording follows the sign of the edge,
 * and the bias direction and worst position come from the metrics. Finishing first is a
 * result, not a fact the page is entitled to assert. Some of those invariants are also
 * held by `published-metrics.test.ts`, but the per-position ordering is not, so a future
 * backtest could have made the old hard-coded "Quarterbacks are our worst position" false
 * with every test still green.
 *
 * The headline edge is shown with its confidence interval rather than alone. A point
 * estimate quietly invites the reader to believe every digit of it, and this one is far
 * less precise than two decimal places suggest. The interval is measured against the
 * full-history average specifically, so it is rendered only when that is the baseline being
 * quoted; attaching it to the other comparison would be pairing a number with an
 * uncertainty computed for something else.
 *
 * The paragraph about the same players recurring is there because the alternative is worse
 * than omitting it. Anyone who divides the spread of weekly errors by the square root of
 * the sample gets a visibly tighter interval than the one on this page and concludes we
 * padded it. The reason it is wider is the clustering, and saying so is cheaper than being
 * disbelieved.
 *
 * The one number still written literally is the "around 12" typical weekly score used to
 * give the error a sense of scale. It is deliberately rounded and illustrative rather than
 * a measurement, it is not a claim about the model, and it appears in
 * `docs/model-validation.md` — which is the rule: a number absent from that document may
 * not appear in the interface. The nearby sentence therefore claims provenance only for
 * the *measured* figures, since this one is not read from the artifact.
 *
 * Two claims were removed rather than reworded. A "0 peeks at the held-out season" stat
 * asserted more than the record supports: hyperparameters were chosen on the tuning season
 * and frozen, which is the defensible claim, but the validation document also records the
 * held-out season being re-measured after a leakage fix and after the calibration factors
 * were synced. And "the toughest baseline we could throw at it" implied an exhausted field
 * when two baselines were tried — the same overreach as the withdrawn ESPN comparison, in
 * softer clothing.
 *
 * The voice is deliberately plain and a little dry — this is a consumer product, not a
 * paper — but no caveat was dropped to get there. The weaknesses section, the residual
 * bias, the in-sample label on the calibration figure, and the reason we quote the smaller
 * of the two edges are all still on the page. This page exists because the product once
 * asserted it beat ESPN by 8% with nothing behind the claim; publishing the real, smaller
 * number is the correction, and making it readable is not the same as softening it.
 *
 * No shell commands appear in the copy. "Clone the repo and run the backtest" is a
 * developer instruction on a page whose audience is people setting a lineup; the links to
 * the public repository and the validation document do that job for both readers.
 */
const POSITION_NAMES = {
  QB: "Quarterbacks",
  RB: "Running backs",
  WR: "Wide receivers",
  TE: "Tight ends",
} as const;

export default function AccuracyPage() {
  const positions = (Object.keys(POSITION_NAMES) as (keyof typeof POSITION_NAMES)[])
    .map((position) => ({ position, mae: metrics.perPositionMae[position] }))
    .sort((a, b) => b.mae - a.mae);
  const hardestPosition = positions[0];

  // Named for what it actually is. docs/model-validation.md is explicit that this baseline
  // averages every prior game in the loaded history — up to three seasons — and warns that
  // a season-to-date mean would be a weaker opponent that inflates our edge. Calling it a
  // "season average" would have described exactly that weaker thing.
  const priorGames = {
    name: "Full-history average",
    blurb: "Every prior game we have for that player, averaged",
    mae: metrics.priorGamesMeanMae,
    edge: metrics.edgeVsPriorGamesMean,
  };
  const lastThree = {
    name: "Last three games",
    blurb: "The hot-hand rule of thumb",
    mae: metrics.lastThreeMae,
    edge: metrics.edgeVsLastThree,
  };

  // The baseline that beat the other one is the one worth quoting against. Choosing it by
  // measured error is what stops the headline drifting onto the flattering comparison.
  const toughest = priorGames.mae <= lastThree.mae ? priorGames : lastThree;
  const weakest = toughest === priorGames ? lastThree : priorGames;

  // The interval is measured against the full-history average, so it may only be shown
  // next to that comparison. `toughest` is chosen by measured error and could in principle
  // land on the other baseline; if it ever did, quoting this interval beside it would be
  // attaching an uncertainty to a number it was not computed for.
  const [intervalLow, intervalHigh] = metrics.significance.percentConfidenceInterval;
  const intervalApplies = toughest === priorGames;
  // Read off the interval rather than written down. "It does not include zero, so the edge
  // is real" is a conclusion, not a fact the page is entitled to assert — the same reason
  // the leaderboard sorts by measured error and the "we win by" wording follows the sign.
  // An interval that straddled zero would otherwise leave the page insisting the edge was
  // real while printing the numbers that say it might not be.
  const intervalExcludesZero = intervalLow > 0;

  // Ranked by measured error rather than by assumption. Finishing first is what the
  // backtest says today, not something the page is entitled to assert — if a future run
  // puts a baseline ahead of us, this renders that instead of still claiming the win.
  const methods = [
    {
      name: "Fantasy GTO",
      blurb: `Us, with the ${metrics.calibration.season} settings frozen`,
      mae: metrics.modelMae,
      edge: null as number | null,
    },
    priorGames,
    lastThree,
  ].sort((a, b) => a.mae - b.mae);

  const projectsHigh = metrics.bias < 0;

  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem]"
        style={{
          background:
            "radial-gradient(70% 80% at 15% 0%, color-mix(in oklch, var(--brand) 16%, transparent), transparent 70%)",
        }}
      />

      <section className="relative mx-auto max-w-4xl px-6 pb-12 pt-16 sm:pt-20">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-brand">
          The receipts
        </p>
        <h1 className="mt-4 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          How good is this, really?
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-lg text-muted-foreground">
          We replayed the {metrics.season} season one week at a time, using only what was
          knowable before kickoff, and graded every projection against what actually
          happened. Here is the scorecard &mdash; including the parts we would rather not
          show you.
        </p>

        <dl className="mt-10 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
          {/* `dt` before `dd` in the DOM because that is the content model a screen reader
              pairs on; `flex-col-reverse` puts the figure back on top visually. */}
          <div className="flex flex-col-reverse justify-end bg-background p-5">
            <dt className="mt-1 text-sm text-muted-foreground">
              {toughest.edge >= 0 ? "sharper than" : "behind"} the stronger of the two
              baselines we tried
              {intervalApplies && (
                <>
                  , somewhere between{" "}
                  <span className="tabular-nums">{intervalLow.toFixed(2)}%</span> and{" "}
                  <span className="tabular-nums">{intervalHigh.toFixed(2)}%</span>
                </>
              )}
            </dt>
            <dd className="text-3xl font-semibold tracking-tight tabular-nums text-brand">
              {toughest.edge.toFixed(2)}%
            </dd>
          </div>
          <div className="flex flex-col-reverse justify-end bg-background p-5">
            <dt className="mt-1 text-sm text-muted-foreground">
              player-weeks graded, every one of them held out
            </dt>
            <dd className="text-3xl font-semibold tracking-tight tabular-nums">
              {metrics.sampleSize.toLocaleString("en-US")}
            </dd>
          </div>
          <div className="flex flex-col-reverse justify-end bg-background p-5">
            <dt className="mt-1 text-sm text-muted-foreground">
              the season the settings were chosen on, and frozen before {metrics.season}{" "}
              was scored
            </dt>
            <dd className="text-3xl font-semibold tracking-tight tabular-nums">
              {metrics.calibration.season}
            </dd>
          </div>
        </dl>
      </section>

      <section className="relative mx-auto max-w-4xl px-6 py-10">
        <h2 className="text-2xl font-semibold tracking-tight">Head to head</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          How many fantasy points each method missed by, per player, per week. Lower wins.
        </p>

        {/* `overflow-hidden` because the tinted first row is a descendant background, and
            the card's radius does not clip those — square corners would show through. */}
        <ol className="mt-6 divide-y overflow-hidden rounded-xl border">
          {methods.map((method, index) => {
            const ours = method.edge === null;
            return (
              <li
                key={method.name}
                className={`flex items-baseline gap-4 p-5 ${ours ? "bg-brand/5" : ""}`}
              >
                <span
                  className={`font-mono text-sm ${ours ? "text-brand" : "text-muted-foreground"}`}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{method.name}</p>
                  <p className="text-sm text-muted-foreground">{method.blurb}</p>
                </div>
                <p
                  className={`text-right text-2xl font-semibold tabular-nums ${ours ? "text-brand" : ""}`}
                >
                  {method.mae.toFixed(2)}
                  {method.edge !== null && (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {method.edge >= 0
                        ? `we win by ${method.edge.toFixed(2)}%`
                        : `it beats us by ${Math.abs(method.edge).toFixed(2)}%`}
                    </span>
                  )}
                </p>
              </li>
            );
          })}
        </ol>

        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          The number we quote is{" "}
          <strong className="text-foreground">{toughest.edge.toFixed(2)}%</strong>, because
          the {toughest.name.toLowerCase()} is the harder opponent. The{" "}
          {weakest.edge.toFixed(2)}% is real too, but leading with it would be picking the
          easier matchup and calling it a win.
        </p>

        {intervalApplies && (
          <div className="mt-6 rounded-xl border border-dashed p-5">
            <h3 className="font-medium">How sure are we about that number?</h3>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Reasonably, and not more than that. The range we can actually defend is{" "}
              <strong className="tabular-nums text-foreground">
                {intervalLow.toFixed(2)}%
              </strong>{" "}
              to{" "}
              <strong className="tabular-nums text-foreground">
                {intervalHigh.toFixed(2)}%
              </strong>{" "}
              &mdash; an interval built this way covers the true edge nineteen times out of
              twenty.{" "}
              {intervalExcludesZero
                ? "It does not include zero, so the edge is real rather than luck"
                : "It includes zero, so we cannot rule out that this edge is luck"}{" "}
              &mdash; and &ldquo;{toughest.edge.toFixed(2)}%&rdquo; on its own is more
              precision than {metrics.sampleSize.toLocaleString("en-US")} player-weeks can
              support.
            </p>
            <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
              That range is wider than the obvious arithmetic gives, on purpose. The same{" "}
              {metrics.significance.clusters} players account for all{" "}
              {metrics.sampleSize.toLocaleString("en-US")} of those weeks, and a player we
              consistently misread produces the same miss over and over rather than
              seventeen independent verdicts on the model. Treating every week as fresh
              evidence would have made this interval look{" "}
              {(
                (1 -
                  metrics.significance.iidStandardError /
                    metrics.significance.clusteredStandardError) *
                100
              ).toFixed(0)}
              % tighter than it has any right to be.
            </p>
          </div>
        )}
      </section>

      <section className="relative mx-auto max-w-4xl px-6 py-10">
        <h2 className="text-2xl font-semibold tracking-tight">Where we miss</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border p-5">
            <h3 className="font-medium">Most of a week is noise</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              We are off by about {metrics.modelMae.toFixed(1)} points on a player who
              typically scores around 12. Weekly fantasy is mostly variance, and no model
              built on public box scores makes that disappear. Anyone promising certainty
              is selling you something.
            </p>
          </div>
          <div className="rounded-xl border p-5">
            <h3 className="font-medium">
              We run a little {projectsHigh ? "hot" : "cold"}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Even after calibration we project about {Math.abs(metrics.bias).toFixed(2)}{" "}
              points {projectsHigh ? "high" : "low"} (residual bias{" "}
              {metrics.bias.toFixed(2).replace("-", "−")}). Players earn their way into the
              sample by producing recently, then regress. It is why you get a range rather
              than one confident number.
            </p>
          </div>
          <div className="rounded-xl border p-5">
            <h3 className="font-medium">
              {POSITION_NAMES[hardestPosition.position]} are our worst position
            </h3>
            <ul className="mt-3 space-y-1.5 text-sm">
              {positions.map(({ position, mae }) => (
                <li key={position} className="flex items-baseline justify-between gap-3">
                  <span className="text-muted-foreground">{position}</span>
                  <span className="tabular-nums">{mae.toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Average miss by position, hardest first.
            </p>
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-4xl px-6 py-10">
        <h2 className="text-2xl font-semibold tracking-tight">
          What actually moved the needle
        </h2>
        {/* Unordered on purpose: these are not ranked, and the last one is the largest
            contributor, so an `ol` would have a screen reader announce it as "3 of 3". */}
        <ul className="mt-6 space-y-6">
          <li className="border-l-2 border-brand/40 pl-5">
            <h3 className="font-medium">Long memory beat the hot hand</h3>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              A last-three-games average is clearly worse than a player&rsquo;s full
              history. Weighting recent form heavily throws away more signal than it finds
              &mdash; which is the opposite of how most people set a lineup.
            </p>
          </li>
          <li className="border-l-2 border-brand/40 pl-5">
            <h3 className="font-medium">
              Vegas helps, but only against a team&rsquo;s own normal
            </h3>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              Scaling a projection by the game&rsquo;s implied total against the league
              average is worth almost nothing, and turns harmful once you lean on it: a
              player on a strong offense already carries that strength in their scoring
              history, so applying it again double-counts. Measured against the
              team&rsquo;s own recent games there is a clear sweet spot. Only weeks already
              played feed it, so nothing after kickoff sneaks in.
            </p>
          </li>
          <li className="border-l-2 border-brand/40 pl-5">
            <h3 className="font-medium">Correcting our own bias</h3>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              Fixing the measured tendency to over-project improved error from{" "}
              {metrics.calibration.offMae.toFixed(2)} to{" "}
              {metrics.calibration.onMae.toFixed(2)} on the {metrics.calibration.season}{" "}
              tuning season. That figure is in-sample, since {metrics.calibration.season}{" "}
              is the season the correction is derived from. It still did more than the
              usage, betting-line, and matchup terms put together.
            </p>
          </li>
        </ul>
      </section>

      <section className="relative mx-auto max-w-4xl px-6 pb-20 pt-10">
        <div className="rounded-xl border bg-brand/5 p-6 sm:p-8">
          <h2 className="text-xl font-semibold tracking-tight">Check our homework</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            The backtest is an open script run against free public data. Every measured
            figure on this page is read straight out of what it writes, and our tests fail
            if they drift from the validation document. Any change to the model has to
            update both in the same commit.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href="/lineup">Go set a lineup</Link>
            </Button>
            <Button asChild variant="outline">
              <a href={VALIDATION_DOC} target="_blank" rel="noopener noreferrer">
                Read the full validation
              </a>
            </Button>
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Browse the code
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
