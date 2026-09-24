---
"@statewalker/webrun-modules": patch
---

`*.worker.js` is now served untransformed, and raw responses carry the file's own
content type.

The default transform wrapped every served script in ESM, `*.worker.js` included —
at minimum an `import { … } from "…/~deps/~globals.js"` line for the file's free
globals, and a full CJS-interop shim for a UMD bundle. A `*.worker.js` is loaded by
`new Worker(url)` as a **classic** script, which cannot contain `import`, so the
served body did not parse. `new Worker()` reports that `SyntaxError` asynchronously
through the worker's `onerror` and nowhere else — not as a rejection, not on the
page — so a caller that does not listen for it hangs forever with no error anywhere.
That is how it surfaced: `@duckdb/duckdb-wasm` + `@statewalker/db-duckdb-browser`,
two browser tests timing out at 120 s with no page error captured.

How a file is *loaded* decides what it may contain, and the only consumer of a
`*.worker.js` is `new Worker(url)` — the ESM wrap can never be what the caller
wants. The rule is anchored at the end of the path and narrow to `.js`, so
`*.worker.js.map` is still served as JSON and `*.worker.jsx`/`.ts` are still
compiled.

**Behaviour change:** a `*.worker.js` under a module-server URL now responds with
its untouched source bytes instead of transformed ESM. Anything importing such a
file as a module would break; nothing does, and nothing can — a file that needs
the transform to link is not a file a classic `Worker` could ever have loaded.

**Fix:** `?raw` responded `content-type: application/octet-stream` whatever the
file was. `?raw` means "untransformed", not "of unknown type", so the type now
comes from the extension on that path too, as it already did for non-module
resources. The map gains `.js`/`.mjs`/`.cjs` → `text/javascript`, which the spec
asks for on a classic worker script — Chromium tolerates the octet-stream
mismatch today, another engine need not. An extension the map does not know still
falls back to `application/octet-stream`.

Closes statewalker/umbrella#40.
