---
"@statewalker/webrun-site-host": patch
---

Request bodies reach the handler in Firefox. Firefox has no `Request.body`, so the rebuilt site-relative request lost its body; it now carries the body read whole.
