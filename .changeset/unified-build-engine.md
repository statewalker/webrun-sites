---
"@statewalker/webrun-builder": minor
"@statewalker/webrun-modules-build": minor
---

`webrun-builder` is rewritten as one key-level incremental engine (replacing the stage-level frontier scheduler and the private `webrun-cells`): cells over signals with tracked dynamic reads, early cut-off on unchanged values, automatic retraction with `dispose` hooks, glitch-free scheduling, retries and dead letters, group commit, and all state in a pluggable ordered KV (`MemKV`, `FilesKV`, `SqlKV`). `scanSources` mirrors a file tree into a source signal. Breaking: `registerBuilder`, `readUpdates`, `yieldControl`, `restartFrom`, the built-in `SourceScanner` cell and the `sources-removed` signal are gone — declare `CellDef`s, call `scanSources`, and use `dispose` for clean-up.

`webrun-modules-build` runs on the new engine: one `Preprocess` cell per source with `dispose` pruning removed sources' artifacts; `webrunBuilders` is replaced by `webrunCells(host)`, and `build()` returns every current entry.
