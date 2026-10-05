# @statewalker/webrun-site-host

## What it is

A browser-side host for a `SiteHandler = (Request) => Promise<Response>`.
`HostedSiteBuilder` registers a same-origin ServiceWorker, mounts the handler
under `<origin>/<siteKey>/`, rewrites each intercepted request to site-relative
form and passes it to the handler. Anything inside the browser that fetches from
that URL — an iframe, `fetch`, `import()` — is answered by your handler, with no
server.

## Why it exists

A `SiteHandler` (usually built with `@statewalker/webrun-site-builder`) says
*what* a site does. Running it in a browser needs ServiceWorker registration,
activation, URL prefixing and request rewriting, which are the same for every
site. This package does that part in one call, so the site definition stays free
of host code and the same handler also runs under Node, Deno, Bun, Workers or a
`DuplexSiteBuilder` (`@statewalker/webrun-http-streams`).

## How to use

### Install

```sh
pnpm add @statewalker/webrun-site-host @statewalker/webrun-files
```

`@statewalker/webrun-files` is a **peer dependency** (`^0.9.0 || ^0.10.0`).
Runtime dependencies: `@statewalker/webrun-site-builder`,
`@statewalker/webrun-http-browser` (the ServiceWorker adapter) and
`@statewalker/webrun-files-mem`.

One entry point, `@statewalker/webrun-site-host` (ESM, built to `dist/`;
TypeScript sources in `src/`). Browser only: it needs `navigator.serviceWorker`
and therefore a secure context (`https://` or `localhost`).

### Serve the ServiceWorker script at `/sw-worker.js`

The ServiceWorker runtime ships in `@statewalker/webrun-http-browser` as the
`./sw-worker` export (`dist/sw-worker.js`). Your app must serve that file at
`/sw-worker.js` on the page's origin (or at the URL passed to
`setServiceWorkerUrl`). Serving it from the origin root gives the worker scope
`/`; the demo apps in this repository do it with a small Vite plugin that also
sends `Service-Worker-Allowed: /`.

### Host a handler

```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";

const clientFiles = new MemFilesApi({
  initialFiles: { "/index.html": "<!doctype html><h1>Hello</h1>" },
});

const handler = new SiteBuilder()
  .setEndpoint("/api/time", () => new Response(new Date().toISOString()))
  .setFiles("/", clientFiles, { directoryIndex: "index.html" })
  .build();

const site = await new HostedSiteBuilder()
  .setSiteKey("demo")
  .setHandler(handler)
  .build();

iframe.src = site.baseUrl; // e.g. https://localhost:5173/demo/
// later: await site.stop();
```

### API

```ts
class HostedSiteBuilder {
  constructor(options?: HostedSiteBuilderOptions);
  setSiteKey(key: string): this;          // default: crypto.randomUUID()
  setServiceWorkerUrl(url: string): this; // default: /sw-worker.js on the current origin
  setHandler(handler: SiteHandler): this; // required
  build(): Promise<HostedSite>;
}

interface HostedSite {
  readonly siteKey: string;
  readonly baseUrl: string;
  stop(): Promise<void>;
}

interface HostedSiteBuilderOptions {
  adapterFactory?: AdapterFactory; // replaces the ServiceWorker adapter (tests use a fake)
}
```

Also exported: `newServerRunner`, `resolveFilesSource`, and the types
`FilesSource`, `SiteAdapter`, `SiteAdapterRegistration` and `AdapterFactory`.

## Examples

### `newServerRunner`: an endpoint that is a module served by the site itself

```ts
import { SiteBuilder } from "@statewalker/webrun-site-builder";
import { HostedSiteBuilder, newServerRunner } from "@statewalker/webrun-site-host";

let getBaseUrl = () => "";
const handler = new SiteBuilder()
  .setFiles("/server", serverFiles)
  .setEndpoint("/api", newServerRunner("/server/api/index.js", () => getBaseUrl()))
  .build();

const site = await new HostedSiteBuilder().setHandler(handler).build();
getBaseUrl = () => site.baseUrl;
```

`newServerRunner(modulePath, getBaseUrl, env?)` imports
`${getBaseUrl()}${modulePath}` on each request and calls its default export with
`(request, env)`. `env` is the endpoint env, then the runner's `env`, with the
request's `params` always last. A module without a default export answers
`500 Module <path> has no default export`.

### Forward every request to a remote peer

Because the handler is a function, it can forward requests over any
`webrun-streams-*` transport:

```ts
import { fetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect } from "@statewalker/webrun-streams-ws";
import { HostedSiteBuilder } from "@statewalker/webrun-site-host";

const { call } = await connect({ url: "wss://peer.example" });
const site = await new HostedSiteBuilder()
  .setHandler((request) => fetchOverDuplex(call, request))
  .build();

iframe.src = site.baseUrl; // every fetch inside the iframe goes to the peer
```

`apps/livekit-demo/client-page/main.ts` and `apps/p2p-demo/client-page/main.ts`
use this pattern with LiveKit and libp2p.

### `resolveFilesSource`: accept a `FilesApi` or a plain map

```ts
import { resolveFilesSource } from "@statewalker/webrun-site-host";

const files = await resolveFilesSource({ "/index.html": "<h1>Hi</h1>" }); // → MemFilesApi
```

A `FilesApi` is returned as is. `HostedSiteBuilder` itself never calls it; it is
for callers whose own API accepts either form.

## Internals

### What `build()` does

1. Resolve the site key (`crypto.randomUUID()` if not set) and the ServiceWorker
   URL (`/sw-worker.js` on the current origin if not set).
2. Create the adapter (`SwHttpAdapter` from `@statewalker/webrun-http-browser/sw`
   by default) and start it: it registers the ServiceWorker and waits for it to
   control the page.
3. Register a handler under `<siteKey>/` that strips that prefix from
   `request.url` and calls your handler.
4. Return `{ siteKey, baseUrl, stop }`. `stop()` removes the registration first,
   then stops the adapter.

### What will surprise you

- `build()` without `setHandler` throws
  `HostedSiteBuilder.build: setHandler(handler) must be called before build()`.
- **Sites on one origin need distinct keys.** The key is the URL prefix of the
  site.
- **If `/sw-worker.js` is not served,** ServiceWorker registration fails and
  `build()` rejects. With a dev server that returns `index.html` for unknown
  paths, the browser reports that the script has an unsupported MIME type
  (`text/html`).
- **Your handler sees `http://site.local/...` URLs.** Requests are rebuilt with
  that origin and the site-relative path. Use `site.baseUrl` when you need the
  real URL.
- **Node can import the package, but cannot run `build()`**: there is no
  `navigator.serviceWorker`. Under Node, use the `SiteHandler` directly.

### Dependencies

| Dependency | Kind | Why |
| --- | --- | --- |
| `@statewalker/webrun-site-builder` | runtime | The `SiteHandler`, `EndpointHandler` and `EndpointEnv` types. |
| `@statewalker/webrun-http-browser` | runtime | `SwHttpAdapter`: ServiceWorker registration and dispatch. |
| `@statewalker/webrun-files-mem` | runtime | The in-memory `FilesApi` that `resolveFilesSource` creates. |
| `@statewalker/webrun-files` | peer | The `FilesApi` interface. |

## License

MIT © statewalker — see [LICENSE](../../LICENSE).
