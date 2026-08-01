import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

/**
 * Two test projects, because they need different runtimes.
 *
 * `domain` covers `lib/` — pure TypeScript with no network, filesystem, or framework
 * dependency, so it runs in plain Node with no setup file and no mocking infrastructure.
 * It also picks up the handful of `app/` modules that are pure in the same sense: the
 * draft's stored-state parser is one, and it was written and shipped untested because the
 * include list stopped at `lib/`. A test file that never runs is worse than none.
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
        test: {
          name: "domain",
          environment: "node",
          include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
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
