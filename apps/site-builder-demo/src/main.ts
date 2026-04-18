import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SwHttpAdapter } from "@statewalker/webrun-http-browser/sw";
import {
  SiteBuilder,
  type SiteHandler,
} from "@statewalker/webrun-site-builder";
import { clientResources, serverResources } from "./site.js";

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

async function populate(
  files: FilesApi,
  entries: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(entries)) {
    await files.write(path, [new TextEncoder().encode(content)]);
  }
}

try {
  logEl.innerHTML = "";

  // --- client/ + server/ — file contents live in ./site.ts ---
  const clientFiles = new MemFilesApi();
  await populate(clientFiles, clientResources);
  const serverFiles = new MemFilesApi();
  await populate(serverFiles, serverResources);

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
    .setEndpoint("/api", async (request) => {
      try {
        const { default: handler } = await import(
          /* @vite-ignore */ `${baseUrl}server/api/index.js`
        );
        return handler(request);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(message, { status: 500 });
      }
    })
    .setErrorHandler((error, request) => {
      log(`Error in ${request.method} ${request.url}: ${error}`, true);
      return new Response(String(error), { status: 500 });
    })
    .build();

  const registration = await adapter.register(
    `${SITE_KEY}/`,
    async (request) => {
      const siteUrl = request.url.startsWith(baseUrl)
        ? request.url.substring(baseUrl.length) || "/"
        : new URL(request.url).pathname;
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? null
            : request.body,
        // Allow streaming bodies on non-GET/HEAD; required by recent Fetch specs.
        duplex: "half",
      } as RequestInit & { duplex: "half" };
      return site(new Request(siteUrl, init));
    },
  );
  baseUrl = registration.baseUrl;
  log(`Site mounted at ${baseUrl}`);

  // --- now that /api is wired, show the client side of the hosted site. ---
  previewEl.src = `${baseUrl}client/`;
  log(`iframe → ${previewEl.src}`);
} catch (error) {
  log(`Fatal: ${error instanceof Error ? error.message : String(error)}`, true);
  console.error(error);
}
