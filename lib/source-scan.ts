import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading this repository's own source, for the guards that are about how it is written.
 *
 * Four tests share it — purity, the stable query hook, scroll containment and motion.
 * (`shell-width.test.ts` reads three named files and walks nothing; `import-alias.test.ts`
 * still carries its own walker, which skips `_generated` for its own reasons.) The comment
 * stripper is the part that actually needed sharing: a scan that reads prose as code
 * reports its own explanations as violations, which is exactly what the motion guard did on
 * its first run, and this implementation already knows the traps a naive one falls into.
 *
 * It lives outside `lib/core`, `lib/nfl` and `lib/billing`, which are the directories
 * `purity.test.ts` guards — this reads the filesystem by design.
 */

/**
 * Whether a `/` at `i` starts a regular expression rather than a comment or a division.
 *
 * The standard heuristic: a literal can only appear where an expression can begin, so the
 * last meaningful character before it decides. Without this, `const re = /[//]/` reads as a
 * line comment and everything after it on the line disappears — taking, say, a `Date.now()`
 * with it, which is precisely the call the purity scan exists to find.
 */
function startsRegex(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j])) j -= 1;
  if (j < 0) return true;
  const prev = source[j];
  // `}`, `<` and `>` are deliberately absent. They are expression-start positions in plain
  // JavaScript, and in TSX they are the end of `{expr}` and of a tag — so `<A b={c} />`
  // would read as a regex opening at the `/`, run to the next `/` on the line, and in
  // `stripCommentsAndStrings` could swallow an opening quote and leave the parser a quote
  // out of phase for the rest of the file. Losing them costs nothing real: `{} /re/` is not
  // something anybody writes, and the scan reads `.tsx` under `lib/core` by design.
  if ("(,=:[!&|?;+-*%~^".includes(prev)) return true;
  // `if (ok) /re/.test(x)` — a closing paren is division after a call, but a statement
  // boundary after a control-flow head. Walk back to the matching `(` and look at the word
  // in front of it; anything else keeps the old answer, which is "this is division".
  if (prev === ")") {
    let depth = 0;
    let k = j;
    for (; k >= 0; k -= 1) {
      if (source[k] === ")") depth += 1;
      else if (source[k] === "(") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (k < 0) return false;
    const head = source.slice(Math.max(0, k - 8), k).match(/[A-Za-z$_][\w$]*\s*$/);
    return head !== null && ["if", "while", "for", "with"].includes(head[0].trim());
  }
  // `return /re/`, `typeof /re/`, and friends: a word here is a keyword, not a value.
  const word = source.slice(Math.max(0, j - 10), j + 1).match(/[A-Za-z$_][\w$]*$/);
  return word !== null && ["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof"].includes(word[0]);
}

/** Skips a regular expression literal, returning the index just past it. */
function skipRegex(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    else if (c === "\n") return start + 1;
    i += 1;
  }
  return i;
}

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
    if (char === "/" && startsRegex(source, i)) {
      const end = skipRegex(source, i);
      out += source.slice(i, end);
      i = end;
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
    if (char === "/" && startsRegex(source, i)) {
      const end = skipRegex(source, i);
      out += source.slice(i, end);
      i = end;
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
          // nested object literal does not end it early — and stepping over string
          // literals, so a brace *inside* a string does not either. `${row["}"]}` ended the
          // interpolation at the quoted brace and left the rest of the template being read
          // as executable code, which is the direction that hides calls rather than
          // inventing them.
          if (source[i] === '"' || source[i] === "'") {
            const quote = source[i];
            out += source[i];
            i += 1;
            while (i < source.length && source[i] !== quote) {
              if (source[i] === "\\") {
                out += source.slice(i, i + 2);
                i += 2;
                continue;
              }
              out += source[i];
              i += 1;
            }
            out += source[i] ?? "";
            i += 1;
            continue;
          }
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
