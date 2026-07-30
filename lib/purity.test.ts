import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces the dependency rule.
 *
 * The project's organising claim is that the domain core is pure: no network, no clock, no
 * randomness, no framework. That claim is load-bearing — it is what makes the model
 * backtestable and the entitlement logic testable — and a rule that is only written down
 * gets violated. It already was: the nflverse adapter called `fetch` from inside
 * `lib/nfl/`, contradicting the README, until it was moved to `lib/sources/`.
 *
 * `lib/sources/` is deliberately excluded. It is the adapter layer, and doing I/O is its
 * entire job.
 */

/** Directories that must contain no I/O, no clock, and no randomness. */
const PURE_DIRECTORIES = ["core", "nfl", "billing"];

/** Patterns that would break purity, with why each matters. */
const FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bfetch\s*\(/, reason: "network access" },
  { pattern: /\bDate\.now\s*\(/, reason: "reads the clock; pass `now` in instead" },
  { pattern: /\bnew Date\s*\(\s*\)/, reason: "reads the clock; pass `now` in instead" },
  { pattern: /\bMath\.random\s*\(/, reason: "non-deterministic" },
  { pattern: /\bprocess\.env\b/, reason: "environment access" },
  { pattern: /\bfrom\s+["']convex\//, reason: "imports Convex" },
  { pattern: /\bfrom\s+["']@clerk\//, reason: "imports Clerk" },
  { pattern: /\bfrom\s+["']react["']/, reason: "imports React" },
  { pattern: /\bfrom\s+["']next\//, reason: "imports Next.js" },
];

function sourceFilesIn(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(directory);
  return out;
}

/**
 * Blanks out comments and string literals so only executable code is scanned.
 *
 * Without this the rule fires on prose explaining why `Date.now()` is avoided — the sort
 * of false positive that gets a guard deleted.
 *
 * This is a single left-to-right scan rather than a chain of regular expressions. Chained
 * regexes get this wrong in a way that fails *open*: stripping comments first turns the
 * `//` inside a `"https://…"` literal into a line comment, which swallows the closing
 * quote, unbalances the next string, and silently erases real code from the scan. That bug
 * was present here and made the guard pass while violations existed.
 *
 * Quotes are preserved as empty literals so import specifiers still parse as `from ""`.
 */
function stripCommentsAndStrings(source: string): string {
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

  it.each(FORBIDDEN)("contains no $reason", ({ pattern, reason }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripCommentsAndStrings(readFileSync(file, "utf8"));
      if (pattern.test(code)) {
        offenders.push(`${file.slice(file.indexOf("/lib/"))} — ${reason}`);
      }
    }
    expect(offenders, `domain purity violated:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not apply the rule to the adapter layer, whose job is I/O", () => {
    // Also proves the scanner is not silently blanking everything: if it were, this
    // would report no fetch and the whole guard would be vacuous.
    const adapters = sourceFilesIn(join(__dirname, "sources"));
    expect(adapters.length).toBeGreaterThan(0);
    const anyFetches = adapters.some((file) =>
      /\bfetch\s*\(/.test(stripCommentsAndStrings(readFileSync(file, "utf8"))),
    );
    expect(anyFetches).toBe(true);
  });
});

describe("stripCommentsAndStrings", () => {
  it("keeps executable code", () => {
    expect(stripCommentsAndStrings("const a = fetch(url);")).toContain("fetch(");
  });

  it("blanks line and block comments", () => {
    expect(stripCommentsAndStrings("a // fetch(x)\nb")).not.toContain("fetch(");
    expect(stripCommentsAndStrings("a /* fetch(x) */ b")).not.toContain("fetch(");
  });

  it("blanks string contents but keeps the quotes", () => {
    expect(stripCommentsAndStrings('import x from "./y";')).toBe('import x from "";');
  });

  it("does not treat // inside a string as a comment", () => {
    // The exact regression: a URL literal used to swallow the rest of the line and
    // unbalance every following string, erasing real code from the scan.
    const source = 'const BASE = "https://example.com/a";\nconst r = fetch(BASE);';
    const stripped = stripCommentsAndStrings(source);
    expect(stripped).toContain("fetch(");
    expect(stripped).toContain("const BASE");
  });

  it("handles escaped quotes and template literals", () => {
    expect(stripCommentsAndStrings('a = "he said \\"hi\\""; fetch(b);')).toContain("fetch(");
    expect(stripCommentsAndStrings("a = `x${y}//z`; fetch(b);")).toContain("fetch(");
  });
});
