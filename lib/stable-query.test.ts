import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { stableQueryState } from "../components/stable-query";

/**
 * The rule `useStableQuery` is built on.
 *
 * Imported from `components/` rather than `lib/` because it is about a client-side query
 * surface, and tested from here because `vitest.config.ts` only collects `lib/**` and
 * `app/**`. The module it tests imports nothing — that is what lets this run in the node
 * project with no DOM.
 *
 * By relative path, like everything else under `lib/`. The `@/*` alias would resolve here —
 * `import-alias.test.ts` excludes test files deliberately, and vitest is configured with it
 * — but this would be the only file in the directory relying on that, and "the rule has an
 * exception you have to know about" is how the rule stops being followed.
 */
describe("what to show while a different subscription loads", () => {
  it("settles on a value that has arrived", () => {
    expect(stableQueryState(["a"], undefined, false)).toEqual({
      data: ["a"],
      pending: false,
    });
  });

  it("holds the previous value, and says it is holding it", () => {
    expect(stableQueryState(undefined, ["a"], false)).toEqual({
      data: ["a"],
      pending: true,
    });
  });

  it("does not report pending before anything has ever loaded", () => {
    // The distinction the bug was: `undefined` with nothing behind it is a first load and
    // the caller should show its skeleton. `undefined` with something behind it is a
    // reload and the caller must not. Collapsing them is what unmounted the draft page on
    // every scoring change.
    expect(stableQueryState(undefined, undefined, false)).toEqual({
      data: undefined,
      pending: false,
    });
  });

  it("treats null as an answer, not as a load in progress", () => {
    // `boardFreshness` returns null for a league size whose board has never been built.
    // Holding the previous league's freshness there would date a board that does not exist.
    expect(stableQueryState(null, { computedAt: 1 }, false)).toEqual({
      data: null,
      pending: false,
    });
  });

  it("drops what it was holding when the query is skipped", () => {
    // Skip is a decision not to ask. The draft page skips when it has no season, and a
    // board held through that would be shown for a season the page has said it does not
    // have.
    expect(stableQueryState(undefined, ["a"], true)).toEqual({
      data: undefined,
      pending: false,
    });
    // Even if a live value is somehow present, skipping wins: the caller has moved on.
    expect(stableQueryState(["a"], ["a"], true)).toEqual({
      data: undefined,
      pending: false,
    });
  });

  it("keeps identity, so a held value does not invalidate memoization", () => {
    // The point of holding the previous rows is that nothing downstream recomputes while
    // the new ones load. A copy would defeat that as surely as `undefined` did.
    const rows = [{ id: "p1" }];
    expect(stableQueryState(undefined, rows, false).data).toBe(rows);
  });
});

/**
 * Every query whose arguments can change goes through the stable hook.
 *
 * The rule is narrow and mechanical: `useQuery(api.thing, {})` cannot change arguments, so
 * it can never blank, and it is fine. Anything else can, and a bare `useQuery` there is the
 * bug this change fixed — one click on a scoring format unmounted the draft board, the
 * player pool, the roster and the settings dialog the click had been made in.
 *
 * Scanned rather than reviewed, for the reason `import-alias.test.ts` gives: a convention
 * that lives only in prose gets argued with, and this one is invisible until somebody is
 * mid-draft.
 */
const SCANNED = ["app", "components"];
/** The one wrapper that is *supposed* to call the unstable hook. */
const WRAPPER = join("components", "use-stable-query.ts");

function clientFiles(dir: string): string[] {
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

/**
 * Every hook in `convex/react` that keys its subscription on arguments.
 *
 * `useQuery` is the one in use, but it is not the only one that can reintroduce this:
 * `useQueries` resolves through the same `localQueryResult`, `usePaginatedQuery` keys
 * through `serializePaginatedPathAndArgs`, which embeds the arguments too, and
 * `useQuery_experimental` reports a `status` with no previous value behind it. None are
 * used today, which is exactly when widening a mechanical guard is free.
 */
const ARGS_KEYED = ["useQuery", "useQueries", "usePaginatedQuery", "useQuery_experimental"];

/** Calls that pass anything other than a literal `{}` for the arguments. */
function unstableQueryCalls(source: string): string[] {
  const found: string[] = [];
  for (const hook of ARGS_KEYED) {
    // No `s` flag: a negated character class already spans newlines, and a multi-line call
    // is exactly the shape these are written in.
    const pattern = new RegExp(`\\b${hook}\\(\\s*([^)]*?)\\s*\\)`, "g");
    for (const m of source.matchAll(pattern)) {
      const call = m[1].replace(/\s+/g, " ").trim();
      if (/^api\.[A-Za-z0-9_.]+, \{\}$/.test(call)) continue;
      found.push(`${hook}(${call.slice(0, 60)})`);
    }
  }
  return found;
}

describe("no screen blanks when a query argument changes", () => {
  it("finds no bare useQuery with arguments that can change", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of SCANNED) {
      for (const file of clientFiles(dir)) {
        scanned += 1;
        if (file === WRAPPER) continue;
        for (const call of unstableQueryCalls(readFileSync(file, "utf8"))) {
          offenders.push(`${file}: ${call}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // A scan that walked nothing passes for the wrong reason, which is how a guard becomes
    // folklore. There are dozens of client files; the exact number is not the point.
    expect(scanned).toBeGreaterThan(20);
  });

  it("would notice one if it appeared", () => {
    expect(unstableQueryCalls("const b = useQuery(api.draft.board, { season, scoringId });")).toEqual([
      "useQuery(api.draft.board, { season, scoringId })",
    ]);
    expect(unstableQueryCalls('const b = useQuery(api.draft.board, x ? y : "skip");')).toHaveLength(1);
    // The other three hooks that key on arguments, and would reintroduce this silently.
    expect(unstableQueryCalls("usePaginatedQuery(api.x.y, { q }, { initialNumItems: 20 })")).toHaveLength(1);
    expect(unstableQueryCalls("useQueries({ a: { query: api.x.y, args: { q } } })")).toHaveLength(1);
    expect(unstableQueryCalls("useQuery_experimental({ query: api.x.y, args: { q } })")).toHaveLength(1);
    // The two shapes that are fine: no arguments to vary, and the stable wrapper.
    expect(unstableQueryCalls("const s = useQuery(api.season.current, {});")).toEqual([]);
    expect(unstableQueryCalls("const b = useStableQuery(api.draft.board, { scoringId });")).toEqual([]);
  });
});
