# @statewalker/webrun-builder

## What it is

An incremental, idempotent, resumable **build engine**. You declare **cells** (pure functions) that
read and write **signals** (named collections of `key → JSON` rows); the engine runs exactly the
tasks whose inputs changed, in dependency order, and keeps all of its state — rows, the work queue,
dependency traces, failures — in an ordered key-value store, so a build killed at any point resumes
where it stopped.

- **Key-level incremental.** A map cell runs one task per row key; changing one row re-runs only the
  tasks that read it.
- **Dynamic dependencies.** Tasks read through `ctx.get` / `ctx.list`, and those reads *are* the
  dependencies — which rows a task reads may depend on what it read (a compiler following imports).
- **Early cut-off.** Re-emitting an equal value (canonical JSON) changes nothing downstream.
- **Automatic retraction.** Rows a task stops emitting — or emitted for a source that disappeared —
  are deleted, and the deletion cascades; a `dispose` hook cleans up external artifacts.
- **Glitch-free.** A task never runs while an upstream cell still has queued work; a diamond's join
  runs once.
- **Failures don't stall the build.** A failing task is retried, then parked in a dead letter while
  the rest converges; a later change to anything it read retries it.
- **Pluggable storage.** `MemKV`, `FilesKV` (any `FilesApi`: memory, Node, browser storage),
  `SqlKV` (node:sqlite, Durable Objects, D1).

## Why it exists

This package replaces three overlapping attempts at the same problem: `webrun-dataflow`'s
watermark stores and runner, the previous `webrun-builder` (a stage-level frontier scheduler over
JSON files) and `webrun-cells` (a key-level SQLite engine). Three alternative designs — changelog
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
for tests), `scanSources`, `SOURCES_SIGNAL`, `canonicalJson`, `makeProjectIgnore`,
`compileIgnoreRules`, `NULL_LOGGER`, `ConflictingEmission`, `emptyMetrics`, and the types
`CellDef`, `TaskContext`, `BuildEngineOptions`, `RunOptions`, `RunStats`, `BuildStatus`,
`DeadLetter`, `PersistenceConfig`, `CreateBuildEngineOptions`, `Json`, `Row`, `RowRef`, `KV`, `KvMetrics`, `SqlDriver`, `ScanSourcesOptions`,
`ScanResult`, `Logger`, `IgnoreRule`.

### Declare cells, write sources, run

```ts
import { BuildEngine, type CellDef, MemKV } from "@statewalker/webrun-builder";

const split: CellDef = {
  id: "split",
  inputs: ["docs"],          // one task per key of `docs`
  outputs: ["chunks"],
  async run(ctx) {
    const text = String(await ctx.get("docs", ctx.key));
    text.split(" ").forEach((w, n) => ctx.emit("chunks", `${ctx.key}#${n}`, w));
  },
};

const engine = new BuildEngine({ store: new MemKV(), cells: [split] });
await engine.put("docs", "a", "hello world");
await engine.run();                // { executed: 1, failed: 0, deadLettered: 0, pending: false }
await engine.list("chunks");       // [{ key: "a#0", value: "hello" }, { key: "a#1", value: "world" }]

await engine.put("docs", "a", "hello");
await engine.run();                // chunks a#1 is retracted
```

### Cells

```ts
interface CellDef {
  id: string;
  kind?: "map" | "reduce";           // default "map"
  inputs: readonly string[];         // map: task keys; reduce: what it aggregates
  reads?: readonly string[];         // other signals it may ctx.get / ctx.list
  outputs: readonly string[];
  run(ctx: TaskContext): void | Promise<void>;
  dispose?(key: string, outputs: readonly RowRef[]): void | Promise<void>;
}

interface TaskContext {
  readonly key: string;                                   // row key, or "*" for a reduce
  get(signal: string, key: string): Promise<Json | undefined>;
  list(signal: string): Promise<Row[]>;
  emit(signal: string, key: string, value: Json): void;
}
```

- **map** — one task per key present on any input. When the key is gone from every input the task
  is dead: `dispose` is called (before the retraction commits, so keep it idempotent) and its rows
  are retracted; `run` is not called.
- **reduce** — one task, key `"*"`, that aggregates with `ctx.list`; it runs at least once and
  again whenever anything it read changed.
- Each output row has exactly one producing task; a second producer fails with
  `ConflictingEmission`. Reading an undeclared signal or emitting to one fails the task.
- Cells must be deterministic functions of what they read. When a cell's code changes, call
  `engine.invalidate(cellId)`.

### `BuildEngine`

```ts
new BuildEngine({ store, cells, maxAttempts?, batchSize?, concurrency?, shared?, leaseMs?, now?, owner?, logger? })
```

| Member | Does |
|---|---|
| `put(signal, key, value)` / `remove(signal, key)` | write a source signal (one no cell outputs); resolve `true` if it changed |
| `get` / `list` / `keys` | read any signal |
| `run({ maxTasks?, signal? })` | execute queued tasks, most upstream first, until the queue is empty (or interrupted: `pending: true`) |
| `status()` | queued tasks per cell, dead-letter count |
| `deadLetters()` / `requeue(cell, key)` | inspect parked tasks and put one back |
| `invalidate(cell)` | queue every task of a cell (its code changed); downstream re-runs only where outputs change |

`batchSize` (default 64) is how many tasks of one cell commit per store transaction — a crash loses
at most one batch. `concurrency` (default 1) runs a batch's tasks concurrently; they are
independent because a cell never reads its own outputs.

### Persistence is configuration

```ts
import { createBuildEngine } from "@statewalker/webrun-builder";

