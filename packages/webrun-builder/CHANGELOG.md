# @statewalker/webrun-builder

## 0.3.1

### Patch Changes

- 7dee8ff: `run({ onProgress })` reports each committed batch (`RunProgress`: builder, tasks, executed, skipped, failed, deadLettered), and `scanSources({ limit, after })` writes at most `limit` changed files per scan and reports `more` and a `cursor` to resume after, so a large corpus flows through the pipeline batch by batch (the rotating start keeps a constantly changing file from starving the rest). `onProgress` errors are logged, never propagated; `RunProgress.released` counts claims given back as stale.

## 0.3.0

### Minor Changes

- 8f7df02: `webrun-builder` is rewritten as one key-level incremental engine (replacing the stage-level frontier scheduler and the private `webrun-cells`): builders over collections with tracked dynamic reads, early cut-off on unchanged values, automatic retraction with `dispose` hooks, glitch-free scheduling, retries and dead letters, group commit, and all state in a pluggable ordered KV (`MemKV`, `FilesKV`, `SqlKV`). `scanSources` mirrors a file tree into a source collection. Breaking: `registerBuilder`, `readUpdates`, `yieldControl`, `restartFrom`, the built-in `SourceScanner` builder and the `sources-removed` collection are gone — declare `BuilderDef`s, call `scanSources`, and use `dispose` for clean-up.
  
  `webrun-modules-build` runs on the new engine: one `Preprocess` builder per source with `dispose` pruning removed sources' artifacts; `webrunBuilders(served)` now takes the build host and returns `BuilderDef`s, and `build()` returns every current entry.
  
  The engine is self-contained (its topology no longer comes from `webrun-dataflow`, which is removed from the workspace), and persistence is configuration: `createBuildEngine({ builders, persistence: { kind: "memory" | "files" | "sql" | "custom", … } })` / `openStore(config)`.
  
  Later in this release: verify-before-execute (read fingerprints; `RunStats.skipped`), commit-time re-checks so a write landing during a task is never lost, ownership hand-over from stale owners, incremental reduce builders (`incremental: true`, `ctx.changes`, `ctx.state`), and several engines per store (`shared: true` leases; `KV.commit` takes per-write `ifValue` conditions and returns which applied).
  
  Terminology: cells are now **builders** and signals are **collections** (to avoid clashing with cellb.dev) — `BuilderDef`, `BuildEngineOptions.builders`, `ctx.get(collection, key)`, `DeadLetter.builder`, `SOURCES_COLLECTION`, `scanSources({ collection })`; `webrun-modules-build` exports `webrunBuilders(host)`.

## 0.2.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-dataflow@0.1.3

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-dataflow@0.1.1
