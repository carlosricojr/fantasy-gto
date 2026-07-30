import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The domain core (`lib/model`, `lib/scoring`, `lib/nfl`) is pure TypeScript with no
 * network, filesystem, or framework dependencies, so it runs in the default `node`
 * environment with no setup file and no mocking infrastructure.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "convex/_generated/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/**/*.ts"],
      exclude: ["lib/**/*.test.ts", "lib/**/__fixtures__/**"],
    },
  },
});
