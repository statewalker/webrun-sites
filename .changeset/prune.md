---
"@statewalker/webrun-modules-build": minor
---

`ProjectBuild.prune({ entries? })` removes every `~deps` proxy, with its sidecars, that the entry points cannot reach (#2). Without `entries`, the public entry points of the project's `package.json` are used (`main`, `module`, a string `browser`, every string target of `exports`).
