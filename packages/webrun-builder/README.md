# @statewalker/webrun-builder

## What it is

An incremental, idempotent, resumable **build engine**. You declare **builders** (pure functions) that
read and write **collections** (named sets of `key → JSON` rows); the engine runs exactly the
tasks whose inputs changed, in dependency order, and keeps all of its state — rows, the work queue,
dependency traces, failures — in an ordered key-value store, so a build killed at any point resumes
where it stopped.

- **Key-level incremental.** A map builder runs one task per row key; changing one row re-runs only the
  tasks that read it.
- **Dynamic dependencies.** Tasks read through `ctx.get` / `ctx.list`, and those reads *are* the
  dependencies — which rows a task reads may depend on what it read (a compiler following imports).
- **Early cut-off.** Re-emitting an equal value (canonical JSON) changes nothing downstream.
- **Automatic retraction.** Rows a task stops emitting — or emitted for a source that disappeared —
  are deleted, and the deletion cascades; a `dispose` hook cleans up external artifacts.
- **Glitch-free.** A task never runs while an upstream builder still has queued work; a diamond's join
  runs once.
- **Failures don't stall the build.** A failing task is retried, then parked in a dead letter while
  the rest converges; a later change to anything it read retries it.
- **Pluggable storage.** `MemKV`, `FilesKV` (any `FilesApi`: memory, Node, browser storage),
  `SqlKV` (node:sqlite, Durable Objects, D1).

## Why it exists

This package replaces three overlapping attempts at the same problem: `webrun-dataflow`'s
watermark stores and runner, the previous `webrun-builder` (a stage-level frontier scheduler over
JSON files) and `webrun-builders` (a key-level SQLite engine). Three alternative designs — changelog
cursors, an eager dirty queue, pull/verifying traces — were prototyped against one conformance
suite and benchmarked in [`packages/webrun-build-lab`](../webrun-build-lab). The eager dirty
queue with a reverse-dependency index had the lowest incremental cost and the smallest state; it
is this engine.

## How to use

### Install

```sh
pnpm add @statewalker/webrun-builder
```

Runtime dependency: `@statewalker/webrun-files` (`FilesKV`, `scanSources`). The engine carries its
own topology (the former `webrun-dataflow` graph is folded in). `SqlKV` needs no SQL package: it takes any object shaped like the
`SqlDriver` of `@statewalker/webrun-files-sqlite`.

### One entry point

ESM, built to `dist/` (TypeScript sources in `src/`); no Node built-ins, so it runs in browsers,
workers and Node.

Exports: `BuildEngine`, `createBuildEngine`, `openStore`, `Topology`, `MemKV`, `FilesKV`, `SqlKV`, `CrashingKV` / `CrashError` (fault injection
for tests), `scanSources`, `SOURCES_COLLECTION`, `canonicalJson`, `makeProjectIgnore`,
`compileIgnoreRules`, `NULL_LOGGER`, `ConflictingEmission`, `emptyMetrics`, and the types
`BuilderDef`, `TaskContext`, `BuildEngineOptions`, `RunOptions`, `RunStats`, `BuildStatus`,
`DeadLetter`, `PersistenceConfig`, `CreateBuildEngineOptions`, `Json`, `Row`, `RowRef`, `KV`, `KvMetrics`, `SqlDriver`, `ScanSourcesOptions`,
`ScanResult`, `Logger`, `IgnoreRule`.

### Declare builders, write sources, run

```ts
import { BuildEngine, type BuilderDef, MemKV } from "@statewalker/webrun-builder";

const split: BuilderDef = {
  id: "split",
  inputs: ["docs"],          // one task per key of `docs`
  outputs: ["chunks"],
  async run(ctx) {
    const text = String(await ctx.get("docs", ctx.key));
    text.split(" ").forEach((w, n) => ctx.emit("chunks", `${ctx.key}#${n}`, w));
  },
};

const engine = new BuildEngine({ store: new MemKV(), builders: [split] });
await engine.put("docs", "a", "hello world");
await engine.run();                // { executed: 1, failed: 0, deadLettered: 0, pending: false }
await engine.list("chunks");       // [{ key: "a#0", value: "hello" }, { key: "a#1", value: "world" }]

