# site-builder-tsx-spike

## What it is

A spike on top of [`site-builder-demo`](../site-builder-demo) that
adds one thing: source-level transpilation of `.ts` and `.tsx` files
served from the in-memory site, so the browser's native module loader
can run them as-is.

**`ServeFilesOptions.transform` is a per-mount Response filter, and a
single sucrase-backed instance applied to both the `/client` and
`/server` mounts is all you need to serve `.ts` / `.tsx` source
directly to the browser as `text/javascript` — including the
dynamic-imported server handler.**

The same filter handles three cases uniformly:

- `client/main.tsx` — typed + JSX (transforms: `typescript` + `jsx`)
- `client/format.ts` — typed helper imported by `main.tsx` via
  explicit `.ts` extension
- `server/api/index.ts` — typed `(Request, env) → Response` handler, mounted
  with `setEndpoint("/api", newServerRunner("/server/api/index.ts", () => baseUrl, { greeting, service }))`
  and dynamic-imported through the same SW + transform pipeline.
  `newServerRunner` is the standalone `EndpointHandler` factory from
  `@statewalker/webrun-site-host`; its third argument is the env bag the
  module receives alongside the URL params on every call.

## Layout

```
/client/index.html       static
/client/style.css        static
/client/format.ts        TS  → transpiled by transform
/client/main.tsx         TSX → transpiled by transform (typescript + jsx)
/server/api/index.ts     TS  → transpiled by transform
/api                     newServerRunner endpoint → dynamic-imports
                         /server/api/index.ts as a module
```

All of the above sit under the site key, so the browser sees them as
`/tsx-spike/client/index.html`, `/tsx-spike/api`, and so on.

Wiring is in [`src/main.ts`](./src/main.ts); the transform is in
[`src/script-transform.ts`](./src/script-transform.ts).

## How to run it

1. From the repository root: `pnpm install` and `pnpm build`.
2. `pnpm --filter @statewalker/site-builder-tsx-spike dev` — Vite on
   <http://localhost:5174>.
3. Type in the Name field. Every keystroke fetches `/api`, runs the typed server
   handler, and renders the formatted response.

### Check it in DevTools

In Network, the response `Content-Type` for `client/main.tsx`,
`client/format.ts`, and `server/api/index.ts` is `text/javascript`,
and their bodies are transpiled JS (no `interface`, no `: type`
annotations).

In Console, `[script-transform]` logs once per script fetch — useful
for catching a stale-SW scenario where the filter never runs.

## Why it is the way it is

### Transpiling on the main thread keeps the ServiceWorker a relay

No bundler, no service-side build step, no SW-internal wasm. sucrase
is pure JS, runs on the main thread; the SW just relays. Output is
cached by source SHA-256 so repeated fetches don't re-transpile.

### What it deliberately does not do

- No virtual mount for npm packages and no CDN fetching of bare specifiers
  (`site-builder-jspm-demo` adds that).
- No import rewriting, no source maps, no HMR.
- No persistent cache: transpiled output lives in an in-memory `Map` keyed by
  the source's SHA-256.

## What will surprise you

### A stale ServiceWorker keeps serving old code

If the spike behaves as if old code is running, you have a stale SW
from a previous session. **DevTools → Application → Service Workers
→ Unregister**, then **Storage → Clear site data**, then hard reload.
Or just open the spike in a fresh Incognito/Private window.

## Reference

### Commands

Run from `apps/site-builder-tsx-spike/`: `pnpm run dev` (port 5174),
`pnpm run build`, `pnpm run preview` (port 5174), `pnpm run typecheck`.

### Dependencies

`sucrase` (the in-browser `.ts`/`.tsx` transpiler this app demonstrates),
`@statewalker/webrun-site-builder`, `@statewalker/webrun-site-host`,
`@statewalker/webrun-http-browser`, `@statewalker/webrun-files-mem`. Dev: `vite`,
`typescript`, `@statewalker/webrun-files`. Private, not published.
