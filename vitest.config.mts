import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

/**
 * Two test projects, because they need different runtimes.
 *
 * `domain` covers `lib/` — pure TypeScript with no network, filesystem, or framework
 * dependency, so it runs in plain Node with no setup file and no mocking infrastructure.
 * It also picks up `app/` tests that need no browser runtime: the draft's stored-state
 * parser and server-rendered recommendation interpretation are examples. The parser was
 * once written and shipped untested because the include list stopped at `lib/`; a test file
 * that never runs is worse than none.
 *
 * `convex` covers `convex/` through `convex-test`, which executes functions against an
 * in-memory backend. That needs the edge runtime, which is slower to start, so it is a
 * separate project rather than a global environment.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts", "convex/**/*.ts", "app/**/*.ts"],
      exclude: ["**/*.test.ts", "convex/_generated/**"],
    },
    projects: [
      {
        resolve: { alias },
        // The draft interpretation contract is rendered in TSX. Vitest otherwise honors
        // Next's `jsx: preserve` and cannot import a component for server-rendered tests.
        oxc: { jsx: { runtime: "automatic" } },
        test: {
          name: "domain",
          environment: "node",
          include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
          /**
           * Longer than the 5s default, because much of this suite is Monte Carlo.
           *
           * A championship simulation over several hundred scenarios takes seconds by
           * design, and several tests here sit between 1.7s and 4s on an idle machine.
           * Under any load they crossed the default and failed — passing alone, failing in
           * a full run, and passing again on a retry. The mutation harness caught it
           * because its baseline check runs one file at a time; `pnpm verify` had been
           * green only because the machine happened to be quiet.
           *
           * A test whose result depends on how busy the machine is tells you nothing about
           * the code, in either direction.
           */
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/tests/**/*.test.ts"],
          server: { deps: { inline: ["convex-test"] } },
        },
      },
    ],
  },
});
