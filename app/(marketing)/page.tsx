import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Landing page.
 *
 * Every claim here is backed by something checkable. The previous version led with
 * "+8.2 points/week vs platform projections", a number with no computation behind it and
 * one the measured model cannot support: the real edge over a strong baseline is 2.74%
 * (`docs/model-validation.md`). It has been removed rather than softened.
 *
 * What is left is what the product can actually defend: an optimal lineup is optimal by
 * construction, projections show their working, and the accuracy figure is published.
 */
export default function MarketingPage() {
  return (
    <main>
      <section className="mx-auto max-w-3xl px-6 pb-12 pt-20">
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          Fantasy decisions you can check.
        </h1>
        <p className="mt-5 text-pretty text-lg text-muted-foreground">
          Every projection breaks down into the numbers behind it. Every lineup is the
          highest-scoring arrangement your roster allows &mdash; not a good guess.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/projections">See this week&rsquo;s projections</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/lineup">Optimise a lineup</Link>
          </Button>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          No account needed. Projections and the lineup optimiser work straight away.
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-12">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <h2 className="font-medium">Provably optimal lineups</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Slot assignment is solved exactly, so no legal arrangement of your roster
              scores higher. Filling slots greedily &mdash; what simpler tools do &mdash;
              can leave real points on the bench.
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
            projections beat a prior-games-average baseline by <strong>2.74%</strong> in mean
            absolute error. That is a real edge and a small one, and anyone promising far
            more than that is guessing. Where this tool adds more is in the decisions built
            on top: exact lineup optimisation, and a floor and ceiling calibrated from how
            outcomes actually spread.
          </p>
        </div>
      </section>
    </main>
  );
}