const engine = await createBuildEngine({
  cells,
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

### Mirror a file tree into a source signal

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

### Dynamic dependencies: a compiler following imports

```ts
const compile: CellDef = {
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

### A reduce cell

```ts
const stats: CellDef = {
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
const render: CellDef = {
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
reduce task aggregating the signal, tasks that read that exact row (reverse index), and tasks that
listed the signal. The queue is keyed by topological rank, so the first queue row is always the
most upstream work; `run()` takes a batch of that cell's tasks, executes them and commits the batch.

A task's commit holds its changed outputs and the dependents they queue, retractions of outputs it
no longer emits, its trace (reads and outputs) with the reverse-index diff, its dequeue and the
dead-letter clean-up. "What is left to do" is the queue: nothing is recomputed after a restart, and
no work is proportional to the corpus — a no-op run is one empty scan.

### Store layout

```
r/<signal>/<key>                → <owner>\x02<canonical json>      rows (owner "" = source)
q/<rank>/<cell>/<task>          → {"g", "a", "o"?, "u"?, "z"?}     the queue (token, attempts, lease, reset)
f/<cell>/<task>                 → {"r", "l", "o", "i", "rh", "s"?} reads, lists, outputs, fingerprints, state
x/<signal>/<key>/<cell>/<task>  → ""                               row → reader index
xl/<signal>/<cell>/<task>       → ""                               signal → lister index
c/<cell>/<signal>/<key>         → {"p": previous, "g"}             incremental-reduce changes
d/<cell>/<task>                 → {"attempts", "error"}            dead letters
```

Tuple parts are joined with U+0001; names must not contain U+0000–U+0002.

### A change during a task survives its commit

Queue rows carry a token; a commit dequeues a task only if its row still holds the claimed value (a
conditional delete). A write that lands while the task runs replaces the token, so the task runs
again with the new value.

### Verify before execute

Each task's trace keeps a fingerprint of every row it read (its own input rows included):
small values verbatim, larger ones as length plus two 32-bit hashes. A queued map task whose reads
all match is dequeued without running (`RunStats.skipped`). This happens for a change undone
before the run (remove + put back, A → B → A), or a spurious re-queue. `invalidate` bypasses it.

### Concurrent writes and several engines

- **Within one engine:** a `put` that lands while a task runs is never lost. If it hits the task's
  own input, the task's queue row changes and the conditional dequeue keeps the task queued. If it
  hits a row the task read dynamically, the batch commit (which takes the same lock as `put`)
  re-checks those reads and leaves stale tasks queued.
- **Several engines on one store (`shared: true`):** claims become leases (`leaseMs`, default
  30 s), taken with conditional writes, so a task runs in one engine at a time. A crashed engine's
  claims become claimable again when its lease expires. Tasks that read source rows dynamically
  register those reads in the reverse index before re-checking them, so a write from another engine
  is either seen by the check or finds the registration and re-queues the task. This needs a store
  whose conditions hold across those engines: `SqlKV` across processes, `MemKV` within one process.
  `FilesKV` is single-process. `run()` reports `pending: true` while the most upstream work is
  leased by another engine.

### Incremental reduce

```ts
const total: CellDef = {
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
task's last successful run. `ctx.changes(signal)` returns those changes with their current and
previous values, and `ctx.state` / `ctx.setState` carry a small state between runs (stored with the
trace). `ctx.state` is `undefined` on the first run and after `invalidate`; recompute with `list`
then.

### What will surprise you

- **A batch may be replayed after a crash.** Side effects outside the store (files written) must be
  idempotent per task.
- **A dead-lettered task does not fail `run()`.** Check `deadLetters()` or `status()`; its previous
  outputs stay as they were.
- **Ownership hand-over:** a task may take over a row whose owner is itself queued (stale: it may
  let go of the row when it runs). If that owner then still emits the row, it fails with
  `ConflictingEmission`. Two tasks that keep emitting the same row always conflict.
- **A plain reduce cell re-lists its whole input** on every change of it; use `incremental: true`
  for large inputs.
- **Two producers in different engines** emitting the same row at the same moment can both commit
  (last writer wins). The ownership check reads before the commit.

## License

MIT
