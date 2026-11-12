import { defineConfig } from "vitest/config";

// `pnpm test:massive` — 1000 documents × ~100 chunks. Not part of `pnpm test`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.massive.ts"],
    testTimeout: 30 * 60_000,
  },
});
