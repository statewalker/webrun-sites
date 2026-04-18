// Static resources for the hosted site.
//
// - `clientResources` — HTML/CSS/JS served under the site's `/client` prefix.
// - `serverResources` — server-side modules served under `/server`;
//   `_server.html`'s adapter dynamic-imports them per `/api/*` request.

export const clientResources: Record<string, string> = {
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
};

export const serverResources: Record<string, string> = {
  "/api/index.js": `export default async function handleRequest(request) {
  const url = new URL(request.url);
  const name = url.searchParams.get("name") ?? "anonymous";
  return Response.json({
    message: "Hello from the dynamically-imported server, " + name + "!",
    at: url.pathname,
    now: new Date().toISOString(),
  });
}`,
};
