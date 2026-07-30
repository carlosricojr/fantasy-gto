import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL(".", import.meta.url)) };

/**
 * Two test projects, because they need different runtimes.
 *
 * `domain` covers `lib/` — pure TypeScript with no network, filesystem, or framework
 * dependency, so it runs in plain Node with no setup file and no mocking infrastructure.
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
      include: ["lib/**/*.ts", "convex/**/*.ts"],
      exclude: ["**/*.test.ts", "convex/_generated/**"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "domain",
          environment: "node",
          include: ["lib/**/*.test.ts"],
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
