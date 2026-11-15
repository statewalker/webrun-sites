# @statewalker/webrun-modules

## 0.4.0

### Minor Changes

- 8c72b59: A missing module file fails instead of becoming an empty module (#9). A package whose manifest (`exports`, `browser`, `module` or `main`) names a file it does not ship is rejected at resolution, with the package, the subpath and the declared target in the error. New option `onMissingFile(id)` on `newModuleServer` and `newProjectBuild`: a returned string is used as the missing file's source; `undefined`, or no option, keeps the failure. Builds that emitted empty modules for missing files now fail.

### Patch Changes

- e45095a: `proxyId` (through `depsRoot`) throws for an importer id that is neither a project id (`~/…`) nor a package id (`{name}@{version}/…`), instead of returning a rootless proxy path that the routing guards do not recognise (#5). A proxy's accumulated shape is replaced, never mutated, when it grows, so a reader holding an earlier entry keeps a consistent snapshot.
- 908c8a4: A proxy whose `.shape.json` sidecar is missing or corrupt (a cache from before the sidecars, or one edited by hand) is seeded from the exports of its emitted body, so the first build against such a cache no longer narrows a shared `host` proxy to the importers it walks (#3).
  
  A `host` proxy exports a reserved-word name (`delete`) in alias form instead of `export const delete`, which did not parse.

## 0.3.6

### Patch Changes

- 54e2f6a: A provided Node builtin covers both spellings: registering `node:crypto` also serves a bare `crypto` import, and the reverse.

## 0.3.5

### Patch Changes

- 197f670: A host-provided `node:*` module now wins over the built-in `@jspm/core` polyfill, as other provided names already did.

## 0.3.4

### Patch Changes

- 64e3f0e: A namespace-only import (`import * as X from "…"`) of a host-provided module now exposes the instance's members: the proxy exports one binding per own key of the server's registry entry, plus `default`. Before, such a proxy exported nothing and every `X.member` was `undefined`.

## 0.3.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md

## 0.2.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
