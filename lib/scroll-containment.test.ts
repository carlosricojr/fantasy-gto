import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sourceFiles, stripComments } from "./source-scan";

/**
 * A scroll container is a containing block, or it does not clip what it scrolls.
 *
 * `overflow` clips a descendant only when that descendant's *containing block* is inside
 * the scroller. An absolutely positioned box whose containing block is further out is laid
 * out against that ancestor and is not clipped — it just sits wherever its static position
 * put it, and its overflow propagates to whatever does scroll. Usually the document.
 *
 * Which is not an exotic case here, because Tailwind's `sr-only` is
 * `position: absolute`. The player pool's scroller was `position: static` and so was every
 * ancestor of it up to `<body>`, so the screen-reader spans inside its rows resolved
 * against the initial containing block. Measured on production: a 2,961px table inside a
 * 544px window put spans as far down as 3,995px, and `documentElement.scrollHeight` came
 * back 4,630px against a 2,484px page — two thousand pixels of empty scroll below the
 * footer, growing with every press of "Show more". One `relative` fixed it.
 *
 * Nothing about that is specific to this list. Any scroller here can be handed an
 * `sr-only` label by an ordinary accessibility fix, so the rule is checked rather than
 * remembered — the shape `purity.test.ts` and `import-alias.test.ts` already use.
 */

const SCANNED = ["app", "components"];

/**
 * Class lists whose element is positioned by a primitive's own base classes rather than at
 * the call site.
 *
 * `DialogContent` is `fixed` (and `translate-x-[-50%]`, so a containing block twice over).
 * Adding `relative` at these call sites would not be redundant — tailwind-merge puts every
 * position utility in one conflict group, so the call-site class would *win* over the base
 * and unpin the dialog.
 *
 * Keyed on the class list and not on the file. Exempting the file skips it before the scan
 * runs, and these two are content-heavy dialogs — the likeliest place for somebody to add a
 * second, ordinary inner scroller that would then pass silently.
 */
const EXEMPT = new Set([
  "max-h-[85svh] overflow-y-auto sm:max-w-md",
  "max-h-[85svh] overflow-y-auto sm:max-w-lg",
]);

/**
 * Class lists that scroll on some axis but establish no containing block.
 *
 * Every double-quoted string in the file is considered, not only the ones spelled
 * `className="…"`. Every primitive under `components/ui/` composes its classes through
 * `cn(...)` or `cva(...)`, so a `className=`-only match was blind to exactly the directory
 * the next scroller will come from — `dropdown-menu.tsx` already had one it could not see.
 * A string with an `overflow-*-auto` utility in it is a class list; there is no other kind.
 */
function unclippedScrollers(source: string): string[] {
  const found: string[] = [];
  for (const m of stripComments(source).matchAll(/"([^"\n]*)"|`([^`]*)`/g)) {
    const classes = (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim();
    if (EXEMPT.has(classes)) continue;
    const utilities = classes.split(" ");
    // Variants are stripped by taking the segment after the last colon rather than by
    // matching a prefix pattern: `data-[state=open]:`, `supports-[…]:` and `[&_svg]:` all
    // carry brackets, and a `[a-z0-9-]+:` prefix silently failed to see any of them — so a
    // scroller declared behind one would not have been checked at all.
    const base = (u: string) => u.slice(u.lastIndexOf(":") + 1);
    const scrolls = utilities.some((u) => /^overflow(?:-[xy])?-(?:auto|scroll)$/.test(base(u)));
    if (!scrolls) continue;
    // Unprefixed, deliberately, and asymmetric with the test above on purpose: a scroller
    // that only scrolls at `lg` still scrolls, but a containing block that only exists at
    // `lg` leaves every narrower viewport unclipped.
    const positioned = utilities.some(
      (u) =>
        /^(?:relative|absolute|fixed|sticky)$/.test(u) ||
        /^contain-(?:layout|paint|strict|content)$/.test(u),
    );
    if (!positioned) found.push(classes.slice(0, 70));
  }
  return found;
}

describe("every scroll container clips what it scrolls", () => {
  it("finds no static scroller in the app", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        scanned += 1;
        for (const classes of unclippedScrollers(readFileSync(file, "utf8"))) {
          offenders.push(`${file}: ${classes}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(scanned).toBeGreaterThan(20);
  });

  it("would notice one if it appeared", () => {
    // The exact class list that shipped the bug.
    expect(
      unclippedScrollers('<div className="max-h-[70svh] min-h-0 overflow-y-auto overscroll-contain" />'),
    ).toHaveLength(1);
    // Prose that names a scroller is not a scroller.
    expect(unclippedScrollers('/* the `overflow-y-auto` container above */')).toEqual([]);
    expect(unclippedScrollers('<div className="overflow-auto rounded-xl border" />')).toHaveLength(1);
    // ...and does not fire once the container is a containing block, by any of the ways of
    // being one.
    expect(unclippedScrollers('<div className="relative overflow-y-auto" />')).toEqual([]);
    expect(unclippedScrollers('<div className="sticky top-0 overflow-auto" />')).toEqual([]);
    expect(unclippedScrollers('<div className="overflow-x-scroll contain-paint" />')).toEqual([]);
    // A class list composed through `cn()` is seen, which a `className=`-only match was not.
    expect(unclippedScrollers('cn("max-h-40 overflow-y-auto rounded border", className)')).toHaveLength(1);
    // A containing block that only exists at one breakpoint does not clip the others.
    expect(unclippedScrollers('<div className="overflow-y-auto lg:relative" />')).toHaveLength(1);
    // Variants carrying brackets are seen too — a prefix pattern of `[a-z0-9-]+:` was not.
    expect(unclippedScrollers('"data-[state=open]:overflow-y-auto rounded"')).toHaveLength(1);
    expect(unclippedScrollers('"[&_div]:overflow-auto p-1"')).toHaveLength(1);
    expect(unclippedScrollers('"data-[state=open]:overflow-y-auto relative"')).toEqual([]);
    // The documented exemption is matched on the class list, not the file it lives in.
    expect(unclippedScrollers('<DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">')).toEqual([]);
    // `overflow-hidden` is not a scroll container and is not what this rule is about.
    expect(unclippedScrollers('<div className="overflow-hidden" />')).toEqual([]);
    // A responsive variant still scrolls, and still needs it.
    expect(unclippedScrollers('<div className="lg:overflow-y-auto" />')).toHaveLength(1);
  });
});
