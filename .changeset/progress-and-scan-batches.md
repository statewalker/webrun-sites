---
"@statewalker/webrun-builder": patch
---

`run({ onProgress })` reports each committed batch (`RunProgress`: builder, tasks, executed, skipped, failed, deadLettered), and `scanSources({ limit })` writes at most `limit` changed files per scan, reporting the rest as `deferred`, so a large corpus can flow through the pipeline batch by batch.
