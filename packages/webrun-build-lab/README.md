# @statewalker/webrun-build-lab (private)

An exploration lab for **one** incremental build engine to replace the three overlapping packages:
`webrun-dataflow` (graph + watermark stores), `webrun-builder` (stage-level frontier scheduler over
files) and `webrun-builders` (key-level SQLite engine with provenance). Three alternative prototypes
are built red/green against one conformance suite, then compared on the same workload.

## What is here

| Path | What |
|---|---|
| `src/core/types.ts` | The common contract: collections (`key → JSON` collections), map/reduce builders, tracked `get`/`list` reads (dynamic dependencies), `emit`, one producer per row, retraction, early cut-off, glitch-freedom, crash resumability. |
| `src/core/kv.ts` | The storage port: ordered KV with prefix scans and atomic batch commits. `MemKV` (with I/O counters), `CrashingKV` (kills the process before the N-th commit). |
| `src/core/sql-kv.ts` | The same port over `SqlDriver` (node:sqlite, Durable Objects, D1). |
| `src/core/fixtures.ts` | Builders used by tests and benchmarks: split/upper (fan-out chain), len/double (cut-off point), stats (reduce), left/right/join (diamond), compile/bundle (dynamic imports). |
| `src/prototypes/naive.ts` | **P0** full recompute: the reference semantics and the baseline. |
| `src/prototypes/cursors.ts` | **A** changelog cursors (webrun-dataflow / webrun-builder lineage). |
| `src/prototypes/queue.ts` | **B** eager dirty queue + reverse-dependency index (webrun-builders lineage). |
| `src/prototypes/traces.ts` | **C** pull / verifying traces (Salsa, Shake, "Build Systems à la Carte"). |
| `tests/conformance.ts` | 24 tests run against every prototype, incl. a crash at *every* commit followed by resume (state must equal the oracle, rework ≤ a clean run) and a randomized model check against P0. |
| `tests/builder.test.ts` | The suite against the real engine (`webrun-builder`): batch 1, batch 64, concurrency 4, SQLite. |
| `tests/massive.massive.ts`, `src/core/random-graph.ts` | Massive tests (`pnpm test:massive`, scale with `MASSIVE_SCALE`): random graphs of mixed builders, crash storms, real stores at volume, extreme shapes. |
| `bench/run.ts`, `bench/static.ts` | Benchmarks; results in `bench/results/`. |

```sh
pnpm test:massive              # massive tier; MASSIVE_SCALE=3 pnpm test:massive for more
pnpm test                      # 193 tests: suite × {A, B, C, B-on-SQLite, R ×4 configs} + P0
pnpm bench -- 5000             # all engines, N docs + N modules
pnpm tsx bench/static.ts 2000  # B vs the existing webrun-builders, both on SQLite
```

### Massive tests

`pnpm test:massive` (not part of `pnpm test`; ~1 min at scale 1) runs every engine at volume:

- **Random graphs** (`random-graph.ts`): 30–60 builders (×`MASSIVE_SCALE`) of mixed kinds —
  transform, cut-off (tiny codomain), filter, fan-out (0–3 rows → constant retractions),
  two-input join, dynamic reads (1–3 rows chosen by value, incl. missing rows), reduce and
  group-by reduce — over 300–600 keys × 3–5 sources, then rounds of 1…400 random edits. After
  every round A, B, C and R must **execute exactly the same number of tasks** (all are minimal),
  and periodically equal the oracle.
- **Crash storms**: each engine is killed at a random commit again and again during a cold build
  and two edit phases until one process finishes; the state must equal the oracle and a finished
  store must have nothing left to do.
- **Real stores at volume**: R over SQLite and over `FilesKV` must equal R over `MemKV` on a
  40-builder × 1 500-key graph, and a reopened `FilesKV` must resume with zero work.
- **Extreme shapes** (R): a 150-stage chain (one edit runs exactly one task per stage), a
  300-branch fan-out with a reduce over all branches (runs once, glitch-free), one key fanning
  out to 20 000 rows then shrinking to 10 (the retraction cascades through a downstream builder),
  20 sources × 1 000 keys with a 1 % edit.

One finding: within one batch of writes, "remove a row, then put back its old value" is a net
no-op. Prototype B still re-runs the dependents — they cut off at once, so results are correct —
while A and C can skip them. The real engine (R) now verifies read fingerprints before executing
and skips them too. The random-graph rounds therefore apply one edit per row;
the crash-storm phases keep the net no-ops and check correctness.

The suite is discriminating: each of 8 deliberate bugs injected into B (no reverse deps, no value
updates, no retraction, no cut-off, no queue-token check, no rank order, no dead-task retraction,
no reducer seeding) fails 1–12 tests.

## The three designs

The axis that separates them is **where change discovery is paid**.

- **A — changelog cursors.** A write records the change once in a per-collection changelog (compacted
  to one entry per key, with tombstones). Each consumer holds a cursor per collection and range-scans
  the log after it; dynamic reads go through a reverse index. Discovery is paid by the reader.
- **B — eager dirty queue.** A write queues every dependent task in the same commit (static
  key-triggering + a reverse index of dynamic reads). The queue is keyed by topological rank, so
  the first queue row is always the most upstream work: glitch-freedom is one ordered scan.
  Discovery is paid by the writer.
- **C — verifying traces.** No fan-out, no queue. Each task stores what it read; a run walks the
  traces of every builder whose declared collections changed and re-executes those whose reads are newer
  than the last verified revision. Discovery is paid by verification.

