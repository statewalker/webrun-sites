# @statewalker/webrun-cells

## What it is

An incremental engine for derived data whose entire state lives in SQLite. Callers write rows into named
**signals**. Every **cell** that consumes a signal is queued for the changed key. `run()` claims queued inputs,
hands them to the cell, and commits what the cell **emits** (rows on its output signals) in the same transaction
that removes the input from the queue. An output equal to the stored row stops the cascade. An output a cell no
longer emits, or one derived from a removed row, is deleted, and the deletion cascades. Failing inputs are
retried and then parked in a dead-letter table while the rest of the graph converges.

## Why it exists

Keeping derived data current over a changing corpus (split, extract, embed, index) needs the minimum correct
cascade: only affected keys, in dependency order, resumable after a crash, with nothing left behind when a source
disappears. When the queue, the outputs and the record of which input produced which output are rows in one
database, each step commits atomically and "what is left to do" is a `SELECT`, not something recomputed after a
restart. `@statewalker/webrun-builder` solves a neighbouring problem with stage-level convergence over files.
Use this package when the unit of work is a key, and when failures must not stall the rest of the pipeline.

## How to use

```sh
pnpm add @statewalker/webrun-cells @statewalker/webrun-files-sqlite
```

The engine talks to SQLite through `SqlDriver` from `@statewalker/webrun-files-sqlite`, which provides
`NodeSqlDriver` (`node:sqlite`), `DoSqlDriver` (a Durable Object's SQLite storage) and `D1SqlDriver`. The test
suite runs on `NodeSqlDriver`.

```ts
import { CellEngine, type Cell } from "@statewalker/webrun-cells";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { DatabaseSync } from "node:sqlite";

const split: Cell = {
  id: "split",
  inputs: ["docs"],
  outputs: ["chunks"],
  async *run(inputs) {
    for await (const input of inputs) {
      for (const [n, word] of String(input.value).split(" ").entries())
        yield { signal: "chunks", key: `${input.key}#${n}`, value: word };
    }
  },
};

const engine = new CellEngine({ db: new NodeSqlDriver(new DatabaseSync("cells.db")), cells: [split] });
await engine.put("docs", "a", "hello world");
await engine.run(); // { committed: 1, failed: 0, deadLettered: 0 }
await engine.list("chunks"); // [{ key: "a#0", value: "hello" }, { key: "a#1", value: "world" }]
```

| Member | Does |
|---|---|
| `new CellEngine({ db, cells, owner?, leaseMs?, maxAttempts?, batchSize?, now? })` | validates the graph; the schema is created on first use |
| `put(signal, key, value)` / `remove(signal, key)` | write a **source** signal (one no cell outputs) |
| `get(signal, key)` / `list(signal)` | read any signal |
| `run()` | claim → run → commit until nothing claimable is left; resolves `{ committed, failed, deadLettered }` |
| `deadLetters()` / `requeue(cell, signal, key)` | inspect parked inputs and put one back |

## Examples

### A cell commits one input at a time, when it pulls the next

```ts
async *run(inputs) {
  for await (const input of inputs) {   // pulling input 2 commits input 1
    yield { signal: "out", key: input.key, value: f(input.value) };
  }                                      // returning commits the last input
}
```

If the cell throws while handling input 2, input 1 stays committed and input 2 is retried. If the cell returns
before pulling every input, the inputs it did not pull go back to the queue.

### Removing a source retracts everything derived from it

```ts
await engine.remove("docs", "a");
await engine.run(); // chunks a#0, a#1 deleted; their consumers' outputs deleted in turn
```

Cells are not invoked for a removal. The engine knows from provenance which rows an input produced.

### Inspecting and retrying failures

```ts
for (const d of await engine.deadLetters()) {
  console.log(d.cell, d.signal, d.key, d.attempts, d.error);
  await engine.requeue(d.cell, d.signal, d.key);
}
```

## Internals

### Five tables

```
cells_rows        (signal, key) → value          canonical JSON text
cells_pending     (cell, signal, key) → seq, attempts, lease_owner, lease_until
cells_provenance  (cell, in_signal, in_key, out_signal, out_key)
cells_dead_letter (cell, signal, key) → attempts, error
cells_meta        'seq' → counter
```

All names carry the `cells_` prefix, so the engine can share a database with other tables, such as a Durable
Object's.

### Why values are compared as text, not hashed

Values are stored as JSON with object keys sorted at every depth, and "unchanged" means byte-equal text. A hash
would be cheaper to compare, but a collision would silently skip a real update and leave stale outputs, with
nothing to point at the cause. Values JSON cannot represent exactly (`undefined`, `NaN`, `Infinity`, `Date`)
are rejected with a `TypeError` instead of being stored as `null`.

### Why a newer change survives a commit

Every enqueue stamps the queue row with a fresh `seq`. A commit deletes the queue row only if it still carries
the `seq` that was claimed. A change that arrives while the cell runs replaces the `seq`, so the input stays
queued and runs again with the new value.

### Why the commit never reads inside its transaction

`SqlDriver.transaction(statements)` takes a fixed list of statements, which is what D1's `batch()` allows. The
engine reads what it needs (previous provenance, stored values) before the transaction. Conditions that must hold
at commit time are written in SQL: an orphan row is deleted `WHERE NOT EXISTS` another producer, and its
consumers are queued only if the row is really gone.

### The graph is declared and acyclic

Cells declare `inputs` and `outputs`. Construction fails on duplicate ids, on cycles (`Cycle detected among
cells: …`), and on a cell that consumes its own output. `put`/`remove` on a signal some cell outputs fail with
`"…" is not a source signal`. Because the graph is acyclic and every commit removes a queue row, `run()`
terminates.

### Dependencies

`@statewalker/webrun-dataflow` for topology and cycle detection; `@statewalker/webrun-files-sqlite` for the
`SqlDriver` port. No other runtime dependencies.

## What will surprise you

- **A batch may be replayed after a crash.** An input that was running when the process died keeps its lease
  until `leaseMs` (30 s by default) passes, then runs again. Side effects outside the database (files written,
  HTTP calls) must be idempotent per input key. If they are not, the symptom is a duplicated external write
  after a restart.
- **A dead-lettered input does not stop convergence.** `run()` resolves normally. Its result's `deadLettered`
  count and `deadLetters()` are the only signals. The failing input's previous outputs stay as they were.
- **Two inputs may emit the same output only with the same value.** A value that differs from the one a
  *settled* producer emitted fails the input with `ConflictingEmission: <signal>/<key>: …`. A producer whose own
  input is still queued does not count: it is stale and runs again, so changing a shared value through all
  of its producers converges to the new value. Two engines sharing one database can race past this check
  when they emit the same key at the same moment. The check reads before the commit, because the driver cannot
  read inside a transaction.
- **`leaseMs` must exceed the time a batch takes.** A batch that runs longer than its lease can be claimed and
  run a second time by another engine on the same database.
- **A cell that never pulls its inputs does not spin.** `run()` stops claiming a cell whose batch pulled
  nothing, and resolves. The inputs are claimed again by the next `run()`.

## License

MIT
