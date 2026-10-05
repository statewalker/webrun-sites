# @statewalker/webrun-modules-build

## What it is

A batch module builder. It reads a project tree from one `FilesApi`, runs every
source through the `@statewalker/webrun-modules` preprocess core, and writes a
static tree of `.js` (and `.css`) files to a second `FilesApi`. The build runs on
`@statewalker/webrun-builder`'s `BuildEngine`, so a second build after an edit
re-transforms only what changed.

## Why it exists

`@statewalker/webrun-modules` transforms modules when they are requested. That
needs a running server (or ServiceWorker) in front of the files. This package
produces the same transformed modules ahead of time, as plain files that any
static file server can serve. Every emitted module ends in `.js`, so the output
needs no content-type mapping for `.ts`, `.tsx` or `.css` imports.

It is also where the Tailwind transform (`@statewalker/webrun-tailwind`) is
registered. Tailwind generation reads files with `node:fs` and produces
multi-megabyte output, which suits a build and not a request.

## How to use

### Install

```sh
pnpm add @statewalker/webrun-modules-build
```

Runtime dependencies: `@statewalker/webrun-builder`, `@statewalker/webrun-dataflow`,
`@statewalker/webrun-files`, `@statewalker/webrun-modules`,
`@statewalker/webrun-tailwind`. No peer dependencies.

### One entry point, for Node

`@statewalker/webrun-modules-build` has one entry point (ESM, built to `dist/`;
TypeScript sources in `src/`). It depends on `@statewalker/webrun-tailwind`, which
imports `node:fs` and `node:module`, so use it under Node.

Exports: `newProjectBuild` (with the types `ProjectBuild` and
`ProjectBuildOptions`), `webrunBuilders` (the cell set, for driving your own
`BuildEngine`), `makeExtMapPolicy` (the URL policy) and the `WebrunBuildHost`
type.

### Build a project into a cache

```ts
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { newProjectBuild } from "@statewalker/webrun-modules-build";

const project = new MemFilesApi();
const cache = new MemFilesApi();
await writeText(project, "/main.ts", `import { u } from "./util.ts";\nexport const out: string = u;`);
await writeText(project, "/util.ts", `export const u = "x";`);

const { served } = await newProjectBuild({ project, cache }).build();
// served → ["/~/main.js", "/~/util.js"]
// cache "/~/main.js" → `import { u } from "./util.js";\nexport const out = u;`
```

Options (`ProjectBuildOptions`):

| Option | Default | Purpose |
| --- | --- | --- |
| `project` | required | Source tree. Scanned by the engine, read by the core. |
| `cache` | required | Output tree: emitted modules, raw package cache, `/lock.json`. |
| `target` | `"browser"` | Build target; selects `exports` conditions. |
| `sources` | `[npmRegistrySource()]` | Where external packages come from. |
| `transform` | `newDefaultTransform()` | JS/TS transform. |
| `css` | `newDefaultCssTransform()` | CSS transform. |
| `depsFolder` | `"~deps"` | Name of the per-module-root dependency proxy folder. |

## Examples

### `newProjectBuild`: rebuild after an edit

```ts
const build = newProjectBuild({ project, cache });
await build.build();

await writeText(project, "/util.ts", `export const u = "y";`);
await build.build(); // re-transforms util.ts; main.ts is reused from the cache
```

### `makeExtMapPolicy`: the URL policy on its own

`makeExtMapPolicy(ctx)` takes a `PreprocessContext` from `@statewalker/webrun-modules`
and returns the `UrlPolicy` the build uses: JS-family files and `.json` map to
`.js`, a stylesheet imported from JS maps to a `.js` injector, and nothing gets a
`?module` suffix. Use it when you build your own context instead of calling
`newProjectBuild`.

## Internals

### The pipeline is four cells on top of the scanner

```
scanner → sources → [Classify] → module/css/json → [Preprocess] → served → [Serve]
          sources-removed → [Prune]
```

- **Classify** routes each scanned source to a `module` / `css` / `json` signal
  by extension. Other files are dropped.
- **Preprocess** walks the entry's transitive closure via `walkFrom`, emitting the
  entry and project dependencies as `.js`, plus the `~deps` proxy bodies and
  resolved npm endpoints as side effects into `cache`, then wraps JSON/CSS ids into
  their static `.js` forms.
- **Prune** removes a deleted source's emitted artifact and its sidecars.
- **Serve** collects the emitted entry paths returned by `build()`.

No cell outputs its own input signal: that would create a cycle for the
frontier scheduler.

### A content hash decides what is re-transformed

`newProjectBuild` installs a `ctx.skipTransform` hook that `walkFrom` consults for
every node of the closure (entry, interior and shared). It reuses the emitted
artifact when the source hashes (FNV-1a, 32-bit) to the value in the
`<artifact>.hash` sidecar and the artifact still exists. Editing a root
re-transforms only the root, and a diamond transforms its shared node once, not
once per path. For Tailwind inputs the hash also covers the Tailwind version, so
upgrading Tailwind regenerates the stylesheet even when the entry is unchanged.

### CSS is emitted in three forms

- **CSS imported from JS becomes a `.js` injector.** `import "./styles.css"` from
  JS becomes one `cssModuleWrapper` `.js` that injects a `<style>`.
- **`@import`-chained CSS is written as a real `.css` file.** `@import "./other.css"`
  keeps its `.css` specifier; the chained stylesheet is written as a `.css` at its
  `urlPath` (next to its `.js` form) so the `@import` resolves.
- **`url()` assets are copied.** `url("./logo.png")` targets are copied unchanged
  to their path in the cache.

### What will surprise you

- **The build writes into `project`.** Engine state lives in
  `/.project/state/` of the project tree (`updates.json`, `transactions.json`,
  `scanner.json`). A read-only project `FilesApi` fails on the first build.
- **`project` and `cache` must be different objects.** Passing the same instance
  throws ``newProjectBuild: `project` and `cache` must be distinct FilesApi instances``:
  the scanner would read the emitted tree back as sources.
- **`served` accumulates across calls.** Calling `build()` twice on the same
  `ProjectBuild` returns the paths of both runs, so a re-emitted entry appears
  twice (`["/~/main.js", "/~/util.js", "/~/util.js"]`). Create a new
  `ProjectBuild` per run if you need only that run's output.
- **Files in dot-folders are not built.** The scanner skips every path with a
  segment starting with `.`.
- **The build is silent.** The engine runs with `NULL_LOGGER`; errors surface only
  as the rejection of `build()`.

### Dependencies

`@statewalker/webrun-builder` and `@statewalker/webrun-dataflow` run the
pipeline; `@statewalker/webrun-modules` does the resolving and transforming;
`@statewalker/webrun-tailwind` adds the Tailwind transform;
`@statewalker/webrun-files` provides `FilesApi` helpers.

## License

MIT
