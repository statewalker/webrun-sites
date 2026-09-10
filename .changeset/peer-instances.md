---
"@statewalker/webrun-modules": minor
"@statewalker/webrun-modules-build": minor
---

Serve a package with `peerDependencies` once per distinct resolution of its peers.

A package's peers are its consumer's to supply, but every module root had exactly
one `~deps/` folder, so it could name only one version per peer. Two consumers of
the same package that pinned different peer versions were both served one of them.
The real case: `oxc-resolver` and `@rolldown/browser` both reach
`@napi-rs/wasm-runtime@1.2.4`, and pin `@emnapi/core` `1.11.2` and `2.0.0-alpha.4`
respectively. Both were served `2.0.0-alpha.5`, and oxc-resolver failed with
`LinkError: napi_create_async_work: function import requires a callable`.

Such a package is now served as a **peer-qualified instance**,
`name@version_p.<16 hex>`. Each instance has its own `~deps/` and binds the peer
versions its consumer declared. A consumer that declares nothing falls back to the
target's own peer range, as before. Host-provided peers, and optional peers no
consumer declares, are not pinned.

**Breaking:** the URL of any package with pinned peers now carries the `_p.<tag>`
suffix, and its files are emitted under that root. Consumers holding emitted URLs
must re-prime their cache.

**Breaking:** `PreprocessContext` gains a required `instances` field. This affects
only code constructing a context directly; both bundled drivers set it.

New: each instance's pins are written to `/instances/<root>.json` in the cache
before the instance is first emitted, and read back by a later process. An instance
root with no such file is a 404 rather than a module resolved with guessed peers.
`PackageManifest` gains the optional `peerDependenciesMeta` and
`optionalDependencies` fields.
