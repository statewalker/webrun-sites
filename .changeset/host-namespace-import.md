---
"@statewalker/webrun-modules": patch
---

A namespace-only import (`import * as X from "…"`) of a host-provided module now exposes the instance's members: the proxy exports one binding per own key of the server's registry entry, plus `default`. Before, such a proxy exported nothing and every `X.member` was `undefined`.
