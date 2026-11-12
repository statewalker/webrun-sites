/**
 * `BuildEngine` — an incremental, idempotent, resumable build engine over a
 * graph of cells and signals, keeping all of its state in an ordered KV store.
 *
 * Design: an eager dirty queue with a reverse-dependency index (chosen over a
 * changelog-cursor and a pull/verifying-traces design; see
 * packages/webrun-build-lab for the prototypes, the shared conformance suite
 * and the benchmark).
 *
 * - **Writes fan out at write time.** When a row's canonical value changes
 *   (source `put`/`remove`, a task emitting a different value, a retraction),
 *   every task depending on it is queued in the same commit: map tasks of cells
 *   keyed by the signal, the reduce task of cells aggregating it, tasks that
 *   read that exact row (`x/` index) and tasks that listed the signal (`xl/`).
 * - **The queue is keyed by topological rank**, so the first queue row is
 *   always the most upstream work. `run()` takes a batch of the first cell's
 *   tasks (a cell never reads its own outputs, so they are independent),
 *   executes them, and commits the batch atomically. A task never runs while a
 *   more upstream cell has queued work: a diamond's join runs once.
 * - **A commit** holds, per task: changed outputs plus the dependents they
 *   queue, retractions of outputs no longer emitted, the task's trace (reads,
 *   outputs) and reverse-index diff, the dequeue and the dead-letter clean-up.
 *   A crash loses at most the batch being committed; the queue is the durable
 *   to-do list. No work is proportional to the corpus: a no-op run is one empty
 *   queue scan.
 * - **A change landing while a task runs survives** its commit: queue rows
 *   carry a token, and the dequeue happens only if the token is still the
 *   claimed one. The store has no compare-and-set, so the re-check and the
 *   commit run under an in-process lock shared with `put`/`remove`: one engine
 *   per store at a time.
 *
 * KV layout (tuples joined with U+0001):
 *   r/<signal>/<key>                → <owner>\x02<canonical json>  (owner "" = source)
 *   q/<rank>/<cell>/<task>          → {"g": token, "a": attempts}
 *   f/<cell>/<task>                 → {"r": [[signal,key]…], "l": [signal…], "o": [[signal,key]…]}
 *   x/<signal>/<key>/<cell>/<task>  → ""
 *   xl/<signal>/<cell>/<task>       → ""
 *   d/<cell>/<task>                 → {"attempts": n, "error": text}
 */
import { canonicalJson } from "./canonical-json.js";
import { k, kp, seqKey, split } from "./keys.js";
import { type Logger, NULL_LOGGER } from "./logger.js";
import type { KV } from "./store/kv.js";
import { Topology } from "./topology.js";
import {
  type BuildEngineOptions,
  type BuildStatus,
  type CellDef,
  ConflictingEmission,
  type DeadLetter,
  type Json,
  type Row,
  type RunOptions,
  type RunStats,
  type TaskContext,
} from "./types.js";

type Write = { key: string; value?: string };
type Ref = [signal: string, key: string];
interface Trace {
  r: Ref[];
  l: string[];
  o: Ref[];
}
interface QueueRow {
  g: string;
  a: number;
}
interface Claim {
  cell: string;
  task: string;
  qkey: string;
  row: QueueRow;
}
type Emitted = Map<string, { ref: Ref; json: string }>;
type Outcome =
  | { claim: Claim; kind: "done"; prev: Trace; rawPrev?: string; next?: Trace; emitted: Emitted }
  | { claim: Claim; kind: "failed"; error: unknown };

const OWNER_SEP = "\u0002";
const EMPTY_TRACE: Trace = { r: [], l: [], o: [] };

