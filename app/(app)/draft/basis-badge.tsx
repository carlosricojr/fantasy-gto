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
  // The explanation is real text rather than an `aria-label`. A `<span>` has an implicit
  // role of `generic`, which prohibits naming — so the label was dropped by the very
  // technology it was written for, and a screen reader read the two-word abbreviation with
  // no way to find out what it meant. `title` still carries it for a pointer.
  return (
    <span
      className="ml-1 shrink-0 rounded border px-1 py-px text-[10px] tracking-wide text-muted-foreground uppercase"
      title={basisExplanation(basis)}
    >
      <span aria-hidden>{badge}</span>
      <span className="sr-only">{basisExplanation(basis)}</span>
    </span>
  );
}
