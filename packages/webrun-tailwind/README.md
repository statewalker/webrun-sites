# @statewalker/webrun-tailwind

## What it is

A build-only Tailwind CSS v4 transform for the `@statewalker/webrun-modules`
transform registry. It turns a project stylesheet that uses Tailwind
(`@import "tailwindcss"` or `@tailwind` directives) into a processed `.css`
artifact that contains every Tailwind utility class, styled with the project's
own theme.

## Why it exists

Tailwind normally scans the markup for class names and emits only those. The
modules pipeline has no markup to scan: pages are built from TS/TSX at run time,
and class names can be computed. This transform therefore emits the whole utility
set once, and the running markup uses what it needs.

Generation is slow and the output is large (about 23,000 classes with Tailwind
4.3.3), so it runs only in the batch build (`@statewalker/webrun-modules-build`),
where the result is cached, and never on a request.

## How to use

### Install

```sh
pnpm add @statewalker/webrun-tailwind
```

Runtime dependencies: `@statewalker/webrun-files`, `@statewalker/webrun-modules`
and `tailwindcss` (v4). No peer dependencies. Node only: the package reads
Tailwind's bundled CSS with `node:fs` and locates it with `node:module`.

### One entry point

`@statewalker/webrun-tailwind` (ESM, built to `dist/`; TypeScript sources in
`src/`) exports:

| Export | What it is |
| --- | --- |
| `newTailwindTransform()` | A `RegisteredTransform` with `inType: "tailwind-css"`, `outType: "css"`. |
| `generateTailwindCss(source, ctx, entryId)` | Generates the full stylesheet for an entry; the transform calls it. |
| `tailwindCacheKey(source)` | The version string folded into the build's cache key. |
| `TAILWIND_VERSION` | `"4.3.3"`, the version the cache key reports. |

### Register it on a transform registry

`@statewalker/webrun-modules-build` does this for you. A custom driver that builds
its own `PreprocessContext` registers it like this:

```ts
import { newDefaultTransformRegistry } from "@statewalker/webrun-modules";
import { newTailwindTransform } from "@statewalker/webrun-tailwind";

const transforms = newDefaultTransformRegistry();
transforms.register(newTailwindTransform());
// ctx.transforms = transforms
```

`preprocessModule` requires `ctx.transforms` to be set; without the Tailwind
entry, a Tailwind stylesheet is handled by the plain CSS transform.

## Examples

### `newTailwindTransform`: a project entry with a custom theme

Project file `/styles.css`:

```css
@import "tailwindcss";

@theme {
  --color-brand: #0a7;
}
```

When the build reaches `/styles.css`, `detectInputType` classifies it as
`tailwind-css` and the transform writes the generated stylesheet, including
utilities such as `bg-brand` and `text-brand`, to the cache at the entry's
emitted path, plus `<path>.exports.json`.

### `tailwindCacheKey`: version-keyed caching

```ts
import { tailwindCacheKey } from "@statewalker/webrun-tailwind";

tailwindCacheKey(source); // → "4.3.3" (or $TW_CACHE_VER when set)
```

The build hashes `tailwindCacheKey(source) + "\n" + source`, so an unchanged entry
reuses the cached multi-megabyte artifact.

## Internals

### Generation honors the entry's customizations

1. The entry source drives `__unstable__loadDesignSystem(…)`, so its `@theme`
   tokens, `@utility`/`@layer` rules and sibling `@import`s take effect.
   Tailwind's own CSS is read with `node:fs`; project `@import`s are read through
   `ctx.files`. `@import "tailwindcss"` is prepended when the source uses only
   `@tailwind` directives, because those alone load a partial utility set.
2. `getClassList()` enumerates every utility class name, including ones derived
   from custom tokens.
3. `compile(entry).build(classNames)` emits the stylesheet.
4. The result goes through the shared CSS transform (Lightning CSS), so it is
   processed the same way as any other stylesheet.

### Why the request-time server never runs it

The server's default registry has no `tailwind-css` entry. A Tailwind stylesheet
served at request time falls back (via `coarseBucket`) to the plain `css`
transform, so the server's output does not depend on whether this package is
installed.

### How a `.css` file is detected as Tailwind

`detectInputType` in `@statewalker/webrun-modules` classifies a `.css` as
`tailwind-css` when its content matches `/^\s*@tailwind\b/m` or
`/^\s*@import\s+["']tailwindcss["']/m`.

### What will surprise you

- **Subpath imports are not detected.** An entry with only
  `@import "tailwindcss/utilities"` is treated as plain CSS. Keep
  `@import "tailwindcss"` as a top-level rule.
- **Comments can trigger detection.** A line starting with `@tailwind` or
  `@import "tailwindcss"` inside a block comment still matches.
- **A sibling import is emitted twice.** `@import "./tokens.css"` in the entry is
  inlined into the generated stylesheet, and the build also emits `/~/tokens.css`
  on its own (unreferenced, harmless).
- **The cache key can lag the installed Tailwind.** `TAILWIND_VERSION` is the
  constant `"4.3.3"`, while the dependency range is `^4.3.3`. After an upgrade to a
  later 4.x, the cache key does not change, so cached stylesheets are not
  regenerated until the constant is updated (or `TW_CACHE_VER` is set).
- **Missing `ctx.files` fails project imports** with
  `webrun-tailwind: ctx.files required to resolve project @import`.

### Dependencies

`tailwindcss` (generation), `@statewalker/webrun-modules` (the
`RegisteredTransform` and `PreprocessContext` contract), `@statewalker/webrun-files`
(`readText`/`writeText` for project imports and output).

## License

MIT
