import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Accuracy — Fantasy GTO",
  description:
    "How the projection model is measured, what it achieves, and where it is weak.",
};

/**
 * The published accuracy page.
 *
 * Every figure here comes from `pnpm backtest`, which is checked into the repository and
 * reproducible. The numbers are duplicated from `docs/model-validation.md`, and the two
 * must be updated together with any model change.
 *
 * This page exists because the product previously asserted it beat ESPN by 8% with nothing
 * behind the claim. Publishing the real, smaller number — including the residual bias —
 * is the correction.
 */
export default function AccuracyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Accuracy</h1>
      <p className="mt-4 text-muted-foreground">
        These figures come from a backtest that replays historical weeks using only
        information available before kickoff. Hyperparameters were chosen on the 2024
        season, then frozen and evaluated once on 2025, so the 2025 result is genuinely
        out-of-sample.
      </p>

      <section className="mt-10">
        <h2 className="text-lg font-medium">2025, held out — 3,037 player-weeks</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 font-medium">Model</th>
                <th className="py-2 text-right font-medium">Mean absolute error</th>
                <th className="py-2 text-right font-medium">Our edge</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="py-2 font-medium">Fantasy GTO</td>
                <td className="py-2 text-right tabular-nums">5.8236</td>
                <td className="py-2 text-right text-muted-foreground">&mdash;</td>
              </tr>
              <tr>
                <td className="py-2">Baseline: mean of all prior games</td>
                <td className="py-2 text-right tabular-nums">5.9877</td>
                <td className="py-2 text-right tabular-nums">+2.74%</td>
              </tr>
              <tr>
                <td className="py-2">Baseline: last three games</td>
                <td className="py-2 text-right tabular-nums">6.3618</td>
                <td className="py-2 text-right tabular-nums">+8.46%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          The number worth quoting is <strong>2.74%</strong>, against the stronger of the
          two baselines. The 8.46% figure is real but comparing only against the weaker
          baseline would be cherry-picking.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Where it is weak</h2>
        <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">The edge is small.</strong> A mean absolute
            error near 5.9 points against a typical score around 12 means error is roughly
            half the signal. Weekly fantasy scoring is dominated by variance that no model
            built on public box-score data removes.
          </li>
          <li>
            <strong className="text-foreground">It still projects slightly high.</strong>{" "}
            Residual bias is −0.57 points even after calibration, because players are
            selected into the evaluation by recent production and then regress. This is why
            a range is shown rather than a single number.
          </li>
          <li>
            <strong className="text-foreground">Quarterbacks are hardest.</strong> Position
            error runs 6.74 for QB, 5.80 RB, 5.66 WR, 5.24 TE.
          </li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">What actually helped</h2>
        <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Long memory, not recency.</strong> A
            last-three-games average is clearly worse than the average of every prior game
            a player has. Weighting recent form heavily discards more signal than it
            captures.
          </li>
          <li>
            <strong className="text-foreground">
              Betting lines, but measured against the team&rsquo;s own norm.
            </strong>{" "}
            Scaling by a game&rsquo;s implied total against the league average is worth
            almost nothing and turns harmful as it is weighted up — a player on a strong
            offence already carries that strength in their scoring history, so applying it
            again double-counts. Measured against the team&rsquo;s own recent games it has a
            clear optimum. The baseline uses only weeks already played, so nothing after
            kickoff informs it.
          </li>
          <li>
            <strong className="text-foreground">Calibration.</strong> Correcting the
            measured tendency to over-project improved error from 5.8821 to 5.8346 on the
            tuning season. It contributes more than the usage, betting-line, and matchup
            terms combined.
          </li>
        </ul>
      </section>

      <section className="mt-10 rounded-lg border p-6">
        <h2 className="font-medium">Reproduce it</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The backtest is a checked-in script run against public data. Clone the repository
          and run <code className="rounded bg-muted px-1.5 py-0.5">pnpm backtest</code>. Any
          change to the model must update these figures in the same commit.
        </p>
      </section>
    </main>
  );
}
