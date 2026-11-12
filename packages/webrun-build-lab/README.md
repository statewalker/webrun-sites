# @statewalker/webrun-build-lab (private)

An exploration lab for **one** incremental build engine to replace the three overlapping packages:
`webrun-dataflow` (graph + watermark stores), `webrun-builder` (stage-level frontier scheduler over
files) and `webrun-cells` (key-level SQLite engine with provenance). Three alternative prototypes
are built red/green against one conformance suite, then compared on the same workload.

## What is here

| Path | What |
|---|---|
| `src/core/types.ts` | The common contract: signals (`key → JSON` collections), map/reduce cells, tracked `get`/`list` reads (dynamic dependencies), `emit`, one producer per row, retraction, early cut-off, glitch-freedom, crash resumability. |
| `src/core/kv.ts` | The storage port: ordered KV with prefix scans and atomic batch commits. `MemKV` (with I/O counters), `CrashingKV` (kills the process before the N-th commit). |
| `src/core/sql-kv.ts` | The same port over `SqlDriver` (node:sqlite, Durable Objects, D1). |
| `src/core/fixtures.ts` | Cells used by tests and benchmarks: split/upper (fan-out chain), len/double (cut-off point), stats (reduce), left/right/join (diamond), compile/bundle (dynamic imports). |
| `src/prototypes/naive.ts` | **P0** full recompute: the reference semantics and the baseline. |
| `src/prototypes/cursors.ts` | **A** changelog cursors (webrun-dataflow / webrun-builder lineage). |
| `src/prototypes/queue.ts` | **B** eager dirty queue + reverse-dependency index (webrun-cells lineage). |
| `src/prototypes/traces.ts` | **C** pull / verifying traces (Salsa, Shake, "Build Systems à la Carte"). |
| `tests/conformance.ts` | 24 tests run against every prototype, incl. a crash at *every* commit followed by resume (state must equal the oracle, rework ≤ a clean run) and a randomized model check against P0. |
| `bench/run.ts`, `bench/static.ts` | Benchmarks; results in `bench/results/`. |

```sh
pnpm test                      # 97 tests: suite × {A, B, C, B-over-SQLite} + P0
pnpm bench -- 5000             # all engines, N docs + N modules
pnpm tsx bench/static.ts 2000  # B vs the existing webrun-cells, both on SQLite
```

The suite is discriminating: each of 8 deliberate bugs injected into B (no reverse deps, no value
updates, no retraction, no cut-off, no queue-token check, no rank order, no dead-task retraction,
no reducer seeding) fails 1–12 tests.

## The three designs

The axis that separates them is **where change discovery is paid**.

- **A — changelog cursors.** A write records the change once in a per-signal changelog (compacted
  to one entry per key, with tombstones). Each consumer holds a cursor per signal and range-scans
  the log after it; dynamic reads go through a reverse index. Discovery is paid by the reader.
- **B — eager dirty queue.** A write queues every dependent task in the same commit (static
  key-triggering + a reverse index of dynamic reads). The queue is keyed by topological rank, so
  the first queue row is always the most upstream work: glitch-freedom is one ordered scan.
  Discovery is paid by the writer.
- **C — verifying traces.** No fan-out, no queue. Each task stores what it read; a run walks the
  traces of every cell whose declared signals changed and re-executes those whose reads are newer
  than the last verified revision. Discovery is paid by verification.

## Results (N = 5000 docs + 5000 modules, MemKV)

Task executions are identical for A, B and C in every scenario (minimal, as the suite requires);
the difference is bookkeeping. KV reads = gets + rows scanned.

| scenario | P0 ms | A: reads / rows written / ms | B: reads / rows written / ms | C: reads / rows written / ms |
|---|---|---|---|---|
| no-op | 0.2 | 0 / 0 / 0.0 | 1 / 0 / 0.1 | 0 / 0 / 0.0 |
| edit 1 doc | 569 | 5 023 / 34 / 17 | 5 050 / **16** / **8.6** | 70 005 / 18 / 243 |
| edit 1 doc, cut-off | 421 | 16 / 18 / 2.7 | 34 / **9** / **1.6** | 55 004 / 10 / 198 |
| edit 1% docs | 488 | 6 652 / 2 410 / 460 | 8 161 / **1 302** / **158** | 70 302 / 1 304 / 217 |
| delete 1 doc | 629 | 5 035 / 58 / 29 | 5 056 / **35** / **9.9** | 70 010 / 42 / 161 |
| edit leaf module | 701 | 121 / 91 / 18 | 200 / **58** / **5.6** | 20 013 / 54 / 59 |
| edit hub module | 542 | 973 / 701 / 139 | 1 622 / 464 / **42.6** | 20 095 / **420** / 71.6 |
| stored state | 115k rows | 210k rows, 10.7 MB | 140k rows, **7.5 MB** | 115k rows, 8.8 MB |

(The ~5 000 rows read by A and B on a doc edit are the `stats` reduce re-listing `len`: a
non-incremental reduce costs the same in every design.)

Scaling from N=1000 to N=5000: A and B incremental costs stay flat (they are proportional to the
change); C's verification grows 5× (proportional to the number of traces of touched cells).

On SQLite (`bench/static.ts`, N=2000), B matches the existing `webrun-cells` on a cold build
(3.0 s vs 2.9 s) and is faster incrementally (edit 1 doc 2.3 vs 4.2 ms, 1% 32 vs 43 ms), while also
supporting dynamic reads and reduce cells.

### Verdict: B is the basis for the real implementation

- **Lowest incremental cost**: fewest rows written and best wall time in every edit scenario;
  cost proportional to the change, independent of corpus size.
- **Smallest state** of the incremental designs; no tombstones or changelog to garbage-collect
  (A grows with churn), no per-signal revision bookkeeping (C).
- **The to-do list is explicit and durable** ("what is left" is one ordered scan), which makes
  crash resume, progress reporting, cooperative interruption and parallel execution of a cell's
  independent tasks straightforward.
- **Works with a dumb store**: only `get`, prefix `scan` and atomic batch writes — maps onto
  SQLite/D1/Durable Objects/IndexedDB/a file.

What the others do better, to carry over:
- C/A make a no-op on a fresh engine free; B pays one empty queue scan (negligible).
- C writes the fewest rows when a hub fans out (no queue rows); B's queue writes are the price of
  durability of the to-do list.

### Shared weaknesses to fix in the real implementation

1. **Cold builds are ~12× slower than full recompute** in all three — one commit per task.
   → group commit (a batch of a cell's tasks per commit; a crash loses at most a batch).
2. **Reduce cells re-list their whole input** on any change. → incremental reduce
   (fold over the changed keys with the previous accumulator), or keyed group-by.
3. **Single writer per store**: the queue-token re-check (B) and stamp/revision counters (A, C) rely
   on an in-process lock. Multi-process use needs a conditional delete from storage (SQL can).
4. **Ownership hand-over** within one run (task X stops emitting a row that task Y starts emitting,
   Y runs first) fails Y in A/B/C where P0 accepts it — not covered by the suite yet.

Contract points surfaced by the prototype authors: `pending` is true only for interruption (not for
dead letters); a reduce cell runs once even over empty inputs (P0 semantics).
