# webrun-sites

## What it is

A pnpm workspace of libraries for building and hosting small web sites from
TypeScript sources, with no separate bundler step:

- an incremental build engine that redoes only the part of a build that changed;
- a module server that resolves npm packages and authored TS/JS into
  browser-runnable ESM and serves it from a local cache;
- a site builder that turns static files, endpoints and auth hooks into one
  `(Request) => Promise<Response>` handler, and a host that serves that handler
  from a same-origin ServiceWorker.

All file access goes through the `FilesApi` interface of `@statewalker/webrun-files`,
so the same code runs against a real file system, an in-memory tree, or browser
storage. The public packages are published to npm under `@statewalker/*`.

## Layout

```
packages/   published libraries
apps/       private demo apps (Vite), not published
tools/      private test harness (consumer-install)
```

| Package | Description | npm |
| --- | --- | --- |
| [`@statewalker/webrun-dataflow`](packages/webrun-dataflow) | Signal-driven dataflow graph: impact propagation, topological order, transaction and updates stores. No runtime dependencies. | [npm](https://www.npmjs.com/package/@statewalker/webrun-dataflow) |
| [`@statewalker/webrun-builder`](packages/webrun-builder) | `BuildEngine<THost>`: incremental, resumable build engine on top of `webrun-dataflow`, with a built-in source scanner and file-backed state. | [npm](https://www.npmjs.com/package/@statewalker/webrun-builder) |
| [`@statewalker/webrun-modules`](packages/webrun-modules) | Isomorphic module server: resolves, downloads and transforms npm packages and authored TS/JS into ESM, served from a `FilesApi` cache. | [npm](https://www.npmjs.com/package/@statewalker/webrun-modules) |
| [`@statewalker/webrun-modules-build`](packages/webrun-modules-build) | Batch module build: runs the `webrun-modules` transforms through `BuildEngine` and writes a static `.js`/`.css` tree. | [npm](https://www.npmjs.com/package/@statewalker/webrun-modules-build) |
| [`@statewalker/webrun-tailwind`](packages/webrun-tailwind) | Build-only Tailwind CSS v4 transform for the `webrun-modules` transform registry (Node only). | [npm](https://www.npmjs.com/package/@statewalker/webrun-tailwind) |
| [`@statewalker/webrun-site-builder`](packages/webrun-site-builder) | Builds a `(Request) => Promise<Response>` site handler from static files, endpoints and auth hooks. | [npm](https://www.npmjs.com/package/@statewalker/webrun-site-builder) |
| [`@statewalker/webrun-site-host`](packages/webrun-site-host) | Hosts a site handler behind a same-origin ServiceWorker in the browser. | [npm](https://www.npmjs.com/package/@statewalker/webrun-site-host) |
| [`@statewalker/site-builder-demo`](apps/site-builder-demo) | Private demo: `SiteBuilder` hosted by `HostedSiteBuilder` in the browser. | — |
| [`@statewalker/site-builder-tsx-spike`](apps/site-builder-tsx-spike) | Private demo: serves `.tsx` sources transpiled on the fly. | — |
| [`@statewalker/site-builder-jspm-demo`](apps/site-builder-jspm-demo) | Private demo: bare imports resolved in the browser with `@jspm/generator`. | — |
| [`@statewalker/p2p-demo`](apps/p2p-demo) | Private demo: HTTP between two browsers over libp2p (relay + WebRTC). | — |
| [`@statewalker/livekit-demo`](apps/livekit-demo) | Private demo: the same as `p2p-demo`, with LiveKit as the transport. | — |
| [`@statewalker/consumer-install-tests`](tools/consumer-install) | Private test harness: packs the packages and installs them into a clean consumer project. | — |

How the packages depend on each other:

```
webrun-dataflow ─► webrun-builder ─┐
webrun-modules ──► webrun-tailwind ┼─► webrun-modules-build
webrun-modules ────────────────────┘

webrun-site-builder ─► webrun-site-host ─► apps/*
```

External `@statewalker` dependencies, by package name:

- `@statewalker/webrun-files` (every package except `webrun-dataflow`; a peer dependency of
  `webrun-site-builder` and `webrun-site-host`), `@statewalker/webrun-files-mem`,
  `@statewalker/webrun-files-node` (dev only);
- `@statewalker/webrun-http-browser` (`webrun-site-host` and the demos);
- `@statewalker/webrun-http-streams`, `@statewalker/webrun-streams`,
  `@statewalker/webrun-streams-libp2p`, `@statewalker/webrun-streams-livekit`
  (`p2p-demo` and `livekit-demo` only).

## How to run it

Requirements: Node.js 24 and pnpm 10 through corepack (the exact version is pinned
by `packageManager` in `package.json`).

1. `corepack enable`
2. `pnpm install`
3. `pnpm build` — builds every package. Tests and typechecks import the built
   `dist/` of their workspace dependencies, so build first.
4. `pnpm test` — runs every package's tests, including `tools/consumer-install`
   (see below). For one package: `pnpm --filter @statewalker/webrun-modules test`.
5. Before pushing: `pnpm lint:check` and `pnpm format:check` (the same checks CI runs).

To run a demo, see its README under `apps/`.

## Why it is the way it is

- **Packages export `dist/`, not TypeScript.** Each `exports` entry has
  `types` and `import` pointing at `dist/`, plus a `source` condition pointing at
  `src/`. Node does not strip types from files under `node_modules`, so a package
  that exported `.ts` could not be imported by a plain Node consumer. `src/` is
  still published for the `source` condition and for reading.
- **Internal dependencies use `workspace:^`.** Locally it links the sibling; when
  packed it becomes a caret range (`^0.2.0`), so consumers can take compatible
  patches. External versions come from the pnpm catalogs in `pnpm-workspace.yaml`
  (`catalog:`; `catalog:peers` for peer ranges).
- **`@statewalker/webrun-files` is a peer dependency of the site packages.** The
  `FilesApi` a site serves is created by the application; two copies of the
  package would give two incompatible type identities. The peer range is
  `^0.9.0 || ^0.10.0`.
- **`tools/consumer-install` exists** because in-repo consumers resolve siblings
  through workspace links and never see what npm users get. The harness packs each
  package with its workspace closure, installs the tarballs with npm into a scratch
  project and imports every exported subpath.

## What will surprise you

- **`pnpm test` takes minutes.** `tools/consumer-install` runs `pnpm pack` (and so
  each package's `prepack` build) and a real `npm install` per package. Its test
  timeout is 15 minutes. Filter to a package when you do not need it.
- **`webrun-site-host` imports under Node, but only works in a browser.**
  `HostedSiteBuilder.build()` registers a ServiceWorker. The consumer-install
  harness marks its entry browser-only and skips the import check for it.
- **Some packages have no `typecheck` or `format` script.** `webrun-modules`,
  `webrun-site-builder` and `webrun-site-host` build declarations with
  `tsc --emitDeclarationOnly` during `build` and lint only `src` and `tests`;
  `pnpm typecheck` skips them.

## Reference

### Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | `pnpm -r run build` |
| `pnpm test` | `pnpm -r run test` |
| `pnpm typecheck` | `pnpm -r run typecheck` |
| `pnpm lint` | `biome check --write .` |
| `pnpm lint:check` | `biome check .` |
| `pnpm lint:fix` | `biome check --write --unsafe .` |
| `pnpm format` | `biome format --write .` |
| `pnpm format:check` | `biome format .` |
| `pnpm changeset` | add a changeset (bump level and changelog text) |

### Continuous integration and releases

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests: a
frozen install, a check that internal dependencies use `workspace:^` and external
ones use the catalog, lint, format, build, typecheck and tests, then checks that
every `exports` target exists, every bare import in `dist/` is a declared
dependency, and packed manifests contain no `workspace:` or `catalog:` specifiers.

Packages are published to npm from CI with changesets: changed packages get a
version pull request, and merging it publishes them with npm provenance. Add a
changeset yourself (`pnpm changeset`) to choose the bump level or the changelog
text. Dependency updates come from Renovate.

### Configuration files

| File | Purpose |
| --- | --- |
| `pnpm-workspace.yaml` | workspace globs and the dependency catalogs |
| `biome.json` | lint and format rules (root config) |
| `turbo.json` | task graph for `turbo` (`build` before `test`) |
| `tsconfig.base.json` | shared TypeScript options |
| `rolldown.preset.js` | shared rolldown config for packages built with rolldown |
| `.changeset/config.json` | changesets configuration |

### License

MIT. See [LICENSE](LICENSE).
