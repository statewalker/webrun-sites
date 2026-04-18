import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import { SiteBuilder, type SiteHandler } from "@statewalker/webrun-site-builder";

const SITE_KEY = "demo";
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
  ServiceWorker and <code>SiteBuilder</code>. Every fetch below goes
  through the SW to the sibling <code>_server.html</code> iframe that
  dynamically imports <code>/demo/server/api/index.js</code>.</p>
  <label>Name: <input id="name" value="World"></label>
  <pre id="out">…</pre>
  <script type="module" src="./main.js"></script>
</body></html>`,
    "/style.css": `body { font-family: system-ui, sans-serif; margin: 1rem; }
h2 { color: navy; }
code { background: #f4f4f5; padding: 0 0.25rem; border-radius: 0.2rem; }
pre { background: #f4f4f5; padding: 0.5rem; border-radius: 0.25rem; }`,
    "/main.js": `const input = document.querySelector("#name");
const out = document.querySelector("#out");
async function refresh() {
  // The API lives at the site origin under /api/* (key "api"), registered
  // by the sibling _server.html iframe — absolute path, bypasses /demo/.
  const response = await fetch("/api/greet?name=" + encodeURIComponent(input.value));
  out.textContent = JSON.stringify(await response.json(), null, 2);
}
input.addEventListener("input", refresh);
refresh();`,
  });

  // --- server/ — dynamically-imported handler module. ---
  const serverFiles = new MemFilesApi();
  await populate(serverFiles, {
    "/api/index.js": `export default async function handleRequest(request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "anonymous";
  return Response.json({
    message: "Hello from the dynamically-imported server, " + name + "!",
    at: url.pathname,
    now: new Date().toISOString(),
  });
}`,
  });

  // --- register a same-origin ServiceWorker and mount the site. ---
  const adapter = new SwHttpAdapter({
    key: SITE_KEY,
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

  const registration = await adapter.register(`${SITE_KEY}/`, async (request) => {
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

  // --- bootstrap the /api service via a hidden 1x1 _server.html iframe. ---
  // `_server.html` sits next to index.html (served by Vite, not by the site);
  // its sole script registers the /api service with its own SwHttpAdapter.
  const serverFrame = document.createElement("iframe");
  Object.assign(serverFrame.style, {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    width: "1px",
    height: "1px",
    border: "none",
    opacity: "0",
  });

  const apiReady = new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== serverFrame.contentWindow) return;
      if ((event.data as { type?: unknown })?.type !== "api-ready") return;
      window.removeEventListener("message", onMessage);
      resolve();
    };
    window.addEventListener("message", onMessage);
    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("/_server.html did not report api-ready within 10s"));
    }, 10_000);
  });

  serverFrame.src = new URL("/_server.html", location.href).toString();
  document.body.appendChild(serverFrame);
  await apiReady;
  log("API service registered (key: api).");

  // --- now that /api is wired, show the client side of the hosted site. ---
  previewEl.src = `${baseUrl}client/`;
  log(`iframe → ${previewEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
