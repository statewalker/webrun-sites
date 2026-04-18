import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";

const SERVICE_KEY = "demo";
// Serve the SW from the site root so its default scope (`/`) covers the
// outer page too — `SwHttpAdapter.start()` waits for the page to be
// controlled, which only happens when the page URL is within the SW scope.
const SW_URL = new URL("/sw-worker.js", location.href).toString();

const logEl = document.querySelector<HTMLDivElement>("#log");
const previewEl = document.querySelector<HTMLIFrameElement>("#preview");
if (!logEl || !previewEl) throw new Error("demo layout missing");

function log(message: string, isError = false): void {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = message;
  logEl?.appendChild(p);
}

async function populate(files: FilesApi, entries: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(entries)) {
    await files.write(path, [new TextEncoder().encode(content)]);
  }
}

try {
  logEl.innerHTML = "";

  // --- client/ — HTML + CSS + JS served by the site. ---
  const clientFiles = new MemFilesApi();
  await populate(clientFiles, {
    "/index.html": `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Hosted client</title>
  <link rel="stylesheet" href="./style.css">
</head><body>
  <h2>Hosted in-browser site</h2>
  <p>Served from an in-memory <code>FilesApi</code> via a same-origin
  ServiceWorker and <code>SiteBuilder</code>.</p>
</body></html>`,
    "/style.css": `body { font-family: system-ui, sans-serif; margin: 1rem; }
h2 { color: navy; }
code { background: #f4f4f5; padding: 0 0.25rem; border-radius: 0.2rem; }`,
  });

  // --- server/ — declared in the site but not wired to any endpoint yet. ---
  const serverFiles = new MemFilesApi();
  await populate(serverFiles, {
    "/api/index.js": `// Placeholder server module for a future dynamic endpoint.
export default async function handleRequest(request) {
  return Response.json({
    message: "Hello from the future server!",
    at: new URL(request.url).pathname,
  });
}`,
  });

  // --- register a same-origin ServiceWorker and mount the site. ---
  const adapter = new SwHttpAdapter({
    key: SERVICE_KEY,
    serviceWorkerUrl: SW_URL,
  });
  await adapter.start();
  log("ServiceWorker activated.");

  // Build the handler; captures `baseUrl` via the closure once register resolves.
  let baseUrl = "";
  const site: SiteHandler = new SiteBuilder()
    .setFiles("/client", clientFiles)
    .setFiles("/server", serverFiles)
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();

  const registration = await adapter.register(`${SERVICE_KEY}/`, async (request) => {
    const relative = request.url.startsWith(baseUrl)
      ? request.url.substring(baseUrl.length) || "/"
      : new URL(request.url).pathname;
    const siteUrl = `http://site.local${relative.startsWith("/") ? "" : "/"}${relative}`;
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      // Allow streaming bodies on non-GET/HEAD; required by recent Fetch specs.
      duplex: "half",
    } as RequestInit & { duplex: "half" };
    return site(new Request(siteUrl, init));
  });
  baseUrl = registration.baseUrl;
  log(`Site mounted at ${baseUrl}`);

  // --- iframe shows the client side of the hosted site. ---
  previewEl.src = `${baseUrl}client/`;
  log(`iframe → ${previewEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
