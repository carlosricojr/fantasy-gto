import { cn } from "@/lib/utils";

/**
 * A placeholder for content that has not arrived.
 *
 * One component rather than a class string repeated at each site, because the class string
 * was repeated at each site and three of them lost the `motion-safe:` on the way: the
 * lineup's player names, the projection card's, and the entitlement gate's pulsed for
 * somebody who had asked the operating system for less motion, in an app whose every other
 * piece of animation checks. `lib/motion.test.ts` keeps `animate-pulse` inside this file.
 *
 * A `span` with `block`, not a `div`, so a caller can override `display` to `inline-block`
 * and drop one into a sentence — `cn` resolves the conflict in the caller's favour. It is
 * `aria-hidden` for the same reason every skeleton here is: it is the shape of content, not
 * content, and the surface it stands in for announces its own loading state.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("block motion-safe:animate-pulse rounded-md bg-muted", className)}
    />
  );
}
