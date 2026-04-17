# site-builder-demo

A Vite app that stitches together four webrun packages into a working browser demo:

- [`@statewalker/webrun-site-builder`](../../packages/webrun-site-builder) — builds the `(Request) ⇒ Response` site handler.
- [`@statewalker/webrun-http-browser`](../../packages/webrun-http-browser) — relay-mode ServiceWorker that exposes the handler at a real URL.
- [`@statewalker/webrun-files-mem`](https://www.npmjs.com/package/@statewalker/webrun-files-mem) — two in-memory `FilesApi` instances, one for the client, one for the server.
- The browser's `import()` — to dynamically load the server module served by the same site.

## What happens

1. The page opens a relay channel (`newRemoteRelayChannel`) which gives it a URL like `http://localhost:5173/public-relay/~DEMO_SITE`.
2. Two `MemFilesApi` instances are populated:
   - `clientFiles` → `/index.html`, `/style.css`, `/main.js` (the hosted "front-end").
   - `serverFiles` → `/api/index.js` (an ES module with a default fetch-handler export).
3. A `SiteBuilder` mounts `clientFiles` under `/client`, `serverFiles` under `/server`, plus a dynamic endpoint:
   ```js
   .setEndpoint("/api/*", async (request) => {
     const module = await importFromService("/server/api/index.js");
     return module.default(request);
   })
   ```
   `importFromService` fetches the module source through `callHttpService` (which talks to the handler over the same MessagePort, bypassing the SW), wraps the bytes in a `blob:` URL with `Content-Type: text/javascript`, and `import()`s that — the outer page is outside the SW scope, so a direct `import(siteUrl)` would hit the network and 404.
4. The site handler is registered with the relay SW via `initHttpService`. Inbound URLs are rewritten to a site-local form (stripping the SW scope + `~DEMO_SITE` prefix) before the builder's pattern matchers run.
5. An iframe is pointed at `${siteBaseUrl}/client/`; the hosted `index.html` runs inside it, and its `main.js` fetches `../api/greet?name=…`.
6. That fetch hits the relay SW → routed back to the outer page → matches the `/api/*` endpoint → the server module is loaded via `importFromService` → its default export is invoked → the response round-trips back to the iframe.

## Run it

```sh
# from this directory
pnpm install          # (once, at the workspace root)
pnpm run dev          # vite dev server on :5173
```

Open [http://localhost:5173/](http://localhost:5173/).

`vite-plugin-static-copy` copies `webrun-http-browser/public-relay/*` into the dev server's static assets under `/public-relay/`, which is where the relay SW + its HTML shim live.

### Production build

```sh
pnpm run build        # writes to dist/
pnpm run preview      # serves dist/ on :5173
```

## What to watch for

- The right panel logs each step (relay opened, site mounted, iframe source).
- The iframe shows a small front-end with a text input. Typing in it triggers a fetch to `../api/greet?name=…` — the response is the JSON produced by `server/api/index.js`, dynamically imported in the outer page on every request.
- Every `fetch` call in the iframe's network panel goes through the relay SW, not the network.

## Why this is interesting

The server-side code lives *inside the same site* as a plain `.js` file served by the same handler that routes everything else. No separate build step for the server, no bundler, no CommonJS/ESM interop: the browser's native `import()` picks it up because it's served with `Content-Type: text/javascript`. Swap the `MemFilesApi` for a `NodeFilesApi` or `S3FilesApi` and you get live-editable server code from disk or S3 with zero infrastructure.
