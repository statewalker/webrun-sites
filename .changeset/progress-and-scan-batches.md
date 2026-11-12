---
"@statewalker/webrun-builder": patch
---

`run({ onProgress })` reports each committed batch (`RunProgress`: builder, tasks, executed, skipped, failed, deadLettered), and `scanSources({ limit, after })` writes at most `limit` changed files per scan and reports `more` and a `cursor` to resume after, so a large corpus flows through the pipeline batch by batch (the rotating start keeps a constantly changing file from starving the rest). `onProgress` errors are logged, never propagated; `RunProgress.released` counts claims given back as stale.