## Results (N = 5000 docs + 5000 modules, MemKV)

Task executions are identical for A, B, C and R in every scenario (minimal, as the suite
requires); the difference is bookkeeping. Reads = KV gets + rows scanned; writes = rows written
or deleted. **R** is the real implementation (`@statewalker/webrun-builder`: B + group commit).

| scenario | P0 ms | A reads / writes / ms | B reads / writes / ms | C reads / writes / ms | R reads / writes / commits / ms |
|---|---|---|---|---|---|
| cold build | 614 | 245k / 265k / 1315 | 430k / 235k / 1327 | 170k / 250k / 950 | 490k / 230k / **10.7k** / 1411 |
| no-op | 0.1 | 0 / 0 / 0.0 | 1 / 0 / 0.2 | 0 / 0 / 0.0 | 1 / 0 / 0 / 0.1 |
| edit 1 doc | 664 | 5 023 / 34 / 9.1 | 5 050 / **16** / **7.1** | 70 005 / 18 / 178 | 5 058 / **16** / 6 / 11.1 |
| edit 1 doc, cut-off | 633 | 16 / 18 / 0.2 | 34 / **9** / **0.1** | 55 004 / 10 / 148 | 40 / **9** / 4 / 0.3 |
| edit 1% docs | 537 | 6 652 / 2 410 / 22.1 | 8 161 / 1 302 / **14.0** | 70 302 / 1 304 / 174 | 8 662 / **1 253** / **58** / 21.7 |
| delete 1 doc | 562 | 5 035 / 58 / 11.9 | 5 056 / **35** / **5.7** | 70 010 / 42 / 216 | 5 057 / **35** / 6 / 8.8 |
| edit leaf module | 526 | 121 / 91 / 0.8 | 200 / 58 / **0.7** | 20 013 / 54 / 69 | 217 / **53** / 3 / 1.0 |
| edit hub module | 434 | 973 / 701 / **4.4** | 1 622 / 464 / 5.4 | 20 095 / 420 / 81 | 1 761 / **419** / 4 / 6.0 |
| stored state | 115k rows | 210k rows, 10.7 MB | 140k rows, **7.5 MB** | 115k rows, 8.8 MB | 140k rows, **7.5 MB** |

(The ~5 000 rows read by A, B and R on a doc edit are the `stats` reduce re-listing `len`: a
non-incremental reduce costs the same in every design.)

Scaling from N=1000 to N=5000: A, B and R incremental costs stay flat (proportional to the
change); C's verification grows 5× (proportional to the number of traces of touched builders).
Full numbers: `bench/results/bench-{1000,5000}.md`.

On SQLite (`bench/static.ts`, N=2000, static pipeline), before it was deleted the existing
`webrun-builders` engine took 2.9 s for a cold build, 4.2 ms for one edit and 43 ms for 1%; R takes
2.7 s, 2.3 ms and 29 ms — while also supporting dynamic reads, reduce builders and `dispose`.

### Verdict: B is the basis for the real implementation (now `@statewalker/webrun-builder`)

- **Lowest incremental cost**: fewest rows written and best wall time in every edit scenario;
  cost proportional to the change, independent of corpus size.
- **Smallest state** of the incremental designs; no tombstones or changelog to garbage-collect
  (A grows with churn), no per-collection revision bookkeeping (C).
- **The to-do list is explicit and durable** ("what is left" is one ordered scan), which makes
  crash resume, progress reporting, cooperative interruption and parallel execution of a builder's
  independent tasks straightforward.
- **Works with a dumb store**: only `get`, prefix `scan` and atomic batch writes — maps onto
  SQLite/D1/Durable Objects/IndexedDB/a file.

What the others do better, to carry over:
- C/A make a no-op on a fresh engine free; B pays one empty queue scan (negligible).
- C writes the fewest rows when a hub fans out (no queue rows); B's queue writes are the price of
  durability of the to-do list.

### Shared weaknesses, and their status in `webrun-builder`

1. **Cold builds cost more than a full recompute** (per-task bookkeeping). Measured first at
   ~12×; most of that was the lab's `MemKV` (O(n) sorted-array inserts — now a blocked sorted
   list) and one commit per task. R adds group commit (a batch of a builder's tasks per commit; a
   crash loses at most a batch): 5× fewer commits, ~2.3× a full recompute on MemKV. **Done.**
2. **Reduce builders re-list their whole input** on any change. → incremental reduce
   (fold over the changed keys with the previous accumulator), or keyed group-by. **Done:**
   `incremental: true` reduce builders get `ctx.changes()` (current + previous values) and `ctx.state`.
3. **Single writer per store**: the queue-token re-check (B) and stamp/revision counters (A, C) rely
   on an in-process lock. Multi-process use needs a conditional delete from storage (SQL can).
   **Done:** per-write conditions in the KV port (`ifValue`), conditional dequeue, and leases with
   `shared: true` (SQLite across processes).
4. **Ownership hand-over** within one run (task X stops emitting a row that task Y starts emitting,
   Y runs first) fails Y in A/B/C where P0 accepts it. **Done:** Y may take over a row whose owner
   is queued (stale).

5. **Net no-op re-runs** and a **race** found while analysing them (a `put` landing while a task
   runs, on a row it read dynamically, was lost). **Done:** verify-before-execute (read
   fingerprints in the trace) and re-checking dynamic source reads at commit when a write landed.

Contract points surfaced by the prototype authors: `pending` is true only for interruption (not for
dead letters); a reduce builder runs once even over empty inputs (P0 semantics).
