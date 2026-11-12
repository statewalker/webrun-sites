/**
 * Prototype B — eager dirty queue with a reverse-dependency index.
 *
 * Lineage: `webrun-builders` (a queue of (builder, key) work items committed
 * atomically with the builder's outputs and provenance), generalised from static
 * "input key → task" triggering to tracked dynamic reads.
 *
 * Writes fan out at write time. When a row's canonical value changes (source
 * `put`/`remove`, a task emitting a different value, a retraction), every task
 * that depends on it is queued in the same commit:
 *   - map tasks of builders keyed by the collection (the key itself),
 *   - the reduce task of builders aggregating the collection,
 *   - tasks that read that exact row (`x/` reverse index of `ctx.get` reads),
 *   - tasks that listed the whole collection (`xl/` index of `ctx.list` reads).
 * `run()` repeatedly takes the queued tasks of the most upstream builder (the
 * queue is keyed by topological rank, so the first row of a scan is always the
 * most upstream work) and executes them. A builder never reads its own outputs, so
 * tasks of one builder are independent and run as a batch; a task never runs while
 * a more upstream builder has queued work, which makes the schedule glitch-free.
 *
 * Each task commits atomically: its changed outputs (+ the consumers they
 * queue), retractions of outputs it no longer emits, its trace (reads and
 * outputs), reverse-index diffs, removal of its queue row and dead letter.
 * A crash loses only uncommitted tasks; the queue is the to-do list.
 *
 * Inherent costs: per changed row, one scan of each reverse index (usually
 * empty) plus one queue write per dependent task; per task, one queue scan
 * (amortised by batching) and reads of what it reads. Nothing is proportional
 * to the size of the corpus: a no-op run is one empty queue scan.
 *
 * KV layout (tuples encoded with util.k):
 *   r/<collection>/<key>              → <owner>\x02<canonical json>  (owner "" for sources)
 *   q/<rank>/<builder>/<task>        → {"g": token, "a": attempts}
 *   f/<builder>/<task>               → {"r": [[collection,key]…], "l": [collection…], "o": [[collection,key]…]}
 *   x/<collection>/<key>/<builder>/<task>  → ""   (task read that row)
 *   xl/<collection>/<builder>/<task>     → ""     (task listed that collection)
 *   d/<builder>/<task>               → {"attempts": n, "error": text}
 *
 * The queue token makes a change that lands while a task runs survive the
 * task's commit: the commit deletes the queue row only if it still carries the
 * token that was claimed. The KV has no compare-and-set, so the re-check and
 * the commit run under an in-process mutex shared with put/remove; several
 * processes on one store would need a conditional delete from the storage.
 */
import type { KV } from "../core/kv.js";
import {
  type BuilderDef,
  ConflictingEmission,
  type DeadLetter,
  type Engine,
  type EngineOptions,
  type Json,
  type RunOptions,
  type RunStats,
  type TaskContext,
} from "../core/types.js";
import { canonicalJson, errorText, k, kp, seqKey, split, Topology } from "../core/util.js";

type Write = { key: string; value?: string };
type Ref = [collection: string, key: string];
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
  builder: string;
  task: string;
  qkey: string;
  row: QueueRow;
}

const OWNER_SEP = "\u0002";
const EMPTY_TRACE: Trace = { r: [], l: [], o: [] };

