import { cn } from "@/lib/utils";

/**
 * A placeholder for content that has not arrived.
 *
 * One component rather than a class string repeated at each site, because the class string
 * was repeated at each site and three of them lost the `motion-safe:` on the way: the
 * lineup's player names, the projection card's, and the entitlement gate's pulsed for
 * somebody who had asked the operating system for less motion, in an app whose every other
 * piece of animation checks.
 *
 * `lib/motion.test.ts` enforces the `motion-safe:`, wherever a pulse is written. It does
 * *not* require pulses to be written here — the draft board's two panels still compose
 * their own, and that is allowed. This exists so the common case is one import rather than
 * a class string to copy, not as a boundary.
 *
 * `children` are rendered invisible, so a placeholder can be exactly the width of the text
 * it replaces rather than a guess: `<Skeleton className="h-8 px-3">{label}</Skeleton>` next
 * to a `size="sm"` button gives a chip that wraps where the real one wraps. Guessed widths
 * are how the lineup's control row came to be 150px wider than the row it stood for.
 *
 * A `span` with `block`, not a `div`, so a caller can override `display` to `inline-block`
 * and drop one into a sentence — `cn` resolves the conflict in the caller's favour. It is
 * `aria-hidden` for the same reason every skeleton here is: it is the shape of content, not
 * content, and the surface it stands in for announces its own loading state.
 */
export function Skeleton({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "block motion-safe:animate-pulse rounded-md bg-muted",
        children !== undefined && "inline-flex items-center justify-center",
        className,
      )}
    >
      {children === undefined ? null : <span className="invisible">{children}</span>}
    </span>
  );
}
