# PROTOTYPE — peer-qualified package instances (throwaway, delete when done)

## The question

When two packages in one served graph consume the same package that has
`peerDependencies`, but pin DIFFERENT versions of those peers, can webrun-modules
serve both so that each actually RUNS in a browser?

The real case: `oxc-resolver` and `@rolldown/browser` both reach
`@napi-rs/wasm-runtime@1.2.4`, whose peers are
`@emnapi/core`/`@emnapi/runtime` `^1.7.1 || ^2.0.0-alpha.4`.
`@oxc-resolver/binding-wasm32-wasi` pins emnapi `1.11.2`; `@rolldown/browser`
pins `2.0.0-alpha.4`. Today one `~deps` proxy per `name@version` means both get
the same emnapi (currently `2.0.0-alpha.5`), and oxc-resolver dies with
`LinkError: napi_create_async_work: function import requires a callable`.

## Hypothesis under test

1. The emnapi version reaching each binding is the whole cause (for BOTH failures).
2. No single version per name can satisfy both — so a package with peers must be
   served as one INSTANCE per distinct peer resolution (`name@version+<peers>`),
   each with its own `~deps/`, peers resolved from the consuming importer.

## Run

    pnpm proto:peers          # runs every experiment, prints the verdicts

## Verdict — the approach works (2026-09-11)

All runs: real Chromium, a cross-origin-isolated page, a REAL call into each WASM
binding (oxc-resolver resolves a path; rolldown bundles a module).

### Before the spike (exp1, server-wide pin via the lockfile)

| emnapi pin | oxc-resolver | rolldown |
|---|---|---|
| none (served `2.0.0-alpha.5`) | FAIL `LinkError napi_create_async_work` | PASS |
| `1.11.2` | PASS | FAIL `bridge.setLastError is not a function` |
| `2.0.0-alpha.4` | FAIL `LinkError` | PASS |

The emnapi version reaching each binding is the whole cause for BOTH packages, and
no single version per name serves both. Hypotheses 1 and 2 confirmed.

### With the spike (exp2, exp3) — see `RUN-with-spike.txt`

- One server, one page, both packages, BOTH load orders → both PASS.
  Two deterministic instances: `wasm-runtime@1.2.4_p.75f1bf08` → emnapi `1.11.2`,
  `wasm-runtime@1.2.4_p.64431f14` → emnapi `2.0.0-alpha.4`.
- Lock pins no longer matter: a consumer's exact declaration wins (as it already
  did for direct deps — `reusable()` only reuses a lock entry for a RANGE).
- Existing suites all green on the spike (webrun-modules 165, whole repo 333) —
  i.e. NOTHING covered peer dependencies before.

### Decisions the prototype forced

1. **Instance root = `name@version_p.<hash>`**, the tag in the version segment, so
   every existing `name@version` parser captures the whole root and `depsRoot`
   gives each instance its own `~deps/` for free. Only `/raw` reads strip the tag.
   `_` not `+`: `+` is legal semver build metadata and S3-style static hosts decode
   `+` in a path as a space; `_` cannot occur in a semver version.
2. **Peers resolve from the CONSUMER** (importer's deps/peer/optional), falling back
   to the target's own peer range only when the consumer doesn't declare the peer.
   An importer that is itself an instance answers from its pins first — so peers
   propagate transitively.
3. **Pins MUST be persisted before the instance URL is emitted.** exp3 proved it:
   with in-memory pins, a restart that re-transforms an evicted instance re-bound
   `_p.75f1bf08` to `alpha.5` — the tag no longer matched its content — and oxc
   broke again. A sidecar `/instances/<root>.json` fixed it.

### Found along the way — NOT peer-related, separate work

- **Worker scripts need COEP on their own response.** A dedicated worker started
  from an isolated page is blocked (`net::ERR_BLOCKED_BY_RESPONSE`) unless its
  script response carries `Cross-Origin-Embedder-Policy: require-corp`. This was
  rolldown's `Worker sent an unknown error`. Header config, not resolution.
- **The browser `process` shim has no `cwd()`**; rolldown calls it
  (`TypeError: process.cwd is not a function`). Worked around here with the public
  `globals` option.
- **The static build does not follow `new URL('./x', import.meta.url)`**, so it
  never emits rolldown's worker script or `.wasm`. The lazy server copes (it serves
  raw files on demand); a static build of rolldown is broken regardless of peers.

### Open for the plan

- Optional peers the consumer does not declare: pinning them forces a download of a
  package the target may never import. Leave them unpinned.
- Host-provided peers bind to the host instance whatever the pin — exclude them
  from the tag, or they mint instances that differ only in dead pins.
- The name-keyed `Lockfile` cannot record a second version of a name; `prime()`'s
  lock is therefore incomplete once two instances pin different peer versions.