export class QueueEngine implements Engine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;
  readonly #id = Math.random().toString(36).slice(2, 10);
  #tokens = 0;
  #lock: Promise<void> = Promise.resolve();

  constructor(opts: EngineOptions) {
    this.#kv = opts.kv;
    this.#topo = new Topology(opts.builders);
    this.#maxAttempts = opts.maxAttempts ?? 3;
  }

  // ---- public API ---------------------------------------------------------

  async put(collection: string, key: string, value: Json): Promise<void> {
    this.#topo.assertSource(collection);
    const json = canonicalJson(value);
    await this.#locked(async () => {
      const stored = await this.#row(collection, key);
      if (stored?.json === json) return;
      const writes = new Map<string, Write>();
      set(writes, k("r", collection, key), `${OWNER_SEP}${json}`);
      await this.#enqueueDependents(collection, key, writes);
      await this.#kv.commit([...writes.values()]);
    });
  }

  async remove(collection: string, key: string): Promise<void> {
    this.#topo.assertSource(collection);
    await this.#locked(async () => {
      if ((await this.#row(collection, key)) === undefined) return;
      const writes = new Map<string, Write>();
      set(writes, k("r", collection, key), undefined);
      await this.#enqueueDependents(collection, key, writes);
      await this.#kv.commit([...writes.values()]);
    });
  }

  async get(collection: string, key: string): Promise<Json | undefined> {
    const row = await this.#row(collection, key);
    return row === undefined ? undefined : (JSON.parse(row.json) as Json);
  }

  async list(collection: string): Promise<{ key: string; value: Json }[]> {
    const out: { key: string; value: Json }[] = [];
    for await (const [key, raw] of this.#kv.scan(kp("r", collection))) {
      out.push({ key: split(key)[2] as string, value: JSON.parse(rowJson(raw)) as Json });
    }
    return out;
  }

  async deadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for await (const [key, raw] of this.#kv.scan(kp("d"))) {
      const [, builder, task] = split(key);
      out.push({ builder: builder as string, key: task as string, ...JSON.parse(raw) });
    }
    return out;
  }

  async run(opts?: RunOptions): Promise<RunStats> {
    const stats: RunStats = { executed: 0, failed: 0, deadLettered: 0, pending: false };
    const budget = opts?.maxTasks ?? Number.POSITIVE_INFINITY;
    await this.#seedReducers();
    let tasks = 0;
    for (;;) {
      const batch = await this.#nextBatch();
      if (batch.length === 0) return stats;
      for (const claim of batch) {
        if (tasks >= budget) {
          stats.pending = true;
          return stats;
        }
        tasks++;
        await this.#execute(claim, stats);
      }
    }
  }

  // ---- scheduling ---------------------------------------------------------

  /** The queued tasks of the most upstream builder that has any. */
  async #nextBatch(limit = 64): Promise<Claim[]> {
    const out: Claim[] = [];
    let builder: string | undefined;
    for await (const [qkey, raw] of this.#kv.scan(kp("q"), { limit })) {
      const [, , c, task] = split(qkey) as [string, string, string, string];
      if (builder === undefined) builder = c;
      else if (c !== builder) break;
      out.push({ builder: c, task, qkey, row: JSON.parse(raw) as QueueRow });
    }
    return out;
  }

  /** A reduce builder runs at least once, even over empty inputs. */
  async #seedReducers(): Promise<void> {
    for (const id of this.#topo.order) {
      if (this.#topo.builder(id).kind !== "reduce") continue;
      if ((await this.#kv.get(k("f", id, "*"))) !== undefined) continue;
      if ((await this.#kv.get(this.#qkey(id, "*"))) !== undefined) continue;
      if ((await this.#kv.get(k("d", id, "*"))) !== undefined) continue;
      await this.#locked(() =>
        this.#kv.commit([{ key: this.#qkey(id, "*"), value: this.#qrow() }]),
      );
    }
  }

  #qkey(builder: string, task: string): string {
    return k("q", seqKey(this.#topo.rank.get(builder) as number), builder, task);
  }

  #qrow(attempts = 0): string {
    return JSON.stringify({ g: `${this.#id}.${++this.#tokens}`, a: attempts });
  }

  /** Queue every task that depends on row (collection, key); writes go to `writes`. */
  async #enqueueDependents(
    collection: string,
    key: string,
    writes: Map<string, Write>,
  ): Promise<void> {
    for (const id of this.#topo.readersOf(collection)) {
      const builder = this.#topo.builder(id);
      if (!builder.inputs.includes(collection)) continue;
      set(writes, this.#qkey(id, builder.kind === "reduce" ? "*" : key), this.#qrow());
    }
    for await (const [xkey] of this.#kv.scan(kp("x", collection, key))) {
      const [, , , builder, task] = split(xkey) as [string, string, string, string, string];
      set(writes, this.#qkey(builder, task), this.#qrow());
    }
    for await (const [xkey] of this.#kv.scan(kp("xl", collection))) {
      const [, , builder, task] = split(xkey) as [string, string, string, string];
      set(writes, this.#qkey(builder, task), this.#qrow());
    }
  }

  // ---- task execution -----------------------------------------------------

  async #execute(claim: Claim, stats: RunStats): Promise<void> {
    const builder = this.#topo.builder(claim.builder);
    const rawTrace = await this.#kv.get(k("f", claim.builder, claim.task));
    const trace: Trace = rawTrace ? (JSON.parse(rawTrace) as Trace) : EMPTY_TRACE;

    if (builder.kind !== "reduce" && !(await this.#alive(builder, claim.task))) {
      await this.#commitTask(claim, trace, rawTrace, undefined, new Map());
      stats.executed++;
      return;
    }

    const reads = new Map<string, Ref>();
    const lists = new Set<string>();
    const emitted = new Map<string, { ref: Ref; json: string }>();
    let error: unknown;
    let failed = false;
    try {
      await builder.run(this.#context(builder, claim.task, reads, lists, emitted));
      // Ownership: every emitted row must be unowned or owned by this task.
      const self = k(claim.builder, claim.task);
      for (const { ref } of emitted.values()) {
        const row = await this.#row(ref[0], ref[1]);
        if (row && row.owner !== "" && row.owner !== self) {
          throw new ConflictingEmission(
            `${ref[0]}/${ref[1]}: already emitted by ${split(row.owner).join("/")}`,
          );
        }
      }
    } catch (e) {
      failed = true;
      error = e;
    }
    if (failed) {
      stats.failed++;
      if (await this.#fail(claim, error)) stats.deadLettered++;
      return;
    }
    const next: Trace = {
      r: [...reads.values()],
      l: [...lists],
      o: [...emitted.values()].map((e) => e.ref),
    };
    await this.#commitTask(claim, trace, rawTrace, next, emitted);
    stats.executed++;
  }

  /** A map task is alive while its key exists on at least one input collection. */
  async #alive(builder: BuilderDef, key: string): Promise<boolean> {
    for (const s of builder.inputs)
      if ((await this.#kv.get(k("r", s, key))) !== undefined) return true;
    return false;
  }

  #context(
    builder: BuilderDef,
    taskKey: string,
    reads: Map<string, Ref>,
    lists: Set<string>,
    emitted: Map<string, { ref: Ref; json: string }>,
  ): TaskContext {
    const readable = new Set([...builder.inputs, ...(builder.reads ?? [])]);
    const isMap = builder.kind !== "reduce";
    const check = (collection: string) => {
      if (!readable.has(collection))
        throw new Error(`Builder "${builder.id}" read undeclared "${collection}"`);
    };
    return {
      key: taskKey,
      get: async (collection, key) => {
        check(collection);
        // A map task's own input rows are covered by static triggering.
        if (!(isMap && key === taskKey && builder.inputs.includes(collection))) {
          reads.set(k(collection, key), [collection, key]);
        }
        const row = await this.#row(collection, key);
        return row === undefined ? undefined : (JSON.parse(row.json) as Json);
      },
      list: async (collection) => {
        check(collection);
        if (!(builder.kind === "reduce" && builder.inputs.includes(collection)))
          lists.add(collection);
        return this.list(collection);
      },
      emit: (collection, key, value) => {
        if (!builder.outputs.includes(collection)) {
          throw new Error(
            `Builder "${builder.id}" emitted to undeclared collection "${collection}"`,
          );
        }
        const json = canonicalJson(value);
        const id = k(collection, key);
        const prior = emitted.get(id);
        if (prior && prior.json !== json) {
          throw new ConflictingEmission(
            `${collection}/${key}: emitted twice with different values`,
          );
        }
        emitted.set(id, { ref: [collection, key], json });
      },
    };
  }

  /**
   * Commit a task: outputs that changed (queueing their dependents), outputs
   * no longer emitted (retracted, queueing dependents), the trace and the
   * reverse-index diff, and the dequeue — if no newer change re-queued it.
   * `next === undefined` retracts a dead task entirely.
   */
  async #commitTask(
    claim: Claim,
    prev: Trace,
    rawPrev: string | undefined,
    next: Trace | undefined,
    emitted: Map<string, { ref: Ref; json: string }>,
  ): Promise<void> {
    const { builder, task } = claim;
    const self = k(builder, task);
    await this.#locked(async () => {
      const writes = new Map<string, Write>();
      for (const { ref, json } of emitted.values()) {
        const row = await this.#row(ref[0], ref[1]);
        if (row?.json === json) continue;
        set(writes, k("r", ref[0], ref[1]), `${self}${OWNER_SEP}${json}`);
        await this.#enqueueDependents(ref[0], ref[1], writes);
      }
      for (const ref of prev.o) {
        if (emitted.has(k(ref[0], ref[1]))) continue;
        const row = await this.#row(ref[0], ref[1]);
        if (row?.owner !== self) continue;
        set(writes, k("r", ref[0], ref[1]), undefined);
        await this.#enqueueDependents(ref[0], ref[1], writes);
      }
      // Trace + reverse index.
      const nextRaw = next ? JSON.stringify(next) : undefined;
      if (nextRaw !== rawPrev) set(writes, k("f", builder, task), nextRaw);
      const before = new Set(prev.r.map((r) => k(r[0], r[1])));
      const after = new Set((next?.r ?? []).map((r) => k(r[0], r[1])));
      for (const id of before)
        if (!after.has(id)) set(writes, k("x", id, builder, task), undefined);
      for (const id of after) if (!before.has(id)) set(writes, k("x", id, builder, task), "");
      const lb = new Set(prev.l);
      const la = new Set(next?.l ?? []);
      for (const s of lb) if (!la.has(s)) set(writes, k("xl", s, builder, task), undefined);
      for (const s of la) if (!lb.has(s)) set(writes, k("xl", s, builder, task), "");
      // Dequeue unless re-queued since the claim (by a dependency we just wrote,
      // or by a write that landed while the task ran).
      if (!writes.has(claim.qkey)) {
        const current = await this.#kv.get(claim.qkey);
        if (current !== undefined && (JSON.parse(current) as QueueRow).g === claim.row.g) {
          set(writes, claim.qkey, undefined);
        }
      }
      if ((await this.#kv.get(k("d", builder, task))) !== undefined) {
        set(writes, k("d", builder, task), undefined);
      }
      await this.#kv.commit([...writes.values()]);
    });
  }

  /** Count a failed attempt; dead-letter at `maxAttempts`. Returns true when dead-lettered. */
  async #fail(claim: Claim, error: unknown): Promise<boolean> {
    const attempts = claim.row.a + 1;
    return this.#locked(async () => {
      const current = await this.#kv.get(claim.qkey);
      // A newer change re-queued it with a fresh attempt count: leave it.
      if (current === undefined || (JSON.parse(current) as QueueRow).g !== claim.row.g) {
        return false;
      }
      if (attempts < this.#maxAttempts) {
        await this.#kv.commit([
          { key: claim.qkey, value: JSON.stringify({ g: claim.row.g, a: attempts }) },
        ]);
        claim.row.a = attempts;
        return false;
      }
      await this.#kv.commit([
        { key: claim.qkey },
        {
          key: k("d", claim.builder, claim.task),
          value: JSON.stringify({ attempts, error: errorText(error) }),
        },
      ]);
      return true;
    });
  }

  // ---- storage helpers ----------------------------------------------------

  async #row(
    collection: string,
    key: string,
  ): Promise<{ owner: string; json: string } | undefined> {
    const raw = await this.#kv.get(k("r", collection, key));
    if (raw === undefined) return undefined;
    const i = raw.indexOf(OWNER_SEP);
    return { owner: raw.slice(0, i), json: raw.slice(i + 1) };
  }

  /** Serialise read-check-commit sections (put/remove, task commits). */
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
