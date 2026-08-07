import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sourceFiles, stripComments } from "./source-scan";

/**
 * Two rules about motion, both of which had already been broken by hand.
 *
 * **Every pulse asks first.** `motion-safe:` is the guard, and it is on twelve of the
 * fifteen skeletons in this app — the three that lost it (the lineup's player names, the
 * projection card's, the entitlement gate's) pulsed at somebody who had asked their
 * operating system for less motion. `components/ui/skeleton.tsx` exists so new ones cannot
 * be written without it, and this catches a hand-rolled one.
 *
 * **Nothing transitions `all`, and every transform transition asks first.**
 * `transition-all` includes every layout property, so a change of padding or a label that
 * changes width animates the geometry of the element and everything after it; it was on the
 * base `Button` variant, the most-used component here. And `transition-transform` is
 * movement rather than a colour fade, so it is the one transition a reduced-motion
 * preference should turn off rather than narrow — the recommendation panel's disclosure
 * chevron rotated 180 degrees without the guard, and a first version of this file that only
 * knew about `animate-pulse` did not see it.
 *
 * The reduced-motion rule that is *not* checked here is the one in `app/globals.css`:
 * `tw-animate-css` ships no guard, so dialogs and dropdowns zoomed and slid regardless of
 * the setting. That is a stylesheet rule rather than a class convention, and a source scan
 * is the wrong instrument — it is asserted by `globals.css` carrying the media query, which
 * the third test below checks, and verified by rendering.
 */
const SCANNED = ["app", "components"];

/**
 * One utility, with whatever variants are in front of it.
 *
 * Bounded on a class separator rather than `\S*`, which swallowed the `className="` in
 * front of it — and read through `stripComments`, because the first version of this scan
 * reported the sentences in which these very rules are explained. A guard that flags its
 * own documentation gets deleted rather than obeyed.
 */
function utilities(source: string, name: string): string[] {
  const pattern = new RegExp(`(?:^|[\\s"'\`])((?:[^\\s"'\`]*:)?${name})(?![\\w-])`, "g");
  return [...stripComments(source).matchAll(pattern)].map((m) => m[1]);
}

/**
 * Whether a utility's variant chain asks the operating system first.
 *
 * `includes`, not equality with `motion-safe:x` — a guarded utility can carry other
 * variants too, and `md:motion-safe:transition-transform` is guarded. Equality reported it
 * as an offender, which is a guard that punishes the correct thing.
 */
function guarded(utility: string): boolean {
  return utility.includes("motion-safe:");
}

/** `animate-pulse` written without the variant that makes it optional. */
function unguardedPulses(source: string): string[] {
  return utilities(source, "animate-pulse").filter((u) => !guarded(u));
}

/** `transition-all`, under any variant. */
function transitionAll(source: string): string[] {
  return utilities(source, "transition-all");
}

/**
 * Transform transitions written without the guard.
 *
 * `transition-transform` animates translate, scale and rotate — movement, which is the
 * thing a reduced-motion preference is about, unlike the colour fades everything else here
 * transitions. The recommendation panel's disclosure chevron rotated 180 degrees without
 * it, and was missed by a first version of this file that only knew about `animate-pulse`.
 */
function unguardedTransforms(source: string): string[] {
  const named = utilities(source, "transition-transform");
  // Bare `transition` animates transform, translate, scale and rotate in Tailwind v4 — a
  // superset of the utility above, sitting one keystroke away from it — and an arbitrary
  // list can name any of the four. Neither is used here today, which is when a rule is
  // free to add.
  const bare = [...stripComments(source).matchAll(/(?:^|[\s"'`])((?:[^\s"'`]*:)?transition)(?![-\w[])/g)]
    .map((m) => m[1]);
  const arbitrary = [
    ...stripComments(source).matchAll(/(?:^|[\s"'`])((?:[^\s"'`]*:)?transition-\[[^\]]*\])/g),
  ]
    .map((m) => m[1])
    .filter((u) => /transform|translate|scale|rotate/.test(u));
  return [...named, ...bare, ...arbitrary].filter((u) => !guarded(u));
}

describe("motion is asked for, not assumed", () => {
  it("guards every pulse with motion-safe", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        scanned += 1;
        for (const hit of unguardedPulses(readFileSync(file, "utf8"))) {
          offenders.push(`${file}: ${hit}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(scanned).toBeGreaterThan(20);
  });

  it("guards every transform transition with motion-safe", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        for (const hit of unguardedTransforms(readFileSync(file, "utf8"))) {
          offenders.push(`${file}: ${hit}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("transitions named properties rather than all of them", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        for (const hit of transitionAll(readFileSync(file, "utf8"))) {
          offenders.push(`${file}: ${hit}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would notice either if it appeared", () => {
    expect(unguardedPulses('<div className="h-4 animate-pulse rounded" />')).toEqual([
      "animate-pulse",
    ]);
    expect(unguardedPulses('<div className="motion-safe:animate-pulse" />')).toEqual([]);
    // A different variant in front of it is not the guard.
    expect(unguardedPulses('<div className="sm:animate-pulse" />')).toEqual(["sm:animate-pulse"]);
    // Prose is not code. Both of these explain the rule and neither violates it.
    expect(unguardedPulses("// never write a bare animate-pulse here")).toEqual([]);
    expect(transitionAll("/* Not `transition-all`: it animates layout too. */")).toEqual([]);
    expect(transitionAll('className="transition-all duration-200"')).toEqual(["transition-all"]);
    expect(transitionAll('className="hover:transition-all"')).toEqual(["hover:transition-all"]);
    expect(transitionAll('className="transition-[color,box-shadow]"')).toEqual([]);
    expect(unguardedTransforms('className="size-4 transition-transform"')).toEqual([
      "transition-transform",
    ]);
    expect(unguardedTransforms('className="motion-safe:transition-transform"')).toEqual([]);
    // A guard under another variant is still a guard.
    expect(unguardedTransforms('className="md:motion-safe:transition-transform"')).toEqual([]);
    expect(unguardedPulses('className="lg:motion-safe:animate-pulse"')).toEqual([]);
    // The two ways of animating a transform without naming it.
    expect(unguardedTransforms('className="transition duration-200"')).toEqual(["transition"]);
    expect(unguardedTransforms('className="transition-[transform,opacity]"')).toEqual([
      "transition-[transform,opacity]",
    ]);
    expect(unguardedTransforms('className="transition-[color,box-shadow]"')).toEqual([]);
  });

  it("keeps the reduced-motion rule the animation library does not ship", () => {
    // Two halves in two places: the media query here, and `tw-animate-css` having no guard
    // of its own. If the library ever adds one this becomes redundant rather than wrong,
    // but silently dropping the block would restore the zoom for everybody who asked for
    // less motion, and nothing else in the repo would notice.
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/--tw-enter-scale:\s*1/);
    expect(css).toMatch(/--tw-enter-translate-y:\s*0/);
  });
});
