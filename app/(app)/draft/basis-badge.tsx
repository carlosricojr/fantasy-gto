"use client";

import { basisBadge, basisExplanation, type ValueBasis } from "@/lib/nfl/draft/provenance";

/**
 * The one-word warning that a row's number did not come from the model.
 *
 * Rendered beside the player rather than in a caveat elsewhere on the page. A general note
 * about kickers is true and is also two screens away from the kicker being compared with a
 * running back, and the number is what needs the qualification.
 *
 * `title` carries the sentence for a pointer, and it is also the accessible name, so a
 * screen reader gets the explanation rather than the two words.
 */
export function BasisBadge({ basis }: { basis: ValueBasis }) {
  const badge = basisBadge(basis);
  if (badge === null) return null;
  return (
    <span
      className="ml-1 shrink-0 rounded border px-1 py-px text-[10px] tracking-wide text-muted-foreground uppercase"
      title={basisExplanation(basis)}
      aria-label={basisExplanation(basis)}
    >
      {badge}
    </span>
  );
}
