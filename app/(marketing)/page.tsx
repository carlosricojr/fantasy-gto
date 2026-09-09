import Link from "next/link";

import { Button } from "@/components/ui/button";
import metrics from "@/lib/nfl/model/published-metrics.json";

/**
 * Landing page.
 *
 * Every claim here is backed by something checkable. The previous version led with
 * "+8.2 points/week vs platform projections", a number with no computation behind it and
 * one the measured model cannot support. It has been removed rather than softened. The
 * real figure is imported from `published-metrics.json`, which `pnpm backtest -- --holdout`
 * writes, so this page cannot drift out of step with what was actually measured.
 *
 * Exact assignment applies to supplied projected points under the same constraints;
 * it is not a guarantee about realized scores. Accuracy figures remain published.
 */
export default function MarketingPage() {
  return (
    <main>
      <section className="mx-auto max-w-3xl px-6 pb-12 pt-20">
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Fantasy decisions you can check.
        </h1>
        <p className="mt-5 text-pretty text-lg text-muted-foreground">
          See the evidence behind your estimates. Find the highest included projected-point
          total your roster allows, with missing data and lineup constraints made explicit.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/projections">See this week&rsquo;s projections</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/lineup">Optimize a lineup</Link>
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Projections and the lineup optimizer are free. Sign in to load data.
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-12">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <h2 className="font-medium">Exact lineup assignment</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Given the same supplied projections, eligibility, locks and exclusions,
              slot assignment maximizes the included projected-point total. It does not
              guarantee the highest actual score.
            </p>
          </div>
          <div>
            <h2 className="font-medium">Projections that show their working</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Recent production, usage trend, game environment, and matchup are listed as
              separate numbers that add up to the projection. Nothing is hidden in a black
              box.
            </p>
          </div>
          <div>
            <h2 className="font-medium">Accuracy we publish</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The model is backtested on a held-out season and the result is written down,
              including where it is weak. See{" "}
              <Link href="/accuracy" className="underline underline-offset-4">
                the numbers
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-12">
        <div className="rounded-lg border p-6">
          <h2 className="font-medium">What we don&rsquo;t claim</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Weekly fantasy scoring is mostly variance. Measured on a held-out season, these
            projections beat a prior-games-average baseline by{" "}
            <strong>{metrics.edgeVsPriorGamesMean.toFixed(2)}%</strong> in mean
            absolute error. That is a real edge and a small one, and anyone promising far
            more than that is guessing. Where this tool adds more is in the decisions built
            on top: exact lineup optimization, and a floor and ceiling calibrated from how
            outcomes actually spread.
          </p>
        </div>
      </section>
    </main>
  );
}
