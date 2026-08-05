import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

function sourceFilesIn(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // `.tsx` is included so a component added under the domain cannot slip past.
      const isSource = entry.endsWith(".ts") || entry.endsWith(".tsx");
      const isTest = entry.endsWith(".test.ts") || entry.endsWith(".test.tsx");
      if (isSource && !isTest) out.push(full);
    }
  };
  walk(directory);
  return out;
}

/**
 * Removes comments, leaving string literals intact.
 *
 * Used for import checks, which have to see the module specifier. Skipping over strings
 * rather than deleting them is what stops the `//` inside `"https://…"` being read as a
 * comment — the bug that silently erased real code from the first version of this scan.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * Removes comments and string *contents*, but keeps template interpolations.
 *
 * Used for call checks. Blanking a template literal whole would hide `${Date.now()}`, so
 * the `${…}` regions are retained as executable code while the literal text around them is
 * dropped. Quotes are preserved as empty literals so the surrounding syntax still parses.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += " ";
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += `${quote}${quote}`;
      continue;
    }

    if (char === "`") {
      i += 1;
      out += "``";
      let depth = 0;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (depth === 0 && source[i] === "`") {
          i += 1;
          break;
        }
        if (depth === 0 && source[i] === "$" && source[i + 1] === "{") {
          depth = 1;
          i += 2;
          out += " ";
          continue;
        }
        if (depth > 0) {
          // Inside an interpolation: keep the expression, tracking nesting so a `}` in a
          // nested object literal does not end it early.
          if (source[i] === "{") depth += 1;
          if (source[i] === "}") {
            depth -= 1;
            if (depth === 0) {
              i += 1;
              out += " ";
              continue;
            }
          }
          out += source[i];
        }
        i += 1;
      }
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

describe("domain purity", () => {
  const files = PURE_DIRECTORIES.flatMap((dir) => sourceFilesIn(join(__dirname, dir)));

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
    const adapters = sourceFilesIn(join(__dirname, "sources"));
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
    const files = sourceFilesIn(join(__dirname, "core"));
    expect(files.every((f) => f.endsWith(".ts") || f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".test.ts"))).toBe(false);
  });
});
