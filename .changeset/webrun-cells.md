---
"@statewalker/webrun-cells": minor
---

New package: a SQLite-backed incremental cell engine. Signal rows, the work queue, provenance and dead letters live in SQL tables behind `SqlDriver`; cells are async generators whose pulled inputs commit atomically; unchanged outputs stop the cascade; outputs no longer produced are retracted.