await engine.put("docs", "a", "hello");
await engine.run();                // chunks a#1 is retracted
```

### Builders

```ts
interface BuilderDef {
  id: string;
  kind?: "map" | "reduce";           // default "map"
  inputs: readonly string[];         // map: task keys; reduce: what it aggregates
  reads?: readonly string[];         // other collections it may ctx.get / ctx.list
  outputs: readonly string[];
  run(ctx: TaskContext): void | Promise<void>;
  dispose?(key: string, outputs: readonly RowRef[]): void | Promise<void>;
}

interface TaskContext {
  readonly key: string;                                   // row key, or "*" for a reduce
  get(collection: string, key: string): Promise<Json | undefined>;
  list(collection: string): Promise<Row[]>;
  emit(collection: string, key: string, value: Json): void;
}
```

- **map** — one task per key present on any input. When the key is gone from every input the task
  is dead: `dispose` is called (before the retraction commits, so keep it idempotent) and its rows
  are retracted; `run` is not called.
- **reduce** — one task, key `"*"`, that aggregates with `ctx.list`; it runs at least once and
  again whenever anything it read changed.
- Each output row has exactly one producing task; a second producer fails with
  `ConflictingEmission`. Reading an undeclared collection or emitting to one fails the task.
- Builders must be deterministic functions of what they read. When a builder's code changes, call
  `engine.invalidate(builderId)`.

### `BuildEngine`

```ts
new BuildEngine({ store, builders, maxAttempts?, batchSize?, concurrency?, shared?, leaseMs?, now?, owner?, logger? })
```

| Member | Does |
|---|---|
| `put(collection, key, value)` / `remove(collection, key)` | write a source collection (one no builder outputs); resolve `true` if it changed |
| `get` / `list` / `keys` | read any collection |
| `run({ maxTasks?, collection? })` | execute queued tasks, most upstream first, until the queue is empty (or interrupted: `pending: true`) |
| `status()` | queued tasks per builder, dead-letter count |
| `deadLetters()` / `requeue(builder, key)` | inspect parked tasks and put one back |
| `invalidate(builder)` | queue every task of a builder (its code changed); downstream re-runs only where outputs change |

`batchSize` (default 64) is how many tasks of one builder commit per store transaction — a crash loses
at most one batch. `concurrency` (default 1) runs a batch's tasks concurrently; they are
independent because a builder never reads its own outputs.

### Persistence is configuration

```ts
import { createBuildEngine } from "@statewalker/webrun-builder";

const engine = await createBuildEngine({
  builders,
  persistence: { kind: "files", files, path: ".build/state" },
  // { kind: "memory" }                      — default; nothing survives the process
  // { kind: "sql", driver, table?: "kv" }   — node:sqlite, Durable Objects, D1
  // { kind: "custom", store }               — any KV implementation
});
```

`openStore(config)` opens the same configurations without creating an engine.

### Stores

```ts
new MemKV();                                              // in memory, with I/O counters
await FilesKV.open(files, ".project/state");              // any FilesApi; snapshot + commit log
new SqlKV(new NodeSqlDriver(new DatabaseSync("b.db")));   // one WITHOUT ROWID table
```

All three implement the `KV` port: `get(key)`, ordered prefix `scan(prefix, { after, limit })` and
atomic `commit(writes)`, where a write may carry a condition (`ifValue`, an SQL `UPDATE … WHERE value = ?`) — a shape that also maps onto IndexedDB or LMDB.

### Mirror a file tree into a source collection

```ts
import { scanSources } from "@statewalker/webrun-builder";

