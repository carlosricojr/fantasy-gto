import Link from "next/link";
import { CURRENT_DRAFT_EVIDENCE, draftPromotionGate } from "@/lib/core/draft-promotion";

export function DraftEvidencePanel() {
  const gate = draftPromotionGate(CURRENT_DRAFT_EVIDENCE);
  return <section aria-label="Draft strategy evidence" className="mb-4 rounded-xl border bg-muted/30 p-4 text-sm">
    <h2 className="font-semibold">Draft strategy evidence</h2>
    <p className="mt-1 font-medium">{gate.status === "not-promoted" ? "Experimental · not promoted" : "Evidence gate met · promotion review required"}</p>
    <p className="mt-2 text-muted-foreground">Market-first is the simple FFC ADP comparator with roster-completion checks.
      The recommendation list still ranks by experimental simulation; it has not shown a reliable advantage over ADP or roster-needs ADP.</p>
    <Link href="/draft/evidence" className="mt-3 inline-block rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">
      Read the evaluation and promotion checklist
    </Link>
  </section>;
}
