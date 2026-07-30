/**
 * Declares Vite's `import.meta.glob`, which `convex-test` needs to discover the function
 * modules under test.
 *
 * Declared locally rather than by referencing `vite/client`: Vite is only a transitive
 * dependency of vitest here, so that reference does not resolve from the root tsconfig,
 * and adding a direct dependency purely for a type would be heavier than this.
 */
interface ImportMeta {
  glob: (
    patterns: string | readonly string[],
  ) => Record<string, () => Promise<unknown>>;
}
