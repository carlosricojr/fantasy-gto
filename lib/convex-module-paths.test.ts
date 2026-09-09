import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Naming-only preflight, not proof of remote deployment acceptance.
 * Matches entrypoint exclusions in the pinned Convex CLI's
 * node_modules/convex/src/bundler/index.ts (entryPoints).
 * Helpers are entrypoints too; a hyphen here passes tsc/Next but fails deploy.
 */
function isEntrypoint(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const file = basename(normalized);
  return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(normalized)
    && !normalized.startsWith("_generated/")
    && !file.startsWith(".")
    && !file.startsWith("#")
    && file !== "schema.ts"
    && file !== "schema.js"
    && (file.match(/\./g) ?? []).length === 1
    && !path.includes(" ");
}

function invalidPaths(paths: string[]): string[] {
  return paths.filter((path) => isEntrypoint(path)
    && path.split(/[\\/]/).some((part) => !/^[A-Za-z0-9_.]+$/.test(part)));
}

function sourcePaths(root: string): string[] {
  const paths: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Components have their own deploy root, so inspect them independently.
        if (existsSync(join(path, "convex.config.ts"))) {
          paths.push(...sourcePaths(path));
        } else {
          walk(path);
        }
      } else if (entry.isFile()) {
        paths.push(relative(root, path));
      }
    }
  }
  walk(root);
  return paths;
}

describe("Convex deployed module path naming", () => {
  it("rejects the actual failed helper and invalid nested module names", () => {
    expect(invalidPaths(["lib/read-bounds.ts", "bad-dir/helper.js", "lib/café.ts"]))
      .toEqual(["lib/read-bounds.ts", "bad-dir/helper.js", "lib/café.ts"]);
  });

  it("allows valid helper names and excludes files the CLI does not deploy", () => {
    expect(invalidPaths([
      "lib/readBounds.ts", "lib/read_bounds.ts", "api.mts", "view.jsx",
      "_generated/bad-name.ts", "tests/private-reads.test.ts", "other-name.spec.ts",
      "auth.config.ts", "convex.config.ts", ".scratch-file.ts", "#scratch-file.ts",
      "schema.ts", "schema.js", "notes-file.md", "space dir/bad-name.ts",
    ])).toEqual([]);
  });

  it("normalizes both slash styles without hiding invalid components", () => {
    expect(invalidPaths([
      "lib\\readBounds.ts", "_generated\\bad-name.ts", "tests\\private-reads.test.ts",
      "lib/readBounds.ts", "lib\\read-bounds.ts", "bad-dir\\helper.js",
    ])).toEqual(["lib\\read-bounds.ts", "bad-dir\\helper.js"]);
  });

  it("checks the repository's deployable source paths", () => {
    const paths = sourcePaths("convex");
    expect(paths.some((path) => isEntrypoint(path))).toBe(true);
    expect(invalidPaths(paths)).toEqual([]);
    expect(paths).toContain(join("lib", "readBounds.ts"));
  });
});
