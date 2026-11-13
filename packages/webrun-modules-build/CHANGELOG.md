# @statewalker/webrun-modules-build

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-builder crosses a breaking line

### Patch Changes

- Updated dependencies [59ac689]
  - @statewalker/webrun-builder@0.4.0

## 0.3.0

### Minor Changes

- 8f7df02: `webrun-builder` is rewritten as one key-level incremental engine (replacing the stage-level frontier scheduler and the private `webrun-cells`): builders over collections with tracked dynamic reads, early cut-off on unchanged values, automatic retraction with `dispose` hooks, glitch-free scheduling, retries and dead letters, group commit, and all state in a pluggable ordered KV (`MemKV`, `FilesKV`, `SqlKV`). `scanSources` mirrors a file tree into a source collection. Breaking: `registerBuilder`, `readUpdates`, `yieldControl`, `restartFrom`, the built-in `SourceScanner` builder and the `sources-removed` collection are gone — declare `BuilderDef`s, call `scanSources`, and use `dispose` for clean-up.
  
  `webrun-modules-build` runs on the new engine: one `Preprocess` builder per source with `dispose` pruning removed sources' artifacts; `webrunBuilders(served)` now takes the build host and returns `BuilderDef`s, and `build()` returns every current entry.
  
  The engine is self-contained (its topology no longer comes from `webrun-dataflow`, which is removed from the workspace), and persistence is configuration: `createBuildEngine({ builders, persistence: { kind: "memory" | "files" | "sql" | "custom", … } })` / `openStore(config)`.
  
  Later in this release: verify-before-execute (read fingerprints; `RunStats.skipped`), commit-time re-checks so a write landing during a task is never lost, ownership hand-over from stale owners, incremental reduce builders (`incremental: true`, `ctx.changes`, `ctx.state`), and several engines per store (`shared: true` leases; `KV.commit` takes per-write `ifValue` conditions and returns which applied).
  
  Terminology: cells are now **builders** and signals are **collections** (to avoid clashing with cellb.dev) — `BuilderDef`, `BuildEngineOptions.builders`, `ctx.get(collection, key)`, `DeadLetter.builder`, `SOURCES_COLLECTION`, `scanSources({ collection })`; `webrun-modules-build` exports `webrunBuilders(host)`.

### Patch Changes

- Updated dependencies
- Updated dependencies [8f7df02]
  - @statewalker/webrun-tailwind@0.2.4
  - @statewalker/webrun-builder@0.3.0

## 0.2.3

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-modules ^0.3.5 -> ^0.3.6
- Updated dependencies
  - @statewalker/webrun-tailwind@0.2.3

## 0.2.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-modules ^0.3.3 -> ^0.3.4
- Updated dependencies
- Updated dependencies [197f670]
  - @statewalker/webrun-tailwind@0.2.2
  - @statewalker/webrun-modules@0.3.5

## 0.2.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/webrun-builder@0.2.1
  - @statewalker/webrun-dataflow@0.1.3
  - @statewalker/webrun-modules@0.3.3
  - @statewalker/webrun-tailwind@0.2.1

## 0.1.2

### Patch Changes

- Republish both with `pnpm publish`, which resolves `catalog:` and `workspace:` specifiers
  into real version ranges. `webrun-tailwind@0.1.1` was published with plain `npm publish`,
  which ships them verbatim, so its manifest reached the registry carrying
  `"@statewalker/webrun-files": "catalog:"` — unresolvable for any consumer outside this
  workspace. `webrun-modules-build` pinned that exact version, so it broke too.
- Updated dependencies
  - @statewalker/webrun-tailwind@0.1.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-builder@0.1.1
  - @statewalker/webrun-dataflow@0.1.1
  - @statewalker/webrun-modules@0.2.1
  - @statewalker/webrun-tailwind@0.1.1
