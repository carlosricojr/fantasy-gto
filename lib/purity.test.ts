import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sourceFiles, stripComments, stripCommentsAndStrings } from "./source-scan";

/**
 * Enforces the dependency rule.
 *
 * The project's organizing claim is that the domain core is pure: no network, no clock, no
 * randomness, no framework. That claim is load-bearing — it is what makes the model
 * backtestable and the entitlement logic testable — and a rule that is only written down
 * gets violated. It already was: the nflverse adapter called `fetch` from inside
 * `lib/nfl/`, contradicting the README, until it was moved to `lib/sources/`.
 *
 * `lib/sources/` is deliberately excluded. It is the adapter layer, and doing I/O is its
 * entire job. Test files are excluded too: loading a checked-in fixture from disk is how
 * they exercise real data.
 *
 * The scanner below is itself under test, because the first version of this guard was
 * **vacuous in two ways** and passed anyway:
 *
 *  - it blanked string contents before matching import specifiers, so `from "convex/server"`
 *    became `from ""` and the framework-import rules could never fire; and
 *  - it discarded template literals whole, hiding a `${Date.now()}` inside one.
 *
 * A guard that cannot fail is worse than no guard, because it is mistaken for one.
 */

/** Directories that must contain no I/O, no clock, and no randomness. */
const PURE_DIRECTORIES = ["core", "nfl", "billing"];

/** Rules matched against executable code with string *contents* removed. */
const FORBIDDEN_CALLS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bfetch\s*\(/, reason: "network access" },
  { pattern: /\bDate\.now\s*\(/, reason: "reads the clock; pass `now` in instead" },
  { pattern: /\bnew Date\s*\(\s*\)/, reason: "reads the clock; pass `now` in instead" },
  { pattern: /\bMath\.random\s*\(/, reason: "non-deterministic" },
  { pattern: /\bprocess\s*\.\s*env\b/, reason: "environment access" },
  { pattern: /\blocalStorage\b/, reason: "browser storage" },
  { pattern: /\bsetTimeout\s*\(/, reason: "timers" },
];

/** Module specifiers the domain may not import, matched with strings intact. */
const FORBIDDEN_IMPORTS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /from\s*["']convex(\/|["'])/, reason: "imports Convex" },
  { pattern: /from\s*["']@clerk\//, reason: "imports Clerk" },
  { pattern: /from\s*["']react(\/|["'])/, reason: "imports React" },
  { pattern: /from\s*["']next(\/|["'])/, reason: "imports Next.js" },
  { pattern: /from\s*["']node:/, reason: "imports a Node built-in" },
  { pattern: /from\s*["']\.\.?\/.*\/sources\//, reason: "imports the adapter layer" },
];

describe("domain purity", () => {
  const files = PURE_DIRECTORIES.flatMap((dir) => sourceFiles(join(__dirname, dir)));

  it("finds the domain source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_CALLS)("contains no $reason", ({ pattern, reason }) => {
    const offenders = files.filter((file) =>
      pattern.test(stripCommentsAndStrings(readFileSync(file, "utf8"))),
    );
    expect(offenders, `${reason}:\n${offenders.join("\n")}`).toEqual([]);
  });

  it.each(FORBIDDEN_IMPORTS)("$reason nowhere", ({ pattern, reason }) => {
    const offenders = files.filter((file) =>
      pattern.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders, `${reason}:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not apply the rule to the adapter layer, whose job is I/O", () => {
    // Also proves the scanner is not silently blanking everything: if it were, this would
    // report no fetch and the whole guard would be vacuous.
    const adapters = sourceFiles(join(__dirname, "sources"));
    expect(adapters.length).toBeGreaterThan(0);
    expect(
      adapters.some((file) =>
        /\bfetch\s*\(/.test(stripCommentsAndStrings(readFileSync(file, "utf8"))),
      ),
    ).toBe(true);
  });
});

describe("the scanner itself", () => {
  it("keeps executable code", () => {
    expect(stripCommentsAndStrings("const a = fetch(url);")).toContain("fetch(");
  });

  it("blanks line and block comments", () => {
    expect(stripCommentsAndStrings("a // fetch(x)\nb")).not.toContain("fetch(");
    expect(stripCommentsAndStrings("a /* fetch(x) */ b")).not.toContain("fetch(");
    // A regular expression is not a comment, however many slashes are inside it. Without
    // this the rest of the line vanished — and the call this scan exists to find with it.
    expect(stripCommentsAndStrings("const slash = /[//]/; Date.now()")).toContain("Date.now(");
    expect(stripComments("const slash = /[//]/; Date.now()")).toContain("Date.now(");
    expect(stripComments("const re = /a\\/b/; Date.now()")).toContain("Date.now(");
    // ...and division still is not one.
    expect(stripComments("const half = total / 2; // gone\nDate.now()")).toContain("Date.now(");
    expect(stripComments("const half = total / 2; // gone\nx")).not.toContain("gone");
    // A literal in statement position after a control-flow head, where the preceding
    // character is a closing paren and would otherwise read as division.
    expect(stripComments('if (ok) /[//]/.test(v); Date.now()')).toContain("Date.now(");
    expect(stripCommentsAndStrings('if (ok) /[//]/.test(v); Date.now()')).toContain("Date.now(");
    // ...but a call's closing paren still is division, not a literal.
    expect(stripComments("const r = f(a) / 2; // gone\nx")).not.toContain("gone");
    // A brace inside a string inside an interpolation does not end the interpolation.
    expect(stripCommentsAndStrings('const t = `${row["}"]} tail`; Date.now()')).toContain(
      "Date.now(",
    );
  });

  it("does not treat // inside a string as a comment", () => {
    const source = 'const BASE = "https://example.com/a";\nconst r = fetch(BASE);';
    expect(stripCommentsAndStrings(source)).toContain("fetch(");
    expect(stripComments(source)).toContain("https://example.com/a");
  });

  it("blanks literal text but keeps template interpolations", () => {
    // The regression: discarding a template whole hid a violation inside `${…}`.
    const source = "const a = `week ${Date.now()} of ${season}`;";
    const stripped = stripCommentsAndStrings(source);
    expect(stripped).toContain("Date.now()");
    expect(stripped).not.toContain("week ");
  });

  it("tracks nesting inside an interpolation", () => {
    const source = "const a = `${fn({ k: 1 })} tail`;";
    const stripped = stripCommentsAndStrings(source);
    expect(stripped).toContain("fn({ k: 1 })");
    expect(stripped).not.toContain("tail");
  });

  it("preserves import specifiers for import checks", () => {
    // The other regression: blanking string contents made every import rule unfireable.
    const source = 'import { x } from "convex/server";';
    expect(/from\s*["']convex(\/|["'])/.test(stripComments(source))).toBe(true);
    expect(/from\s*["']convex(\/|["'])/.test(stripCommentsAndStrings(source))).toBe(false);
  });

  it("handles escaped quotes", () => {
    expect(stripCommentsAndStrings('a = "he said \\"hi\\""; fetch(b);')).toContain("fetch(");
  });

  it("collects .tsx as well as .ts", () => {
    // A component added under the domain must not slip past the scan.
    const files = sourceFiles(join(__dirname, "core"));
    expect(files.every((f) => f.endsWith(".ts") || f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });
});
