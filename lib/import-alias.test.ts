import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The `@/*` alias stops at the app boundary.
 *
 * Four resolvers compile the files under `lib/`: tsc against the root config, tsc against
 * `convex/tsconfig.json`, vitest, tsx, and the esbuild bundler Convex deploys with. Only
 * the first is configured with the alias. `convex/tsconfig.json` deliberately carries no
 * `paths` mapping — depending on one would mean keeping four resolvers in agreement, and
 * the failure surfaces at bundle time rather than at typecheck.
 *
 * So everything shared imports by relative path. That was written down in a comment and in
 * CLAUDE.md, where it had already rotted into the opposite claim — that Convex *needs* the
 * mapping — and a review cited the stale version against the correct config. A rule that
 * only exists in prose gets argued with; this one is checked.
 *
 * `app/` and `components/` are excluded: the alias is theirs, and they are compiled by
 * Next.js alone. Test files are excluded for the same reason `purity.test.ts` excludes
 * them — they are never bundled or deployed, and this file's own fixtures below contain
 * the very strings it searches for.
 */
const GUARDED = ["lib", "convex"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      if (name === "_generated" || name === "node_modules") continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Import and re-export specifiers, which is where a resolver disagreement bites. */
function aliasSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\bfrom\s+["'](@\/[^"']*)["']/g)) found.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*\(\s*["'](@\/[^"']*)["']\s*\)/g)) found.push(m[1]);
  return found;
}

describe("the @/* alias does not cross into shared code", () => {
  it("finds no aliased import under lib/ or convex/", () => {
    const offenders: string[] = [];
    for (const dir of GUARDED) {
      for (const file of sourceFiles(dir)) {
        for (const spec of aliasSpecifiers(readFileSync(file, "utf8"))) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would notice one if it appeared", () => {
    // The guard above passes trivially if the matcher is wrong, and a guard that cannot
    // fail is mistaken for one that holds — the lesson `purity.test.ts` records twice.
    expect(aliasSpecifiers('import { a } from "@/lib/core/draft";')).toEqual([
      "@/lib/core/draft",
    ]);
    expect(aliasSpecifiers('export { b } from "@/components/ui/button";')).toEqual([
      "@/components/ui/button",
    ]);
    expect(aliasSpecifiers('const m = await import("@/lib/x");')).toEqual(["@/lib/x"]);
    // And does not fire on a relative import that merely contains the characters.
    expect(aliasSpecifiers('import { c } from "../core/draft";')).toEqual([]);
  });

  it("agrees with the config it is defending", () => {
    // If a `paths` mapping is ever added to the Convex project, this rule is moot and
    // should be deleted rather than left as folklore.
    const convexConfig = readFileSync("convex/tsconfig.json", "utf8");
    expect(convexConfig).not.toMatch(/"paths"\s*:/);
  });
});
