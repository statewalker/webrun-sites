---
"@statewalker/webrun-site-host": minor
---

Move the runtime dependency `@statewalker/webrun-http-browser` from `^0.16.0` to `^0.17.0` (on `@statewalker/webrun-rpc` 0.15). The page side and the ServiceWorker script served at `/sw-worker.js` must run the same webrun-http-browser line, so apps upgrading to this version also serve `sw-worker.js` from webrun-http-browser 0.17.