export class BuildEngine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #log: Logger;
  /** Signals some task may `list` with an `xl/` record (declared reads, map inputs). */
  readonly #listable: Set<string>;
  readonly #id = Math.random().toString(36).slice(2, 10);
  #tokens = 0;
  #lock: Promise<void> = Promise.resolve();
  #running = false;

  constructor(opts: BuildEngineOptions) {
    this.#kv = opts.store;
    this.#topo = new Topology(opts.cells);
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#batchSize = Math.max(1, opts.batchSize ?? 64);
    this.#concurrency = Math.max(1, opts.concurrency ?? 1);
    this.#log = opts.logger ?? NULL_LOGGER;
    this.#listable = new Set(
      opts.cells.flatMap((c) => [...(c.reads ?? []), ...(c.kind === "reduce" ? [] : c.inputs)]),
    );
  }

  // ---- rows ---------------------------------------------------------------

  /** Write a source row. A value equal to the stored one changes nothing. */
  async put(signal: string, key: string, value: Json): Promise<boolean> {
    this.#topo.assertSource(signal);
    const json = canonicalJson(value);
    return this.#locked(async () => {
      const stored = await this.#row(signal, key);
      if (stored?.json === json) return false;
      const writes = new Map<string, Write>();
      set(writes, k("r", signal, key), `${OWNER_SEP}${json}`);
      await this.#enqueueDependents(signal, key, writes);
      await this.#kv.commit([...writes.values()]);
      return true;
    });
  }

  /** Remove a source row; everything derived from it is retracted by the next run. */
  async remove(signal: string, key: string): Promise<boolean> {
    this.#topo.assertSource(signal);
    return this.#locked(async () => {
      if ((await this.#row(signal, key)) === undefined) return false;
      const writes = new Map<string, Write>();
      set(writes, k("r", signal, key), undefined);
      await this.#enqueueDependents(signal, key, writes);
      await this.#kv.commit([...writes.values()]);
      return true;
    });
  }

  async get(signal: string, key: string): Promise<Json | undefined> {
    const row = await this.#row(signal, key);
    return row === undefined ? undefined : (JSON.parse(row.json) as Json);
  }

  /** All rows of a signal, ordered by key. */
  async list(signal: string): Promise<Row[]> {
    const out: Row[] = [];
    for await (const [key, raw] of this.#kv.scan(kp("r", signal))) {
      out.push({ key: split(key)[2] as string, value: JSON.parse(rowJson(raw)) as Json });
    }
    return out;
  }

  /** Keys of a signal, ordered (no values parsed). */
  async keys(signal: string): Promise<string[]> {
    const out: string[] = [];
    for await (const [key] of this.#kv.scan(kp("r", signal))) out.push(split(key)[2] as string);
    return out;
  }

  // ---- failures and maintenance --------------------------------------------

  async deadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for await (const [key, raw] of this.#kv.scan(kp("d"))) {
      const [, cell, task] = split(key);
      out.push({ cell: cell as string, key: task as string, ...JSON.parse(raw) });
    }
    return out;
  }

  /** Put a dead-lettered task back in the queue with a fresh attempt count. */
  async requeue(cell: string, key: string): Promise<void> {
    this.#topo.cell(cell);
    await this.#locked(() =>
      this.#kv.commit([
        { key: k("d", cell, key) },
        { key: this.#qkey(cell, key), value: this.#qrow() },
      ]),
    );
  }

  /**
   * Queue every task of `cell` — e.g. after its code changed. Downstream tasks
   * re-run only where its outputs actually change.
   */
  async invalidate(cell: string): Promise<void> {
    const def = this.#topo.cell(cell);
    const writes = new Map<string, Write>();
    if (def.kind === "reduce") {
      set(writes, this.#qkey(cell, "*"), this.#qrow());
    } else {
      for (const s of def.inputs) {
        for (const key of await this.keys(s)) set(writes, this.#qkey(cell, key), this.#qrow());
      }
      for await (const [fkey] of this.#kv.scan(kp("f", cell))) {
        set(writes, this.#qkey(cell, split(fkey)[2] as string), this.#qrow());
      }
    }
    if (writes.size > 0) await this.#locked(() => this.#kv.commit([...writes.values()]));
  }

  async status(): Promise<BuildStatus> {
    const queued: Record<string, number> = {};
    for await (const [qkey] of this.#kv.scan(kp("q"))) {
      const cell = split(qkey)[2] as string;
      queued[cell] = (queued[cell] ?? 0) + 1;
    }
    let deadLetters = 0;
    for await (const _ of this.#kv.scan(kp("d"))) deadLetters++;
    return { queued, deadLetters };
  }

  // ---- run ------------------------------------------------------------------

  /** Execute queued tasks, most upstream first, until the queue is empty. */
  async run(opts?: RunOptions): Promise<RunStats> {
    if (this.#running) throw new Error("BuildEngine.run is already in progress");
    this.#running = true;
    try {
      return await this.#run(opts);
    } finally {
      this.#running = false;
    }
  }

  async #run(opts?: RunOptions): Promise<RunStats> {
    const stats: RunStats = { executed: 0, failed: 0, deadLettered: 0, pending: false };
    const budget = opts?.maxTasks ?? Number.POSITIVE_INFINITY;
    await this.#seedReducers();
    let tasks = 0;
    for (;;) {
      if (opts?.signal?.aborted || tasks >= budget) {
        stats.pending = (await this.#nextBatch(1)).length > 0;
        return stats;
      }
      const batch = await this.#nextBatch(Math.min(this.#batchSize, budget - tasks));
      if (batch.length === 0) return stats;
      tasks += batch.length;
      const outcomes = await this.#executeAll(batch);
      await this.#commitBatch(outcomes, stats);
    }
  }

  async #executeAll(batch: Claim[]): Promise<Outcome[]> {
    const out: Outcome[] = new Array(batch.length);
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const i = next++;
        out[i] = await this.#execute(batch[i] as Claim);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#concurrency, batch.length) }, worker));
    return out;
  }

  /** The queued tasks of the most upstream cell that has any. */
  async #nextBatch(limit: number): Promise<Claim[]> {
    const out: Claim[] = [];
    let cell: string | undefined;
    for await (const [qkey, raw] of this.#kv.scan(kp("q"), { limit })) {
      const [, , c, task] = split(qkey) as [string, string, string, string];
      if (cell === undefined) cell = c;
      else if (c !== cell) break;
      out.push({ cell: c, task, qkey, row: JSON.parse(raw) as QueueRow });
    }
    return out;
  }

  /** A reduce cell runs at least once, even over empty inputs. */
  async #seedReducers(): Promise<void> {
    for (const id of this.#topo.order) {
      if (this.#topo.cell(id).kind !== "reduce") continue;
      if ((await this.#kv.get(k("f", id, "*"))) !== undefined) continue;
      if ((await this.#kv.get(this.#qkey(id, "*"))) !== undefined) continue;
      if ((await this.#kv.get(k("d", id, "*"))) !== undefined) continue;
      await this.#locked(() =>
        this.#kv.commit([{ key: this.#qkey(id, "*"), value: this.#qrow() }]),
      );
    }
  }

  #qkey(cell: string, task: string): string {
    return k("q", seqKey(this.#topo.rank.get(cell) as number), cell, task);
  }

  #qrow(attempts = 0): string {
    return JSON.stringify({ g: `${this.#id}.${++this.#tokens}`, a: attempts });
  }

  /** Queue every task that depends on row (signal, key). */
  async #enqueueDependents(signal: string, key: string, writes: Map<string, Write>): Promise<void> {
    for (const id of this.#topo.readersOf(signal)) {
      const cell = this.#topo.cell(id);
      if (!cell.inputs.includes(signal)) continue;
      set(writes, this.#qkey(id, cell.kind === "reduce" ? "*" : key), this.#qrow());
    }
    for await (const [xkey] of this.#kv.scan(kp("x", signal, key))) {
      const [, , , cell, task] = split(xkey) as [string, string, string, string, string];
      set(writes, this.#qkey(cell, task), this.#qrow());
    }
    if (!this.#listable.has(signal)) return;
    for await (const [xkey] of this.#kv.scan(kp("xl", signal))) {
      const [, , cell, task] = split(xkey) as [string, string, string, string];
      set(writes, this.#qkey(cell, task), this.#qrow());
    }
  }

  // ---- task execution -------------------------------------------------------

  async #execute(claim: Claim): Promise<Outcome> {
    const cell = this.#topo.cell(claim.cell);
    const rawPrev = await this.#kv.get(k("f", claim.cell, claim.task));
    const prev: Trace = rawPrev ? (JSON.parse(rawPrev) as Trace) : EMPTY_TRACE;
    try {
      if (cell.kind !== "reduce" && !(await this.#alive(cell, claim.task))) {
        // Dead task: clean up side effects, then retract (in the commit).
        await cell.dispose?.(
          claim.task,
          prev.o.map(([signal, key]) => ({ signal, key })),
        );
        return { claim, kind: "done", prev, rawPrev, emitted: new Map() };
      }
      const reads = new Map<string, Ref>();
      const lists = new Set<string>();
      const emitted: Emitted = new Map();
      await cell.run(this.#context(cell, claim.task, reads, lists, emitted));
      const self = k(claim.cell, claim.task);
      for (const { ref } of emitted.values()) {
        const row = await this.#row(ref[0], ref[1]);
        if (row && row.owner !== "" && row.owner !== self) {
          throw new ConflictingEmission(
            `${ref[0]}/${ref[1]}: already emitted by ${split(row.owner).join("/")}`,
          );
        }
      }
      const next: Trace = {
        r: [...reads.values()],
        l: [...lists],
        o: [...emitted.values()].map((e) => e.ref),
      };
      return { claim, kind: "done", prev, rawPrev, next, emitted };
    } catch (error) {
      return { claim, kind: "failed", error };
    }
  }

  /** A map task is alive while its key exists on at least one input signal. */
  async #alive(cell: CellDef, key: string): Promise<boolean> {
    for (const s of cell.inputs)
      if ((await this.#kv.get(k("r", s, key))) !== undefined) return true;
    return false;
  }

  #context(
    cell: CellDef,
    taskKey: string,
    reads: Map<string, Ref>,
    lists: Set<string>,
    emitted: Emitted,
  ): TaskContext {
    const readable = new Set([...cell.inputs, ...(cell.reads ?? [])]);
    const isMap = cell.kind !== "reduce";
    const check = (signal: string) => {
      if (!readable.has(signal)) throw new Error(`Cell "${cell.id}" read undeclared "${signal}"`);
    };
    return {
      key: taskKey,
      get: async (signal, key) => {
        check(signal);
        // A map task's own input rows are covered by key-triggering.
        if (!(isMap && key === taskKey && cell.inputs.includes(signal))) {
          reads.set(k(signal, key), [signal, key]);
        }
        const row = await this.#row(signal, key);
        return row === undefined ? undefined : (JSON.parse(row.json) as Json);
      },
      list: async (signal) => {
        check(signal);
        // A reduce cell's inputs are covered by signal-triggering.
        if (!(cell.kind === "reduce" && cell.inputs.includes(signal))) lists.add(signal);
        return this.list(signal);
      },
      emit: (signal, key, value) => {
        if (!cell.outputs.includes(signal)) {
          throw new Error(`Cell "${cell.id}" emitted to undeclared signal "${signal}"`);
        }
        const json = canonicalJson(value);
        const id = k(signal, key);
        const prior = emitted.get(id);
        if (prior && prior.json !== json) {
          throw new ConflictingEmission(`${signal}/${key}: emitted twice with different values`);
        }
        emitted.set(id, { ref: [signal, key], json });
      },
    };
  }

  /** Commit a batch of outcomes in one store transaction. */
  async #commitBatch(outcomes: Outcome[], stats: RunStats): Promise<void> {
    await this.#locked(async () => {
      const writes = new Map<string, Write>();
      // Rows written earlier in this batch shadow the stored ones.
      const overlay = new Map<string, { owner: string; json: string } | null>();
      const row = async (signal: string, key: string) => {
        const id = k(signal, key);
        if (overlay.has(id)) return overlay.get(id) ?? undefined;
        return this.#row(signal, key);
      };
      const failures: { claim: Claim; error: unknown }[] = [];
      for (const o of outcomes) {
        if (o.kind === "failed") {
          failures.push(o);
          continue;
        }
        const { cell, task } = o.claim;
        const self = k(cell, task);
        // Ownership against earlier tasks of the same batch.
        let conflict: string | undefined;
        for (const { ref } of o.emitted.values()) {
          const r = await row(ref[0], ref[1]);
          if (r && r.owner !== "" && r.owner !== self) conflict = `${ref[0]}/${ref[1]}`;
        }
        if (conflict) {
          failures.push({
            claim: o.claim,
            error: new ConflictingEmission(`${conflict}: emitted by another task of the batch`),
          });
          continue;
        }
        for (const { ref, json } of o.emitted.values()) {
          const r = await row(ref[0], ref[1]);
          if (r?.json === json) continue;
          set(writes, k("r", ref[0], ref[1]), `${self}${OWNER_SEP}${json}`);
          overlay.set(k(ref[0], ref[1]), { owner: self, json });
          await this.#enqueueDependents(ref[0], ref[1], writes);
        }
        for (const ref of o.prev.o) {
          if (o.emitted.has(k(ref[0], ref[1]))) continue;
          const r = await row(ref[0], ref[1]);
          if (r?.owner !== self) continue;
          set(writes, k("r", ref[0], ref[1]), undefined);
          overlay.set(k(ref[0], ref[1]), null);
          await this.#enqueueDependents(ref[0], ref[1], writes);
        }
        this.#traceWrites(cell, task, o.prev, o.rawPrev, o.next, writes);
        await this.#dequeue(o.claim, writes);
        if ((await this.#kv.get(k("d", cell, task))) !== undefined) {
          set(writes, k("d", cell, task), undefined);
        }
        stats.executed++;
      }
      for (const f of failures) await this.#failWrites(f.claim, f.error, writes, stats);
      if (writes.size > 0) await this.#kv.commit([...writes.values()]);
    });
  }

  #traceWrites(
    cell: string,
    task: string,
    prev: Trace,
    rawPrev: string | undefined,
    next: Trace | undefined,
    writes: Map<string, Write>,
  ): void {
    const nextRaw = next ? JSON.stringify(next) : undefined;
    if (nextRaw !== rawPrev) set(writes, k("f", cell, task), nextRaw);
    const before = new Set(prev.r.map((r) => k(r[0], r[1])));
    const after = new Set((next?.r ?? []).map((r) => k(r[0], r[1])));
    for (const id of before) if (!after.has(id)) set(writes, k("x", id, cell, task), undefined);
    for (const id of after) if (!before.has(id)) set(writes, k("x", id, cell, task), "");
    const lb = new Set(prev.l);
    const la = new Set(next?.l ?? []);
    for (const s of lb) if (!la.has(s)) set(writes, k("xl", s, cell, task), undefined);
    for (const s of la) if (!lb.has(s)) set(writes, k("xl", s, cell, task), "");
  }

  /** Dequeue unless re-queued since the claim (by this batch or a concurrent write). */
  async #dequeue(claim: Claim, writes: Map<string, Write>): Promise<void> {
    if (writes.has(claim.qkey)) return;
    const current = await this.#kv.get(claim.qkey);
    if (current !== undefined && (JSON.parse(current) as QueueRow).g === claim.row.g) {
      set(writes, claim.qkey, undefined);
    }
  }

  /** Count a failed attempt; dead-letter at `maxAttempts`. */
  async #failWrites(
    claim: Claim,
    error: unknown,
    writes: Map<string, Write>,
    stats: RunStats,
  ): Promise<void> {
    stats.failed++;
    this.#log.warn("task failed", { cell: claim.cell, key: claim.task, error });
    if (writes.has(claim.qkey)) return; // re-queued by this batch: fresh attempt
    const current = await this.#kv.get(claim.qkey);
    // A newer change re-queued it with a fresh attempt count: leave it.
    if (current === undefined || (JSON.parse(current) as QueueRow).g !== claim.row.g) return;
    const attempts = claim.row.a + 1;
    if (attempts < this.#maxAttempts) {
      set(writes, claim.qkey, JSON.stringify({ g: claim.row.g, a: attempts }));
      return;
    }
    stats.deadLettered++;
    this.#log.error("task dead-lettered", { cell: claim.cell, key: claim.task, error });
    set(writes, claim.qkey, undefined);
    set(
      writes,
      k("d", claim.cell, claim.task),
      JSON.stringify({ attempts, error: errorText(error) }),
    );
  }

  // ---- storage helpers --------------------------------------------------------

  async #row(signal: string, key: string): Promise<{ owner: string; json: string } | undefined> {
    const raw = await this.#kv.get(k("r", signal, key));
    if (raw === undefined) return undefined;
    const i = raw.indexOf(OWNER_SEP);
    return { owner: raw.slice(0, i), json: raw.slice(i + 1) };
  }

  /** Serialise read-check-commit sections (put/remove, batch commits). */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(fn);
    this.#lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function rowJson(raw: string): string {
  return raw.slice(raw.indexOf(OWNER_SEP) + 1);
}

function set(writes: Map<string, Write>, key: string, value: string | undefined): void {
  writes.set(key, { key, value });
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
