---
"@statewalker/webrun-modules": patch
---

`proxyId` (through `depsRoot`) throws for an importer id that is neither a project id (`~/…`) nor a package id (`{name}@{version}/…`), instead of returning a rootless proxy path that the routing guards do not recognise (#5). A proxy's accumulated shape is replaced, never mutated, when it grows, so a reader holding an earlier entry keeps a consistent snapshot.
