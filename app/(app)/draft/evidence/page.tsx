import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { CURRENT_DRAFT_EVIDENCE, draftPromotionGate } from "@/lib/core/draft-promotion";

export default function DraftEvidencePage() {
  const gate = draftPromotionGate(CURRENT_DRAFT_EVIDENCE);
  return <PageShell title="Draft strategy evidence" subtitle="September 9, 2026 · descriptive diagnostic, not a proven drafting edge">
    <div className="space-y-6 text-sm leading-relaxed">
      <Link href="/draft" className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">Back to draft</Link>
      <section aria-labelledby="draft-status">
        <h2 id="draft-status" className="text-lg font-semibold">{gate.status === "not-promoted" ? "Experimental · not promoted" : "Evidence gate met · promotion review required"}</h2>
        <p className="mt-2">The market-first card shows the earliest FantasyFootballCalculator ADP allowed by the current roster-completion guard.
          It is a transparent comparator, not a guaranteed best pick or a Sleeper-market price.
          The recommendation list still uses the existing simulation ranking. This evidence page changes neither policy nor ranking.</p>
      </section>
      <section aria-labelledby="draft-measured">
        <h2 id="draft-measured" className="text-lg font-semibold">What was actually tested</h2>
        <p className="mt-2">A frozen keeper-draft case and two seats on a reconstructed 2024 board were reused across opponent assumptions.
          Guarded ADP, roster-needs ADP, the greedy policy and rollout were compared. Simulation evaluation draws differed from selection draws,
          but those were not independent leagues or untouched historical validation.</p>
        <p className="mt-2">The rollout did not consistently beat both simple baselines, even inside its simulator. External 2024 season scoring sometimes
          reversed the simulated ordering. That season was already used in development; the reserved 2025 outcomes were not evaluated.</p>
        <p className="mt-2">All advised rosters filled their required starters. Needs-ADP and noisy-ADP opponents also finished legally;
          raw strict-ADP opponents sometimes did not and were excluded from quality claims. Historical cases omit K/DST,
          use FFC rather than verified Sleeper prices, and use fixed preseason lineups without injury-aware repairs or waivers.</p>
      </section>
      <section aria-labelledby="draft-cost">
        <h2 id="draft-cost" className="text-lg font-semibold">What the extra computation costs</h2>
        <p className="mt-2">The first recommendation took 6.27 seconds on an Apple M4 Max with Node 24.18.0 for 600 scenarios and ten candidates,
          excluding module startup. Full rollout draft replays took about 31–52 seconds; simple strategies took at most 0.11 seconds.
          These are local diagnostic timings, not browser/mobile measurements or a draft-clock guarantee.</p>
      </section>
      <section aria-labelledby="draft-gate">
        <h2 id="draft-gate" className="text-lg font-semibold">What would earn a promotion review</h2>
        <p className="mt-2">No qualifying independent promotion study is registered in the current evidence manifest.
          The checklist below concerns promotion evidence, not whether the descriptive diagnostic ran successfully.</p>
        <ul className="mt-3 space-y-2">
          {gate.checks.map(check => <li key={check.id} className="flex items-start gap-2">
            <span className="shrink-0 font-medium">{check.passed ? "Met:" : "Needed:"}</span><span>{check.label}</span>
          </li>)}
        </ul>
        <p className="mt-3 text-muted-foreground">Gate version: {gate.version}. Thresholds must be registered before outcomes are inspected;
          no thresholds are chosen from the results above. Passing these manifest checks only earns a separate review of the linked evidence,
          its authenticity and scope. It does not automatically promote a strategy or establish calibrated title probabilities.</p>
      </section>
      <p className="text-muted-foreground">The full protocol and measured tables are in the repository document <code>docs/draft-strategy-evaluation.md</code>.
        The in-app summary intentionally contains no private league identifiers or player-roster dump.</p>
    </div>
  </PageShell>;
}
