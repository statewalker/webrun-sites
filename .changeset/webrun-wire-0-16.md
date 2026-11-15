---
"@statewalker/webrun-site-host": minor
---

Moves to webrun-wire's current line: `@statewalker/webrun-http-browser` ^0.7.0 -> ^0.16.0 (statewalker/statewalker-root#69).

The page side of `SwHttpAdapter` now speaks webrun-rpc 0.14's port stack, so the ServiceWorker script an app serves at `/sw-worker.js` must come from `@statewalker/webrun-http-browser` 0.16 too: keep the page and the worker on the same webrun-http-browser line, since webrun-rpc's wire format changed across these versions. The adapter also routes a request to the longest registered prefix, on whole path segments only, and rebuilds request urls with the page's scheme (https pages no longer get 404 from their own handler). No API change in this package.
