# site-builder-demo

Browser-only demo that stitches together four webrun packages:

- [`@statewalker/webrun-site-builder`](../../packages/webrun-site-builder) — builds the site handler.
- [`@statewalker/webrun-http-browser`](../../packages/webrun-http-browser) — relay-mode ServiceWorker serving the site under a real URL.
- [`@statewalker/webrun-files-mem`](https://www.npmjs.com/package/@statewalker/webrun-files-mem) — two in-memory `FilesApi` instances, one for the client, one for the server.
- The browser's ESM `import()` — to dynamically load the server module served by the same site.

## What happens

1. The page opens a relay channel (`newRemoteRelayChannel`) which gives it a URL like `http://localhost:5173/…/public-relay/~DEMO_SITE`.
2. Two `MemFilesApi` instances are populated:
   - `clientFiles` → `/index.html`, `/style.css`, `/main.js` (the hosted "front-end").
   - `serverFiles` → `/api/index.js` (ES module exporting a default fetch handler).
3. A `SiteBuilder` mounts `clientFiles` under `/client`, `serverFiles` under `/server`, plus a dynamic endpoint:
   ```ts
   .setEndpoint("/api/*", async (request) => {
     const module = await import(`${siteBaseUrl}/server/api/index.js`);
     return module.default(request);
   })
   ```
4. The site handler is registered with the relay SW via `initHttpService`.
5. An iframe is pointed at `${siteBaseUrl}/client/` — the hosted `index.html` runs in the iframe, and its `main.js` fetches `./api/greet?name=…`.
6. That fetch hits the relay SW → routed back to the page → matches the `/api/*` endpoint → the page dynamically imports the server module (which is itself served via the same site — through the `/server` files mount, with the correct `text/javascript` MIME type) → invokes its default export → the response round-trips back to the iframe.

The only thing on disk next to this demo is `index.html`. Everything else is in memory, served through the site builder, and — for the dynamic part — evaluated in the browser after being fetched via `import()`.

## Run it

ServiceWorkers refuse to register from `file://` URLs, so you need an HTTP server. The app's `start` script boots a static server at the umbrella root so all three package `dist/` folders are reachable by URL:

```sh
pnpm --filter @statewalker/site-builder-demo run start
# or, shorter: (from this directory)
python3 -m http.server --directory ../../../.. 5173
```

Then open [http://localhost:5173/workspaces/webrun-wire/apps/site-builder-demo/](http://localhost:5173/workspaces/webrun-wire/apps/site-builder-demo/).

Make sure the three packages are built before you load the page:

```sh
pnpm --filter @statewalker/webrun-http-browser run build
pnpm --filter @statewalker/webrun-site-builder run build
# webrun-files-mem ships its own dist with the package
```

## What to watch for

- The right panel logs each step (relay opened, site mounted, iframe source).
- The iframe shows a small front-end with a text input. Typing in the input triggers a fetch to `./api/greet?name=…` — the response is the JSON produced by `server/api/index.js`, which is evaluated in the outer page through `import()`.
- Every `fetch` call you see in the iframe's network panel goes through the relay SW, not the network.

## Why this is interesting

The server-side code lives *inside the same site* as a plain `.js` file served by the same handler that routes everything else. No separate build step, no bundler, no CommonJS/ESM interop: the browser's native `import()` picks up the module because it's served with `Content-Type: text/javascript`. Swap the `MemFilesApi` for a `NodeFilesApi` or `S3FilesApi` and you get live-editable, hot-reloadable server code from disk/S3 with zero infrastructure.
