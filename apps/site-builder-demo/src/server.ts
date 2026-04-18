// Runs inside the hidden `_server.html` iframe. Registers an `/api` service
// on the same-origin ServiceWorker whose handler defers to the module at
// `/demo/server/api/index.js` (served by the main site's `SiteBuilder`).
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";

const SERVICE_KEY = "api";
const SW_URL = new URL("/sw-worker.js", location.href).toString();
const MAIN_SITE_BASE_URL = new URL("/demo/", location.href).toString();

const adapter = new SwHttpAdapter({
  key: SERVICE_KEY,
  serviceWorkerUrl: SW_URL,
});
await adapter.start();

await adapter.register(`${SERVICE_KEY}/`, async (request) => {
  try {
    const { default: handler } = await import(
      /* @vite-ignore */ `${MAIN_SITE_BASE_URL}server/api/index.js`
    );
    return handler(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(message, { status: 500 });
  }
});

window.parent?.postMessage({ type: "api-ready" }, "*");
