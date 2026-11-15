# @statewalker/webrun-site-host

## 0.6.0

### Minor Changes

- 79a0d0d: Move the runtime dependency `@statewalker/webrun-http-browser` from `^0.16.0` to `^0.17.0` (on `@statewalker/webrun-rpc` 0.15). The page side and the ServiceWorker script served at `/sw-worker.js` must run the same webrun-http-browser line, so apps upgrading to this version also serve `sw-worker.js` from webrun-http-browser 0.17.

## 0.5.0

### Minor Changes

- a348487: Moves to webrun-wire's current line: `@statewalker/webrun-http-browser` ^0.7.0 -> ^0.16.0 (statewalker/statewalker-root#69).
  
  The page side of `SwHttpAdapter` now speaks webrun-rpc 0.14's port stack, so the ServiceWorker script an app serves at `/sw-worker.js` must come from `@statewalker/webrun-http-browser` 0.16 too: keep the page and the worker on the same webrun-http-browser line, since webrun-rpc's wire format changed across these versions. The adapter also routes a request to the longest registered prefix, on whole path segments only, and rebuilds request urls with the page's scheme (https pages no longer get 404 from their own handler). No API change in this package.

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-files-mem ^0.10.0 -> ^0.12.0
  - @statewalker/webrun-files (peer) ^0.9.0 || ^0.10.0 -> ^0.12.0

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-site-builder@0.3.0

## 0.3.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/webrun-http-browser ^0.6.0 -> ^0.7.0

## 0.2.5

### Patch Changes

- e870564: Request bodies reach the handler in Firefox. Firefox has no `Request.body`, so the rebuilt site-relative request lost its body; it now carries the body read whole.

## 0.2.4

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
  - @statewalker/webrun-site-builder@0.2.2

## 0.2.0

### Minor Changes

- 89922b5: Widen the `@statewalker/webrun-files` peer range to `^0.9.0 || ^0.10.0`.

  Both packages pinned `peer @statewalker/webrun-files@^0.9.0`, which excludes the
  current 0.10.0 release: `npm i @statewalker/webrun-site-host
@statewalker/webrun-files@0.10.0` failed outright with `npm error ERESOLVE unable
to resolve dependency tree`. The range now admits both releases, so that install
  succeeds.

  Adds a consumer-install test harness (`tools/consumer-install`) that packs each
  package plus its transitive workspace-dependency closure, installs the tarballs
  as an external npm consumer would, imports every declared export subpath under
  plain Node, and checks every file the published exports map names actually ships.

  **Known remaining caveat — this changeset does not fix it.** `webrun-site-host`
  still declares a runtime dependency `@statewalker/webrun-files-mem: "catalog:"`,
  which the catalog resolves to `^0.9.0`; `@statewalker/webrun-files-mem@0.9.0` in
  turn hard-pins `@statewalker/webrun-files` at exactly `0.9.0`. So installing
  `webrun-site-host` alongside `webrun-files@0.10.0` now produces no ERESOLVE, but
  npm nests a second copy of `webrun-files@0.9.0` under `webrun-files-mem` — which
  defeats the single-shared-instance guarantee the peer dependency exists to
  express. Bumping the catalog entry (and republishing `webrun-files-mem` against a
  range rather than a pin) is a separate decision, tracked separately.

### Patch Changes

- Updated dependencies [89922b5]
  - @statewalker/webrun-site-builder@0.2.0

## 0.1.7

### Patch Changes

- Updated dependencies [8b789ef]
  - @statewalker/webrun-http-browser@0.6.0

## 0.1.6

### Patch Changes

- Updated dependencies [8bf5ee6]
  - @statewalker/webrun-http-browser@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies
  - @statewalker/webrun-site-builder@0.1.2

## 0.1.4

### Patch Changes

- @statewalker/webrun-http-browser@0.4.2

## 0.1.3

### Patch Changes

- @statewalker/webrun-http-browser@0.4.1

## 0.1.2

### Patch Changes

- Updated dependencies [2291ab3]
- Updated dependencies [ff650fc]
- Updated dependencies [c6dc18d]
  - @statewalker/webrun-http-browser@0.4.0

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/webrun-http-browser@0.3.4
  - @statewalker/webrun-site-builder@0.1.1
