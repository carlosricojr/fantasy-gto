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
 * The one number still written literally is the "around 12" typical weekly score used to
 * give the error a sense of scale. It is deliberately rounded and illustrative rather than
 * a measurement, and it is not a claim about the model.
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
export default function AccuracyPage() {
  const positions = (["QB", "RB", "WR", "TE"] as const)
    .map((position) => ({ position, mae: metrics.perPositionMae[position] }))
    .sort((a, b) => b.mae - a.mae);

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
          <div className="bg-background p-5">
            <dd className="text-3xl font-semibold tracking-tight tabular-nums text-brand">
              {metrics.edgeVsPriorGamesMean.toFixed(2)}%
            </dd>
            <dt className="mt-1 text-sm text-muted-foreground">
              sharper than the toughest baseline we could throw at it
            </dt>
          </div>
          <div className="bg-background p-5">
            <dd className="text-3xl font-semibold tracking-tight tabular-nums">
              {metrics.sampleSize.toLocaleString("en-US")}
            </dd>
            <dt className="mt-1 text-sm text-muted-foreground">
              player-weeks graded, every one of them held out
            </dt>
          </div>
          <div className="bg-background p-5">
            <dd className="text-3xl font-semibold tracking-tight tabular-nums">0</dd>
            <dt className="mt-1 text-sm text-muted-foreground">
              peeks at {metrics.season} while we tuned. Everything was frozen on{" "}
              {metrics.calibration.season} first
            </dt>
          </div>
        </dl>
      </section>

      <section className="relative mx-auto max-w-4xl px-6 py-10">
        <h2 className="text-2xl font-semibold tracking-tight">Head to head</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          How many fantasy points each method missed by, per player, per week. Lower wins.
        </p>

        <ol className="mt-6 divide-y rounded-xl border">
          <li className="flex items-baseline gap-4 bg-brand/5 p-5">
            <span className="font-mono text-sm text-brand">1</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">Fantasy GTO</p>
              <p className="text-sm text-muted-foreground">
                Us, on a season we had never touched
              </p>
            </div>
            <p className="text-2xl font-semibold tabular-nums text-brand">
              {metrics.modelMae.toFixed(2)}
            </p>
          </li>
          <li className="flex items-baseline gap-4 p-5">
            <span className="font-mono text-sm text-muted-foreground">2</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">Season average</p>
              <p className="text-sm text-muted-foreground">
                Every game a player has played, averaged
              </p>
            </div>
            <p className="text-right text-2xl font-semibold tabular-nums">
              {metrics.priorGamesMeanMae.toFixed(2)}
              <span className="block text-xs font-normal text-muted-foreground">
                we win by {metrics.edgeVsPriorGamesMean.toFixed(2)}%
              </span>
            </p>
          </li>
          <li className="flex items-baseline gap-4 p-5">
            <span className="font-mono text-sm text-muted-foreground">3</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">Last three games</p>
              <p className="text-sm text-muted-foreground">The hot-hand rule of thumb</p>
            </div>
            <p className="text-right text-2xl font-semibold tabular-nums">
              {metrics.lastThreeMae.toFixed(2)}
              <span className="block text-xs font-normal text-muted-foreground">
                we win by {metrics.edgeVsLastThree.toFixed(2)}%
              </span>
            </p>
          </li>
        </ol>

        <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
          The number we quote is{" "}
          <strong className="text-foreground">
            {metrics.edgeVsPriorGamesMean.toFixed(2)}%
          </strong>
          , because the season average is the harder opponent. The{" "}
          {metrics.edgeVsLastThree.toFixed(2)}% is real too, but leading with it would be
          picking the easier matchup and calling it a win.
        </p>
      </section>

      <section className="relative mx-auto max-w-4xl px-6 py-10">
        <h2 className="text-2xl font-semibold tracking-tight">Where we miss</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border p-5">
            <h3 className="font-medium">Half of any week is noise</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              We are off by about {metrics.modelMae.toFixed(1)} points on a player who
              typically scores around 12. Weekly fantasy is mostly variance, and no model
              built on public box scores makes that disappear. Anyone promising certainty
              is selling you something.
            </p>
          </div>
          <div className="rounded-xl border p-5">
            <h3 className="font-medium">We run a little hot</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Even after calibration we project about {Math.abs(metrics.bias).toFixed(2)}{" "}
              points high (residual bias {metrics.bias.toFixed(2).replace("-", "−")}).
              Players earn their way into the sample by producing recently, then regress.
              It is why you get a range rather than one confident number.
            </p>
          </div>
          <div className="rounded-xl border p-5">
            <h3 className="font-medium">Quarterbacks are our worst position</h3>
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
        <ol className="mt-6 space-y-6">
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
        </ol>
      </section>

      <section className="relative mx-auto max-w-4xl px-6 pb-20 pt-10">
        <div className="rounded-xl border bg-brand/5 p-6 sm:p-8">
          <h2 className="text-xl font-semibold tracking-tight">Check our homework</h2>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            The backtest is an open script run against free public data. The figures on
            this page are read straight out of what it writes, and our tests fail if they
            drift from the validation document. Any change to the model has to update both
            in the same commit.
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
