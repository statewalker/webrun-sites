import { defineConfig } from "rolldown";

// Single self-contained ESM bundle at dist/index.js.
// `@statewalker/webrun-files` is a peer dep (type only) and must not be inlined.
export default defineConfig({
  input: "src/index.ts",
  output: {
    file: "dist/index.js",
    format: "esm",
  },
  external: ["@statewalker/webrun-files"],
  treeshake: true,
});
