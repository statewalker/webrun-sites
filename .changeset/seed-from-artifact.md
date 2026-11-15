---
"@statewalker/webrun-modules": patch
---

A proxy whose `.shape.json` sidecar is missing or corrupt (a cache from before the sidecars, or one edited by hand) is seeded from the exports of its emitted body, so the first build against such a cache no longer narrows a shared `host` proxy to the importers it walks (#3).
