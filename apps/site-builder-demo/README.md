# site-builder-demo

A Vite + TypeScript app that shows a hosted client side of a
`SiteBuilder`-composed site running behind a same-origin
`@statewalker/webrun-http-browser` ServiceWorker.

## Layout

- [`@statewalker/webrun-site-builder`](../../packages/webrun-site-builder) composes the `(Request) ⇒ Response` handler.
- [`@statewalker/webrun-http-browser/sw`](../../packages/webrun-http-browser) (`SwHttpAdapter`) registers the handler with a same-origin SW so same-origin `fetch()` calls hit it.
- [`@statewalker/webrun-files-mem`](https://www.npmjs.com/package/@statewalker/webrun-files-mem) backs both `client/` (the hosted page + stylesheet) and `server/` (a placeholder module for a future dynamic endpoint — declared in the site but not wired up yet).

## What happens

1. The page registers `/sw/sw-worker.js` (copied out of `webrun-http-browser/dist/` by `vite-plugin-static-copy`) via `SwHttpAdapter`. Scope is `/sw/` — only requests under that path are intercepted by the SW, so Vite's own HMR and asset URLs are untouched.
2. Two `MemFilesApi` instances are populated: `clientFiles` (`index.html`, `style.css`) and `serverFiles` (placeholder `api/index.js`).
3. `SiteBuilder` mounts `clientFiles` under `/client` and `serverFiles` under `/server`, with a default `setErrorHandler` that pipes failures into the on-page log.
4. The handler is registered at `demo/` on the adapter, yielding `baseUrl = /sw/demo/`. The registration wrapper rewrites each incoming `request.url` from the SW form (`/sw/demo/...`) to a site-local form (`http://site.local/...`) so the builder's pattern matchers see plain `/client/*` paths.
5. The iframe on the page is pointed at `${baseUrl}client/` — the SW intercepts every fetch inside it and routes to the site handler.

## Run it

```sh
pnpm install            # at the workspace root
pnpm run dev            # vite dev server on :5173
# or, a production build:
pnpm run build
pnpm run preview
# type-checking without emitting:
pnpm run typecheck
```

Open [http://localhost:5173/](http://localhost:5173/).

## What to watch for

- The right panel logs each step (SW activated, site mounted, iframe source).
- The iframe shows the hosted client page — served entirely from in-memory `MemFilesApi` content through the SW.
- No network traffic for the iframe content (check the DevTools network panel: every request shows `from ServiceWorker`).

## Why it's set up this way

- **TypeScript** gives the app-side code the same typing story as the packages it consumes. `tsc --noEmit` catches issues Vite's esbuild silently transpiles past.
- **Scope under `/sw/`** keeps the demo self-contained and avoids the SW intercepting Vite's dev-server URLs.
- **Server files declared but not wired** keeps the structure ready for a dynamic `setEndpoint` that imports from `serverFiles` — the mount point exists; the handler will be added in a follow-up change.
