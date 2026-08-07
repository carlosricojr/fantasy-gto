import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
 * Scrollers whose positioning is set by a primitive's own base classes rather than at the
 * call site, so the class list here legitimately does not carry it.
 *
 * `DialogContent` is `fixed`, which already makes it a containing block. Adding `relative`
 * at these call sites would not be redundant — it would *win* over the base `fixed` through
 * `twMerge` and unpin the dialog.
 */
const EXEMPT = new Set([
  join("app", "(app)", "draft", "player-detail.tsx"),
  join("app", "(app)", "draft", "settings-dialog.tsx"),
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Class lists that scroll on some axis but establish no containing block. */
function unclippedScrollers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const classes = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\s+/g, " ").trim();
    const utilities = classes.split(" ");
    const scrolls = utilities.some((u) =>
      /^(?:[a-z0-9-]+:)*overflow(?:-[xy])?-(?:auto|scroll)$/.test(u),
    );
    if (!scrolls) continue;
    const positioned = utilities.some((u) =>
      /^(?:[a-z0-9-]+:)*(?:relative|absolute|fixed|sticky)$/.test(u) ||
      /^(?:[a-z0-9-]+:)*contain-(?:layout|paint|strict|content)$/.test(u),
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
        if (EXEMPT.has(file)) continue;
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
      unclippedScrollers('<div className="max-h-[70dvh] min-h-0 overflow-y-auto overscroll-contain" />'),
    ).toHaveLength(1);
    expect(unclippedScrollers('<div className="overflow-auto rounded-xl border" />')).toHaveLength(1);
    // ...and does not fire once the container is a containing block, by any of the ways of
    // being one.
    expect(unclippedScrollers('<div className="relative overflow-y-auto" />')).toEqual([]);
    expect(unclippedScrollers('<div className="sticky top-0 overflow-auto" />')).toEqual([]);
    expect(unclippedScrollers('<div className="overflow-x-scroll contain-paint" />')).toEqual([]);
    // `overflow-hidden` is not a scroll container and is not what this rule is about.
    expect(unclippedScrollers('<div className="overflow-hidden" />')).toEqual([]);
    // A responsive variant still scrolls, and still needs it.
    expect(unclippedScrollers('<div className="lg:overflow-y-auto" />')).toHaveLength(1);
  });
});
