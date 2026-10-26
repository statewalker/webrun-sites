# @statewalker/webrun-modules

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
