// Browser e2e for webrun-bundler: a Dedicated Worker in a real Chromium runs esbuild-wasm on
// files in OPFS (webrun-files-browser) and bundles a project with a package from its
// node_modules; the bundle must run, contain no `await` (lowered), and its source map must
// trace the user's line to ~/src/app.ts and the package's line through the package's own
// map to its TypeScript. The Node suite (vitest) cannot show that esbuild-wasm, OPFS and
// the maps work together in a browser; only this does.
//
// Usage: node e2e/browser.mjs   (PW_CHROMIUM=/path/to/chrome to pick the browser)

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild-wasm";
import { chromium } from "playwright";

const here = import.meta.dirname;
const require = createRequire(import.meta.url);

// The test harness (worker + page) is built here with esbuild's own file access: that is
// tooling, not the bundler under test, which reads only the worker's OPFS.
const built = await esbuild.build({
  entryPoints: [join(here, "worker.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "silent",
});
const workerJs = built.outputFiles[0].text;
const wasm = await readFile(
  join(dirname(require.resolve("esbuild-wasm/package.json")), "esbuild.wasm"),
);
const page = `<!doctype html><meta charset="utf-8"><script type="module">
const w = new Worker("/worker.js", { type: "module" });
window.result = new Promise((resolve) => {
  w.onmessage = (e) => resolve(e.data);
  w.onerror = (e) => resolve({ ok: false, error: e.message });
});
w.postMessage({ wasmURL: "/esbuild.wasm" });
</script>`;

const server = createServer((req, res) => {
  const body = { "/": page, "/worker.js": workerJs, "/esbuild.wasm": wasm }[req.url ?? ""];
  if (body === undefined) return res.writeHead(404).end();
  const type =
    req.url === "/esbuild.wasm"
      ? "application/wasm"
      : req.url === "/"
        ? "text/html"
        : "text/javascript";
  res.writeHead(200, { "content-type": type }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

const launch = async () => {
  if (process.env.PW_CHROMIUM) return chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }); // preinstalled build
  }
};
const browser = await launch();
let failed = false;
const check = (ok, what, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failed = true;
};
try {
  const p = await browser.newPage();
  await p.goto(`http://127.0.0.1:${port}/`);
  const r = await p.evaluate(() => window.result);
  check(r.ok, "the worker bundled from OPFS with esbuild-wasm", r.error);
  if (r.ok) {
    check(r.answer === "HELLO BOB!", "the bundle runs", r.answer);
    check(!r.hasAwait, "await is lowered", r.hasAwait);
    check(
      JSON.stringify(r.app) === JSON.stringify(r.appExpected),
      "the user's line traces to ~/src/app.ts",
      r.app,
    );
    check(
      JSON.stringify(r.pkg) === JSON.stringify(r.pkgExpected),
      "the package's line traces to its TypeScript",
      r.pkg,
    );
    check(r.pkgContent, "the map carries the package's TypeScript", r.pkgContent);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
