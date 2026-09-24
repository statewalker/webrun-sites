import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { newModuleServer } from "../src/server/new-module-server.js";
import type { PackageManifest, Source } from "../src/types.js";

// Offline fixture, same shape as tests/mime.test.ts and tests/server.test.ts: an
// in-memory `Source` standing in for a package that ships classic worker bundles,
// so nothing here touches the npm registry.
type Pkg = { version: string; manifest: Partial<PackageManifest>; files: Record<string, string> };

function memSource(pkgs: Record<string, Pkg>): Source {
  return {
    matches: (ref) => "pkg" in ref && ref.pkg in pkgs,
    async load(ref) {
      if (!("pkg" in ref)) throw new Error("bad ref");
      const p = pkgs[ref.pkg];
      const files = new MemFilesApi();
      for (const [path, content] of Object.entries(p.files))
        await writeText(files, `/${path}`, content);
      return {
        name: ref.pkg,
        version: p.version,
        files,
        manifest: { name: ref.pkg, version: p.version, ...p.manifest } as PackageManifest,
      };
    },
  };
}

// A UMD worker bundle in miniature, cut to the two features that make the default
// transform touch it: a CJS marker (`module.exports`) that routes it through the CJS
// translation, and free globals (`globalThis`, `process`) that pull in the
// `~deps/~globals.js` proxy. Real bundles (`@duckdb/duckdb-wasm`'s
// `dist/duckdb-browser-eh.worker.js`) have both.
const WORKER_UMD = [
  `"use strict";`,
  `var duckdb=(()=>{`,
  `var qc=Object.create;`,
  `var g=typeof globalThis!=="undefined"?globalThis:self;`,
  `var env=typeof process!=="undefined"?process.env:{};`,
  `if(typeof module!=="undefined"&&module.exports){module.exports={qc:qc,g:g,env:env};}`,
  `return {qc:qc};`,
  `})();`,
].join("");

// Its `.map` sibling — present so the rule that picks worker scripts is proven to be
// ANCHORED at the end of the path. A `*.worker.js*` glob would catch this too, and a
// source map served as JavaScript is a different bug.
const WORKER_MAP = `{"version":3,"file":"duckdb-browser-eh.worker.js","sources":[],"mappings":""}`;

const PKGS: Record<string, Pkg> = {
  "@duckdb/duckdb-wasm": {
    version: "1.29.0",
    manifest: { type: "module", main: "./dist/duckdb-browser.mjs" },
    files: {
      "dist/duckdb-browser.mjs": `export const ok = 1;`,
      "dist/duckdb-browser-eh.worker.js": WORKER_UMD,
      "dist/duckdb-browser-eh.worker.js.map": WORKER_MAP,
      // A path that CONTAINS `.worker.js` but does not end there, and which is a module
      // file, so serving it raw would be observable. This is what anchoring buys.
      "dist/panel.worker.jsx": WORKER_UMD,
      // BYTE-IDENTICAL to the worker, under a name the rule does not match. The only
      // difference between this file and the worker is its path, so whatever happens to
      // one and not the other is the rule and nothing else.
      "dist/not-a-worker.js": WORKER_UMD,
    },
  },
};

const PKG = "@duckdb/duckdb-wasm@1.29.0";
const WORKER_URL = `http://h/${PKG}/dist/duckdb-browser-eh.worker.js`;

/** A server whose raw cache is already warm (the package has been resolved once). */
async function warmServer() {
  const server = newModuleServer({ cache: new MemFilesApi(), sources: [memSource(PKGS)] });
  await server.resolve({ pkg: "@duckdb/duckdb-wasm" });
  return server;
}

describe("classic worker scripts", () => {
  // The defect this covers is invisible by presence: a WRONGLY transformed worker is
  // still served 200 with a body. Only the body tells the two apart — `new Worker(url)`
  // loads a CLASSIC script, which cannot contain `import`, and reports the SyntaxError
  // through `onerror` only, so the caller hangs forever with no error anywhere.
  it("serves a *.worker.js body byte-for-byte, with no ESM wrap", async () => {
    const server = await warmServer();
    const res = await server.fetch(new Request(WORKER_URL));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe(WORKER_UMD);
    expect(body).not.toMatch(/\bimport\b/);
    expect(body).not.toContain("~deps/~globals.js");
    expect(body).not.toMatch(/^export\b|\nexport\b/);
  });

  it("serves a *.worker.js with a JavaScript content type", async () => {
    const server = await warmServer();
    const res = await server.fetch(new Request(WORKER_URL));
    expect(res.headers.get("content-type")).toBe("text/javascript");
  });

  // `?raw` already bypassed the transform; what it did not do was declare the body as
  // JavaScript. The spec wants a JavaScript MIME type for a classic worker script;
  // Chromium tolerates `application/octet-stream` today, another engine need not.
  it("serves a *.worker.js with a JavaScript content type under ?raw too", async () => {
    const server = await warmServer();
    const res = await server.fetch(new Request(`${WORKER_URL}?raw`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(await res.text()).toBe(WORKER_UMD);
  });

  // Anchoring guard. The `.map` half is the one that is easy to state and the one the
  // consumer-side workaround called out, but it does not on its own discriminate: a map
  // is not a module file, so it was already served raw and an UNANCHORED rule would not
  // change its response. The `.worker.jsx` half is what actually bites — a module file
  // whose path contains `.worker.js`, which an unanchored rule would stop compiling.
  it("is anchored: a path that merely contains `.worker.js` is not a worker script", async () => {
    const server = await warmServer();

    const map = await server.fetch(new Request(`${WORKER_URL}.map`));
    expect(map.status).toBe(200);
    expect(map.headers.get("content-type")).toBe("application/json");
    expect(await map.text()).toBe(WORKER_MAP);

    const jsx = await server.fetch(new Request(`http://h/${PKG}/dist/panel.worker.jsx`));
    expect(jsx.status).toBe(200);
    const body = await jsx.text();
    expect(body).not.toBe(WORKER_UMD);
    expect(body).toContain('from "../~deps/~globals.js"');
  });

  // Narrowness guard: the SAME bytes under a non-worker name still get the ESM wrap,
  // so the exemption is the path rule and not some property of the content.
  it("still transforms byte-identical content under a non-worker name", async () => {
    const server = await warmServer();
    const res = await server.fetch(new Request(`http://h/${PKG}/dist/not-a-worker.js`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    const body = await res.text();
    expect(body).not.toBe(WORKER_UMD);
    expect(body).toContain('from "../~deps/~globals.js"');
  });
});
