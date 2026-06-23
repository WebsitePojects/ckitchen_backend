import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks", // PGlite loads WASM; 'forks' is the safe pool (NOT worker threads)
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
