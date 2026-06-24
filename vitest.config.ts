import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks", // PGlite loads WASM; 'forks' is the safe pool (NOT worker threads)
    // PGlite migrations are WASM-heavy; under parallel forks they can exceed the
    // default 10s hook timeout on busy machines. Give them room + cap fork fan-out
    // so 12+ test files don't oversubscribe the CPU and time out beforeAll().
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    hookTimeout: 60000,
    testTimeout: 30000,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
