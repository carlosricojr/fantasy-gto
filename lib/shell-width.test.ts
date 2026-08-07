import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The app's chrome is inset by exactly as much as the page under it.
 *
 * The header, the footer and `PageShell` each need a max-width, and for a while each had
 * its own literal. That is the arrangement this repo already knows the failure mode of:
 * when the shell was widened for the draft board, the header widened on the three app
 * screens that stayed narrow too, and the brand ended up 448px to the left of the content
 * it sat above on a 1920px display. Two independent reviews found it before it shipped.
 *
 * The fix was to make all three read one variable, `--app-shell-max`, which the page sets
 * by way of `data-shell`. This test is what stops a fourth surface — or a tidy-up that
 * "simplifies" a `var()` back to a literal — from quietly reintroducing a second number.
 *
 * It is a source scan for the same reason `purity.test.ts` and `import-alias.test.ts` are:
 * the rule is about how the files are written, and nothing that runs at test time can
 * observe a Tailwind class taking effect.
 */

const APP_CHROME = [
  "components/nav/site-header.tsx",
  "app/(app)/layout.tsx",
  "components/page-shell.tsx",
];

/**
 * Width caps written as a literal rather than taken from the shared constant.
 *
 * `max-w-3xl` and narrower are deliberately not matched: a paragraph's measure is a
 * property of the text, not of the shell, and capping prose is exactly what the default
 * `PageShell` size is for.
 */
function shellWidthLiterals(source: string): string[] {
  return [...source.matchAll(/\bmax-w-(?:[456789]xl|screen-\w+|\[[^\]]*rem\])/g)].map(
    (m) => m[0],
  );
}

describe("the app shell has one width", () => {
  it("writes no shell-width literal into the app chrome", () => {
    const offenders: string[] = [];
    for (const file of APP_CHROME) {
      for (const literal of shellWidthLiterals(readFileSync(file, "utf8"))) {
        offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would notice one if it appeared", () => {
    // A guard that cannot fail is mistaken for one that holds — the lesson
    // `import-alias.test.ts` records, applied to this matcher.
    expect(shellWidthLiterals('<div className="mx-auto max-w-6xl px-6">')).toEqual([
      "max-w-6xl",
    ]);
    expect(shellWidthLiterals('className="max-w-[104rem]"')).toEqual(["max-w-[104rem]"]);
    // ...and does not fire on a prose measure or on the variable the rule is defending.
    expect(shellWidthLiterals('className="max-w-3xl"')).toEqual([]);
    expect(shellWidthLiterals('"max-w-[var(--app-shell-max,72rem)]"')).toEqual([]);
  });

  it("routes every piece of chrome through the shared constant", () => {
    for (const file of APP_CHROME) {
      expect(readFileSync(file, "utf8")).toMatch(/APP_CONTAINER/);
    }
  });

  it("keeps the constant pointing at the variable the stylesheet sets", () => {
    // Two halves of one mechanism in two files. If either moves without the other, the
    // shell silently falls back to 72rem on every screen and the widening is simply gone —
    // a failure that looks like nothing at all rather than like a bug.
    expect(readFileSync("components/app-container.ts", "utf8")).toMatch(
      /max-w-\[var\(--app-shell-max,\s*72rem\)\]/,
    );
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\[data-app-shell\]\s*\{[^}]*--app-shell-max:\s*72rem/);
    expect(css).toMatch(/\[data-app-shell\]:has\(\[data-shell="wide"\]\)/);
    // And the page end of it: `PageShell` has to actually emit the attribute `:has()` looks
    // for, or the media rules above match nothing.
    expect(readFileSync("components/page-shell.tsx", "utf8")).toMatch(/data-shell=\{size\}/);
  });
});
