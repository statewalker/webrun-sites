import { MemFilesApi } from "@statewalker/webrun-files-mem";
import * as WebRunHttp from "@statewalker/webrun-http-browser";
import { SiteBuilder } from "@statewalker/webrun-site-builder";

const SERVICE_KEY = "DEMO_SITE";
const logEl = document.querySelector("#log");

const log = (msg, isError = false) => {
  const p = document.createElement("p");
  if (isError) p.className = "err";
  p.textContent = msg;
  logEl.appendChild(p);
};

async function populate(files, entries) {
  for (const [path, content] of Object.entries(entries)) {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    await files.write(path, [bytes]);
  }
}

try {
  logEl.innerHTML = "";

  // `vite-plugin-static-copy` places webrun-http-browser's `public-relay/`
  // under `/public-relay/` on the site origin. Pass `baseUrl` explicitly
  // because the bundled `import.meta.url` inside webrun-http-browser no
  // longer resolves to its original location.
  const connection = await WebRunHttp.newRemoteRelayChannel({
    baseUrl: new URL("/public-relay/", location.href),
  });
  log("Relay channel opened.");

  const siteBaseUrl = `${connection.baseUrl}~${SERVICE_KEY}`;

  // --- client/ — index.html + JS + CSS ---
  const clientFiles = new MemFilesApi();
  await populate(clientFiles, {
    "/index.html": `<!doctype html>
<html><head>
  <meta charset="utf-8">
  <title>Hosted client</title>
  <link rel="stylesheet" href="./style.css">
</head><body>
  <h2>Hosted in-browser site</h2>
  <label>Name: <input id="name" value="World"></label>
  <pre id="out">…</pre>
  <script type="module" src="./main.js"></scr${"ipt>"}
</body></html>`,
    "/style.css": `body { font-family: system-ui, sans-serif; margin: 1rem; }
h2 { color: navy; }
pre { background: #f4f4f5; padding: 0.5rem; border-radius: 0.25rem; }`,
    "/main.js": `const input = document.querySelector("#name");
const out = document.querySelector("#out");
async function refresh() {
  // Client lives at /client/, API at /api/* — escape the sub-path.
  const response = await fetch("../api/greet?name=" + encodeURIComponent(input.value));
  out.textContent = JSON.stringify(await response.json(), null, 2);
}
input.addEventListener("input", refresh);
refresh();`,
  });

  // --- server/api/index.js — default-export a fetch handler ---
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

  // The endpoint handler runs in *this* page, which is not under the relay
  // ServiceWorker's scope — so a direct `import(url)` would miss the SW and
  // hit the network with a 404. Instead we fetch the module source through
  // the same port that drives the service (`callHttpService` goes straight
  // to the handler, skipping the SW), wrap it in a `blob:` URL with
  // `text/javascript`, and let the browser's standard module loader take
  // it from there.
  async function importFromService(path) {
    const request = new Request(`${siteBaseUrl}${path}`);
    const response = await WebRunHttp.callHttpService(request, {
      key: SERVICE_KEY,
      port: connection.port,
    });
    if (!response.ok) throw new Error(`fetch ${path} → ${response.status}`);
    const source = await response.text();
    const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
      return await import(/* @vite-ignore */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  const siteHandler = new SiteBuilder()
    .setFiles("/client", clientFiles)
    .setFiles("/server", serverFiles)
    .setEndpoint("/api/*", async (request) => {
      const module = await importFromService("/server/api/index.js");
      return module.default(request);
    })
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();

  // The relay delivers each request with its original URL (including the SW
  // scope prefix and the `~DEMO_SITE` service segment). Rewrite to a
  // site-relative URL so the builder's pattern matchers see plain paths
  // like `/client/...` or `/api/...`.
  const rewriteToSiteRelative = (request) => {
    const relative = request.url.startsWith(siteBaseUrl)
      ? request.url.substring(siteBaseUrl.length) || "/"
      : new URL(request.url).pathname;
    const url = `http://site.local${relative.startsWith("/") ? "" : "/"}${relative}`;
    const init = {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      duplex: "half",
    };
    return new Request(url, init);
  };

  await WebRunHttp.initHttpService((request) => siteHandler(rewriteToSiteRelative(request)), {
    key: SERVICE_KEY,
    port: connection.port,
  });
  log(`Site mounted at ${siteBaseUrl}`);

  // Embed the client.
  const preview = document.querySelector("#preview");
  preview.src = `${siteBaseUrl}/client/`;
  log(`iframe → ${preview.src}`);
} catch (error) {
  log(`Fatal: ${error}`, true);
  console.error(error);
}
