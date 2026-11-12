import { defineConfig } from "vitest/config";

// Massive tests: `pnpm test:massive` (scale with MASSIVE_SCALE). Not part of `pnpm test`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.massive.ts"],
    testTimeout: 30 * 60_000,
    hookTimeout: 30 * 60_000,
  },
});
