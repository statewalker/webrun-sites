---
"@statewalker/webrun-builder": minor
---

`BuildEngine.steps(opts)`: `run()` as an async generator — yields each committed batch's `RunProgress` and returns the run's `RunStats`. The engine waits at every `yield` (nothing is in flight), so a caller can pause between batches or stop with `break`; the next run continues from the queue. `run()` is now `steps()` drained; its behaviour is unchanged.
