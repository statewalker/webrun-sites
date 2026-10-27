# @statewalker/webrun-bundler

## 0.1.0

### Minor Changes

- 9a3f1d4: New package: a transpiler, resolver and bundler on esbuild-wasm that reads every file through a FilesApi (never node:fs), finds packages in node_modules folders or fetches them from the npm registry, and keeps an unbroken source map from each bundled line to the user's file or the npm package's original source (packages' own maps are composed in). `await` lowering is an option.