await scanSources(engine, { files, root: "/" });   // → { seen, changed, removed }
await engine.run();
```

One row per file, keyed by its root-relative path, valued by `{ mtime, size }` (or your
`fingerprint`, e.g. a content hash). Unchanged files write nothing; vanished or newly ignored ones
are removed. Paths with a dot-segment and matches of a gitignore-style `.projectignore` at the root
are skipped (`makeProjectIgnore` parses it).

## Examples

### Several inputs, several outputs: configs + files → content + screenshots

A builder declares any number of input collections and output collections. Two common shapes:

**Shared configuration.** One task per file. Every task also reads the shared `configs/render`
row, so editing the config re-renders every file, while editing a file re-renders only that file.

```ts
const render: BuilderDef = {
  id: "render",
  inputs: ["files"],                    // one task per key of `files`
  reads: ["configs"],                   // may also read rows of `configs`
  outputs: ["content", "screenshots"],  // writes two collections
  async run(ctx) {
    const html = String(await ctx.get("files", ctx.key));
    const config = (await ctx.get("configs", "render")) as { viewports: string[] };
    ctx.emit("content", ctx.key, extractText(html));
    for (const viewport of config.viewports) {
      const png = await screenshot(html, viewport);      // write the image wherever you keep artifacts…
      ctx.emit("screenshots", `${ctx.key}@${viewport}`, { viewport, hash: hash(png) }); // …and emit its fingerprint
    }
  },
};
```

Dropping a viewport from the config retracts that viewport's screenshot rows. Removing a file
retracts its `content` row and all its `screenshots` rows.

**Per-file configuration (a join on the key).** With both collections as inputs, a task exists for
every key present in either of them. `configs/a.html` and `files/a.html` feed the same task, so a
change to either re-runs only that key:

```ts
const page: BuilderDef = {
  id: "page",
  inputs: ["configs", "files"],
  outputs: ["content", "screenshots"],
  async run(ctx) {
    const html = await ctx.get("files", ctx.key);
    const config = (await ctx.get("configs", ctx.key)) as { viewports: string[] } | undefined;
    if (html === undefined) return;     // a config without its file yet: emit nothing
    ctx.emit("content", ctx.key, extractText(String(html)));
    for (const viewport of config?.viewports ?? ["default"]) {
      ctx.emit("screenshots", `${ctx.key}@${viewport}`, { viewport });
    }
  },
};
```

Both are executed in `tests/multi-io.test.ts`.

### Dynamic dependencies: a compiler following imports

```ts
const compile: BuilderDef = {
  id: "compile",
  inputs: ["mods"],
  outputs: ["compiled"],
  async run(ctx) {
    const mod = (await ctx.get("mods", ctx.key)) as { code: string; imports: string[] };
    const deps = [];
    for (const d of mod.imports) deps.push((await ctx.get("mods", d)) as { code: string });
    ctx.emit("compiled", ctx.key, [mod.code, ...deps.map((d) => d?.code)].join("|"));
  },
};
// Editing mods/util re-runs compile/util and every task that read mods/util — nothing else.
// If main stops importing util, later edits of util no longer re-run compile/main.
```

### A reduce builder

```ts
const stats: BuilderDef = {
  id: "stats",
  kind: "reduce",
  inputs: ["len"],
  outputs: ["stats"],
  async run(ctx) {
    const rows = await ctx.list("len");
    ctx.emit("stats", "total", { count: rows.length, sum: rows.reduce((a, r) => a + Number(r.value), 0) });
  },
};
```

### External artifacts

```ts
const render: BuilderDef = {
  id: "render",
  inputs: ["pages"],
  outputs: ["html"],
  async run(ctx) {
    const html = toHtml(await ctx.get("pages", ctx.key));
    await writeText(out, `${ctx.key}.html`, html);
    ctx.emit("html", ctx.key, hash(html));          // a fingerprint: cut-off on equal output
  },
  async dispose(key) {
    await out.remove(`${key}.html`);                 // the source page is gone
  },
};
```

## Internals

### An eager dirty queue

When a row's canonical value changes (a `put`, a task emitting a different value, a retraction),
every task that depends on it is queued **in the same commit**: map tasks keyed by that row, the
reduce task aggregating the collection, tasks that read that exact row (reverse index), and tasks that
listed the collection. The queue is keyed by topological rank, so the first queue row is always the
most upstream work; `run()` takes a batch of that builder's tasks, executes them and commits the batch.

A task's commit holds its changed outputs and the dependents they queue, retractions of outputs it
no longer emits, its trace (reads and outputs) with the reverse-index diff, its dequeue and the
dead-letter clean-up. "What is left to do" is the queue: nothing is recomputed after a restart, and
no work is proportional to the corpus — a no-op run is one empty scan.

### Store layout

```
r/<collection>/<key>                → <owner>\x02<canonical json>      rows (owner "" = source)
q/<rank>/<builder>/<task>          → {"g", "a", "o"?, "u"?, "z"?}     the queue (token, attempts, lease, reset)
f/<builder>/<task>                 → {"r", "l", "o", "i", "rh", "s"?} reads, lists, outputs, fingerprints, state
x/<collection>/<key>/<builder>/<task>  → ""                               row → reader index
xl/<collection>/<builder>/<task>       → ""                               collection → lister index
c/<builder>/<collection>/<key>         → {"p": previous, "g"}             incremental-reduce changes
d/<builder>/<task>                 → {"attempts", "error"}            dead letters
```

Tuple parts are joined with U+0001; names must not contain U+0000–U+0002.

### A change during a task survives its commit

Queue rows carry a token; a commit dequeues a task only if its row still holds the claimed value (a
conditional delete). A write that lands while the task runs replaces the token, so the task runs
again with the new value.

### Verify before execute

Each map task's trace keeps a fingerprint of every row it read with `ctx.get` (its own input rows
included): small values verbatim, larger ones as length plus two 32-bit hashes. A queued map task
whose reads all match is dequeued without running (`RunStats.skipped`). This happens for a change
undone before the run (remove + put back, A → B → A), or a spurious re-queue. It does not apply to:
- tasks that `list` a collection, which always run when queued;
- reduce builders;
- tasks after `invalidate` or `requeue`, which drop the fingerprints (and an incremental reduce's
  state) from the trace so they run once more whatever else re-queues them.

### Concurrent writes and several engines

- **Within one engine:** a `put` that lands while a task runs is never lost. If it hits the task's
  own input, the task's queue row changes and the conditional dequeue keeps the task queued. If it
  hits a row the task read dynamically, the batch commit (which takes the same lock as `put`)
  re-checks those reads and leaves stale tasks queued.
- **Several engines on one store (`shared: true`):** claims become leases (`leaseMs`, default
  30 s), taken with conditional writes. Every write of a task's commit is guarded by its claim (the
  queue row still holding the value it claimed; in SQL, `… AND EXISTS (…)` on the same
  transaction). So if the claim went stale — the task was re-queued by a write, or its lease expired
  and another engine took it — the whole result is dropped and the task runs again. A task may thus
  execute twice, but a stale result never overwrites a newer one. A crashed engine's claims become
  claimable again when its lease expires. Tasks that read source rows dynamically
  register those reads in the reverse index before re-checking them, so a write from another engine
  is either seen by the check or finds the registration and re-queues the task. This needs a store
  whose conditions hold across those engines: `SqlKV` across processes, `MemKV` within one process.
  `FilesKV` is single-process. `run()` reports `pending: true` while the most upstream work is
  leased by another engine. Incremental reduce builders are not supported with `shared: true`.

### Incremental reduce

```ts
const total: BuilderDef = {
  id: "total", kind: "reduce", incremental: true, inputs: ["len"], outputs: ["total"],
  async run(ctx) {
    let s = ctx.state as { sum: number } | undefined;
    if (!s) s = { sum: (await ctx.list("len")).reduce((a, r) => a + Number(r.value), 0) };
    else for (const c of await ctx.changes("len")) s.sum += Number(c.value ?? 0) - Number(c.previous ?? 0);
    ctx.setState(s);
    ctx.emit("total", "sum", s.sum);
  },
};
```

For an incremental reduce, the engine records, per changed input row, the value it had at the
task's last successful run. `ctx.changes(collection)` returns those changes with their current and
previous values, and `ctx.state` / `ctx.setState` carry a small state between runs (stored with the
trace). `ctx.state` is `undefined` on the first run and after `invalidate`; recompute with `list`
then. If an input changes while the reducer runs, its result is discarded at commit and it runs
again, so a change is neither lost nor counted twice.

### What will surprise you

- **A batch may be replayed after a crash.** Side effects outside the store (files written) must be
  idempotent per task.
- **A dead-lettered task does not fail `run()`.** Check `deadLetters()` or `status()`; its previous
  outputs stay as they were.
- **Ownership hand-over:** a task may take over a row whose owner is itself queued (stale: it may
  let go of the row when it runs). If that owner then still emits the row, it fails with
  `ConflictingEmission`. Two tasks that keep emitting the same row always conflict.
- **A plain reduce builder re-lists its whole input** on every change of it; use `incremental: true`
  for large inputs.
- **Two producers in different engines** emitting the same row at the same moment can both commit
  (last writer wins). The ownership check reads before the commit.
- **Changing the builder set on a persistent store:** queue rows of removed builders are dropped, and rows
  queued under an old rank move to the builder's current rank. Rows, traces and index entries of
  removed builders stay in the store.

## License

MIT
