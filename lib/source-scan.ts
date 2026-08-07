import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading this repository's own source, for the guards that are about how it is written.
 *
 * Five tests now scan the tree — purity, the `@/*` alias, the app shell's width, the stable
 * query hook, scroll containment and motion — and each had its own copy of the file walk.
 * The comment stripper is the part that actually needed sharing: a scan that reads prose as
 * code reports its own explanations as violations, which is exactly what the motion guard
 * did on its first run, and this implementation already knows the trap that a naive one
 * falls into.
 *
 * It lives outside `lib/core`, `lib/nfl` and `lib/billing`, which are the directories
 * `purity.test.ts` guards — this reads the filesystem by design.
 */

/** Every non-test `.ts`/`.tsx` file under a directory. */
export function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "_generated") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      // `.tsx` is included so a component added under a guarded directory cannot slip past.
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
