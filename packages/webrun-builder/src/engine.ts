/**
 * `BuildEngine` — an incremental, idempotent, resumable build engine over a
 * graph of builders and collections, keeping all of its state in an ordered KV store.
 *
 * Design: an eager dirty queue with a reverse-dependency index (chosen over a
 * changelog-cursor and a pull/verifying-traces design; see
 * packages/webrun-build-lab for the prototypes, the shared conformance suite
 * and the benchmark).
 *
 * - **Writes fan out at write time.** When a row's canonical value changes
 *   (source `put`/`remove`, a task emitting a different value, a retraction),
 *   every task depending on it is queued in the same commit: map tasks of builders
 *   keyed by the collection, the reduce task of builders aggregating it, tasks that
 *   read that exact row (`x/` index) and tasks that listed the collection (`xl/`).
 * - **The queue is keyed by topological rank**, so the first queue row is
 *   always the most upstream work. `run()` claims a batch of the first builder's
 *   tasks (a builder never reads its own outputs, so they are independent),
 *   executes them, and commits the batch atomically. A task never runs while a
 *   more upstream builder has queued work: a diamond's join runs once.
 * - **Verify before execute.** A map task's trace keeps a fingerprint of every
 *   row it read. A queued map task whose reads all match (a change undone
 *   before the run: remove + put back) is dequeued without running. Tasks that
 *   listed a collection always run; `invalidate`/`requeue` drop the fingerprints.
 * - **A commit** holds, per task: changed outputs plus the dependents they
 *   queue, retractions of outputs no longer emitted, the trace (reads with
 *   hashes, outputs, state) and reverse-index diff, the dequeue and the
 *   dead-letter clean-up. A crash loses at most the batch being committed; the
 *   queue is the durable to-do list. A no-op run is one empty queue scan.
 * - **Concurrent writes are never lost.** The dequeue is conditional on the
 *   queue row still holding the claimed value, so a change that re-queued the
 *   task while it ran keeps it queued. A task that read source rows other than
 *   its own key first registers those reads in the reverse index, then checks
 *   they are unchanged before committing; a write landing in between finds the
 *   registration and re-queues it.
 * - **Several engines may share a store** (`shared: true`) whose writes support
 *   conditions: claims are leases (owner + expiry) taken with conditional
 *   writes, and every write of a task's commit is guarded by its claim, so the
 *   result of an engine whose claim went stale is dropped as a whole. Alone on
 *   a store, an engine claims without writing.
 *
 * KV layout (tuples joined with U+0001):
 *   r/<collection>/<key>                → <owner>\x02<canonical json>  (owner "" = source)
 *   q/<rank>/<builder>/<task>          → {"g": token, "a": attempts, "o"?: owner, "u"?: lease end}
 *   f/<builder>/<task>                 → {"r": reads, "l": lists, "o": outputs, "i"/"rh": read fingerprints, "s"?: state}
 *   x/<collection>/<key>/<builder>/<task>  → ""
 *   xl/<collection>/<builder>/<task>       → ""
 *   c/<builder>/<collection>/<key>         → {"p": previous json | null, "g": token}  (incremental reduce)
 *   d/<builder>/<task>                 → {"attempts": n, "error": text}
 */
import { canonicalJson } from "./canonical-json.js";
import { assertName, k, kp, SEP, seqKey, split } from "./keys.js";
import { type Logger, NULL_LOGGER } from "./logger.js";
import type { KV, KvWrite } from "./store/kv.js";
import { Topology } from "./topology.js";
import {
  type BuildEngineOptions,
  type BuilderDef,
  type BuildStatus,
  type Change,
  ConflictingEmission,
  type DeadLetter,
  type Json,
  type Row,
  type RunOptions,
  type RunStats,
  type TaskContext,
} from "./types.js";

type Ref = [collection: string, key: string];
interface Trace {
  r: Ref[];
  l: string[];
  o: Ref[];
  /** Map tasks: fingerprints of the own input rows, aligned with the builder's `inputs` ("-" = absent). */
  i?: string[];
  /** Fingerprints of the rows in `r`, aligned with it. */
  rh?: string[];
  s?: Json;
}
interface QueueRow {
  g: string;
  a: number;
  o?: string;
  u?: number;
}
interface Claim {
  builder: string;
  task: string;
  qkey: string;
  /** The queue row value as claimed (with our lease): the dequeue condition. */
  raw: string;
  row: QueueRow;
}
type StoredRow = { owner: string; json: string };
type Emitted = Map<string, { ref: Ref; json: string }>;
interface Done {
  claim: Claim;
  kind: "done";
  prev: Trace;
  rawPrev?: string;
  next?: Trace;
  emitted: Emitted;
  /** Change records consumed by an incremental reduce task: key → raw value. */
  consumed: Map<string, string>;
  /** Source rows read beyond the task's own key, validated before commit. */
  validate: { ref: Ref; hash: string }[];
  /** Source collections listed (not implied by the builder's inputs), validated before commit. */
  validateLists: { collection: string; hash: string }[];
}
type Outcome =
  | Done
  | { claim: Claim; kind: "skip" }
  | { claim: Claim; kind: "failed"; error: unknown };

const OWNER_SEP = "\u0002";
const EMPTY_TRACE: Trace = { r: [], l: [], o: [] };
const ABSENT = "-";

export class BuildEngine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #concurrency: number;
  readonly #leaseMs: number;
  readonly #shared: boolean;
  readonly #now: () => number;
  readonly #owner: string;
  readonly #log: Logger;
  /** Collections some task may `list` with an `xl/` record (declared reads, map inputs). */
  readonly #listable: Set<string>;
  /** Incremental reduce builders by input collection. */
  readonly #folders = new Map<string, string[]>();
  #tokens = 0;
  /** Source writes (put/remove) made by this engine — a batch validates only if one landed meanwhile. */
  #sourceWrites = 0;
  #lock: Promise<void> = Promise.resolve();
  #running = false;

  constructor(opts: BuildEngineOptions) {
    this.#kv = opts.store;
    this.#topo = new Topology(opts.builders);
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#batchSize = Math.max(1, opts.batchSize ?? 64);
    this.#concurrency = Math.max(1, opts.concurrency ?? 1);
    this.#leaseMs = opts.leaseMs ?? 30_000;
    this.#shared = opts.shared ?? false;
    this.#now = opts.now ?? Date.now;
    this.#owner = opts.owner ?? Math.random().toString(36).slice(2, 10);
    this.#log = opts.logger ?? NULL_LOGGER;
    this.#listable = new Set(
      opts.builders.flatMap((c) => [...(c.reads ?? []), ...(c.kind === "reduce" ? [] : c.inputs)]),
    );
    for (const c of opts.builders) {
      if (!c.incremental) continue;
      if (c.kind !== "reduce")
        throw new Error(`Builder "${c.id}": only reduce builders can be incremental`);
      if (this.#shared) {
        // Its change records are consumed with a read-check-commit that only one engine can fence.
        throw new Error(
          `Builder "${c.id}": incremental reduce builders are not supported with shared: true`,
        );
      }
      for (const s of c.inputs) this.#folders.set(s, [...(this.#folders.get(s) ?? []), c.id]);
    }
  }

  // ---- rows ---------------------------------------------------------------

  /** Write a source row. A value equal to the stored one changes nothing. */
  async put(collection: string, key: string, value: Json): Promise<boolean> {
    this.#topo.assertSource(collection);
    assertName("Row key", key);
    const json = canonicalJson(value);
    return this.#locked(async () => {
      const stored = await this.#row(collection, key);
      if (stored?.json === json) return false;
      const writes = new Map<string, KvWrite>();
      set(writes, k("r", collection, key), `${OWNER_SEP}${json}`);
      await this.#enqueueDependents(collection, key, stored?.json, writes);
      await this.#kv.commit([...writes.values()]);
      this.#sourceWrites++;
      return true;
    });
  }

  /** Remove a source row; everything derived from it is retracted by the next run. */
  async remove(collection: string, key: string): Promise<boolean> {
    this.#topo.assertSource(collection);
    assertName("Row key", key);
    return this.#locked(async () => {
      const stored = await this.#row(collection, key);
      if (stored === undefined) return false;
      const writes = new Map<string, KvWrite>();
      set(writes, k("r", collection, key), undefined);
      await this.#enqueueDependents(collection, key, stored.json, writes);
      await this.#kv.commit([...writes.values()]);
      this.#sourceWrites++;
      return true;
    });
  }

  async get(collection: string, key: string): Promise<Json | undefined> {
    const row = await this.#row(collection, key);
    return row === undefined ? undefined : (JSON.parse(row.json) as Json);
  }

  /** All rows of a collection, ordered by key. */
  async list(collection: string): Promise<Row[]> {
    const out: Row[] = [];
    for await (const [key, raw] of this.#kv.scan(kp("r", collection))) {
      out.push({ key: split(key)[2] as string, value: JSON.parse(rowJson(raw)) as Json });
    }
    return out;
  }

  /** Keys of a collection, ordered (no values parsed). */
  async keys(collection: string): Promise<string[]> {
    const out: string[] = [];
    for await (const [key] of this.#kv.scan(kp("r", collection))) out.push(split(key)[2] as string);
    return out;
  }

  // ---- failures and maintenance --------------------------------------------

  async deadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for await (const [key, raw] of this.#kv.scan(kp("d"))) {
      const [, builder, task] = split(key);
      out.push({ builder: builder as string, key: task as string, ...JSON.parse(raw) });
    }
    return out;
  }

  /**
   * Put a dead-lettered task back in the queue with a fresh attempt count. It
   * runs even if its inputs are unchanged (its code may have been fixed).
   */
  async requeue(builder: string, key: string): Promise<void> {
    this.#topo.builder(builder);
    const writes = new Map<string, KvWrite>();
    await this.#forget(builder, key, writes);
    set(writes, k("d", builder, key), undefined);
    set(writes, this.#qkey(builder, key), this.#qrow());
    await this.#locked(() => this.#kv.commit([...writes.values()]));
  }

  /**
   * Queue every task of `builder` — e.g. after its code changed. They run even if
   * their inputs are unchanged; downstream tasks re-run only where the outputs
   * actually change. An incremental reduce starts again from an empty state.
   */
  async invalidate(builder: string): Promise<void> {
    const def = this.#topo.builder(builder);
    const writes = new Map<string, KvWrite>();
    const tasks = new Set<string>();
    if (def.kind === "reduce") tasks.add("*");
    else {
      for (const s of def.inputs) for (const key of await this.keys(s)) tasks.add(key);
      for await (const [fkey] of this.#kv.scan(kp("f", builder)))
        tasks.add(split(fkey)[2] as string);
    }
    for (const task of tasks) {
      await this.#forget(builder, task, writes);
      set(writes, this.#qkey(builder, task), this.#qrow());
    }
    if (writes.size > 0) await this.#locked(() => this.#kv.commit([...writes.values()]));
  }

  /**
   * Drop what lets a task skip or resume: its read fingerprints and its
   * incremental state. Kept in the trace (not the queue row), so a later
   * re-queue by a write cannot undo it; the next successful run rewrites them.
   */
  async #forget(builder: string, task: string, writes: Map<string, KvWrite>): Promise<void> {
    const raw = await this.#kv.get(k("f", builder, task));
    if (raw === undefined) return;
    const { i: _i, rh: _rh, s: _s, ...rest } = JSON.parse(raw) as Trace;
    set(writes, k("f", builder, task), JSON.stringify(rest));
  }

  async status(): Promise<BuildStatus> {
    const queued: Record<string, number> = {};
    for await (const [qkey] of this.#kv.scan(kp("q"))) {
      const builder = split(qkey)[2] as string;
      queued[builder] = (queued[builder] ?? 0) + 1;
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
    const stats: RunStats = { executed: 0, skipped: 0, failed: 0, deadLettered: 0, pending: false };
    const budget = opts?.maxTasks ?? Number.POSITIVE_INFINITY;
    await this.#seedReducers();
    let tasks = 0;
    for (;;) {
      if (opts?.signal?.aborted || tasks >= budget) {
        stats.pending = (await this.#peekQueue()) !== undefined;
        return stats;
      }
      const { claims, blocked } = await this.#claimBatch(Math.min(this.#batchSize, budget - tasks));
      if (claims.length === 0) {
        stats.pending = blocked;
        return stats;
      }
      tasks += claims.length;
      const writesBefore = this.#sourceWrites;
      const outcomes = await this.#executeAll(claims);
      await this.#commitBatch(outcomes, stats, writesBefore);
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

  async #peekQueue(): Promise<string | undefined> {
    for await (const [qkey] of this.#kv.scan(kp("q"), { limit: 1 })) return qkey;
    return undefined;
  }

  /**
   * Claim (lease) up to `limit` queued tasks of the most upstream builder that has
   * any. `blocked` when that builder's work is all leased by other engines.
   */
  async #claimBatch(limit: number): Promise<{ claims: Claim[]; blocked: boolean }> {
    const now = this.#now();
    const candidates: {
      builder: string;
      task: string;
      qkey: string;
      raw: string;
      row: QueueRow;
    }[] = [];
    // Rows of builders no longer in the graph are dropped; rows queued under an old
    // rank (the builder set changed) move to the current one, keeping upstream-first.
    const fixes: KvWrite[] = [];
    let builder: string | undefined;
    let leasedByOthers = false;
    for await (const [qkey, raw] of this.#kv.scan(kp("q"))) {
      const [, , c, task] = split(qkey) as [string, string, string, string];
      if (!this.#topo.builders.has(c)) {
        fixes.push({ key: qkey, ifValue: raw });
        continue;
      }
      const current = this.#qkey(c, task);
      if (current !== qkey) {
        fixes.push({ key: current, value: raw, ifValue: null }, { key: qkey, ifValue: raw });
        continue;
      }
      if (builder === undefined) builder = c;
      else if (c !== builder) break;
      const row = JSON.parse(raw) as QueueRow;
      if (row.o !== undefined && row.o !== this.#owner && (row.u ?? 0) > now) {
        leasedByOthers = true;
        continue;
      }
      candidates.push({ builder: c, task, qkey, raw, row });
      if (candidates.length >= limit) break;
    }
    if (fixes.length > 0) {
      await this.#locked(() => this.#kv.commit(fixes));
      return this.#claimBatch(limit);
    }
    if (candidates.length === 0) return { claims: [], blocked: leasedByOthers };
    // Alone on the store: no lease to take; the dequeue stays conditional.
    if (!this.#shared) return { claims: candidates, blocked: false };
    const leased = candidates.map((c) =>
      JSON.stringify({ ...c.row, o: this.#owner, u: now + this.#leaseMs } satisfies QueueRow),
    );
    const applied = await this.#kv.commit(
      candidates.map((c, i) => ({ key: c.qkey, value: leased[i] as string, ifValue: c.raw })),
    );
    const claims: Claim[] = [];
    candidates.forEach((c, i) => {
      if (applied[i]) {
        claims.push({ ...c, raw: leased[i] as string, row: JSON.parse(leased[i] as string) });
      }
    });
    // Rows lost to a race (re-queued or claimed meanwhile) are simply retried.
    return { claims, blocked: claims.length === 0 };
  }

  /** A reduce builder runs at least once, even over empty inputs. */
  async #seedReducers(): Promise<void> {
    for (const id of this.#topo.order) {
      if (this.#topo.builder(id).kind !== "reduce") continue;
      if ((await this.#kv.get(k("f", id, "*"))) !== undefined) continue;
      if ((await this.#kv.get(k("d", id, "*"))) !== undefined) continue;
      await this.#kv.commit([{ key: this.#qkey(id, "*"), value: this.#qrow(), ifValue: null }]);
    }
  }

  #qkey(builder: string, task: string): string {
    return k("q", seqKey(this.#topo.rank.get(builder) as number), builder, task);
  }

  #token(): string {
    return `${this.#owner}.${++this.#tokens}`;
  }

  #qrow(): string {
    return JSON.stringify({ g: this.#token(), a: 0 } satisfies QueueRow);
  }

  /**
   * Queue every task that depends on row (collection, key), whose value before
   * this change was `previous`; for incremental reducers, also record it.
   */
  async #enqueueDependents(
    collection: string,
    key: string,
    previous: string | undefined,
    writes: Map<string, KvWrite>,
  ): Promise<void> {
    for (const id of this.#topo.readersOf(collection)) {
      const builder = this.#topo.builder(id);
      if (!builder.inputs.includes(collection)) continue;
      set(writes, this.#qkey(id, builder.kind === "reduce" ? "*" : key), this.#qrow());
    }
    for (const id of this.#folders.get(collection) ?? []) {
      // Keep the value at the reducer's last run (the first change's previous
      // value) and refresh the token on every change, so a change landing while
      // the reducer runs is seen as new.
      const ckey = k("c", id, collection, key);
      const existing = writes.get(ckey)?.value ?? (await this.#kv.get(ckey));
      const p =
        existing === undefined
          ? (previous ?? null)
          : (JSON.parse(existing) as { p: string | null }).p;
      set(writes, ckey, JSON.stringify({ p, g: this.#token() }));
    }
    for await (const [xkey] of this.#kv.scan(kp("x", collection, key))) {
      const [, , , builder, task] = split(xkey) as [string, string, string, string, string];
      set(writes, this.#qkey(builder, task), this.#qrow());
    }
    if (!this.#listable.has(collection)) return;
    for await (const [xkey] of this.#kv.scan(kp("xl", collection))) {
      const [, , builder, task] = split(xkey) as [string, string, string, string];
      set(writes, this.#qkey(builder, task), this.#qrow());
    }
  }

  // ---- task execution -------------------------------------------------------

  async #execute(claim: Claim): Promise<Outcome> {
    const builder = this.#topo.builder(claim.builder);
    const rawPrev = await this.#kv.get(k("f", claim.builder, claim.task));
    const prev: Trace = rawPrev ? (JSON.parse(rawPrev) as Trace) : EMPTY_TRACE;
    /** Rows fetched for this task (verification and `ctx.get` share them). */
    const cache = new Map<string, StoredRow | undefined>();
    const fetch = async (collection: string, key: string) => {
      const id = k(collection, key);
      if (!cache.has(id)) cache.set(id, await this.#row(collection, key));
      return cache.get(id);
    };
    try {
      if (builder.kind !== "reduce") {
        let alive = false;
        for (const s of builder.inputs)
          if ((await fetch(s, claim.task)) !== undefined) alive = true;
        if (!alive) {
          // Dead task: clean up side effects, then retract (in the commit).
          await builder.dispose?.(
            claim.task,
            prev.o.map(([collection, key]) => ({ collection, key })),
          );
          return this.#done(claim, prev, rawPrev, undefined, new Map(), new Map(), [], []);
        }
        if (prev.i && prev.rh && (await this.#unchanged(builder, claim.task, prev, fetch))) {
          return { claim, kind: "skip" };
        }
      }
      return await this.#runTask(builder, claim, prev, rawPrev, fetch);
    } catch (error) {
      return { claim, kind: "failed", error };
    }
  }

  /** Whether every row the task read last time (own inputs first) is unchanged. */
  async #unchanged(
    builder: BuilderDef,
    task: string,
    prev: Trace,
    fetch: (collection: string, key: string) => Promise<StoredRow | undefined>,
  ): Promise<boolean> {
    const fp = (row: StoredRow | undefined) => (row === undefined ? ABSENT : fingerprint(row.json));
    // Whole-collection reads carry no fingerprint: such a task always runs when queued.
    if (prev.l.length > 0) return false;
    if (prev.i?.length !== builder.inputs.length || prev.rh?.length !== prev.r.length) return false;
    for (let j = 0; j < builder.inputs.length; j++) {
      if (fp(await fetch(builder.inputs[j] as string, task)) !== prev.i[j]) return false;
    }
    for (let j = 0; j < prev.r.length; j++) {
      const [collection, key] = prev.r[j] as Ref;
      if (fp(await fetch(collection, key)) !== prev.rh[j]) return false;
    }
    return true;
  }

  async #runTask(
    builder: BuilderDef,
    claim: Claim,
    prev: Trace,
    rawPrev: string | undefined,
    fetch: (collection: string, key: string) => Promise<StoredRow | undefined>,
  ): Promise<Outcome> {
    const taskKey = claim.task;
    const readable = new Set([...builder.inputs, ...(builder.reads ?? [])]);
    const isMap = builder.kind !== "reduce";
    const reads = new Map<string, Ref>();
    const hashes: Record<string, string> = {};
    const lists = new Set<string>();
    const emitted: Emitted = new Map();
    const validate: Done["validate"] = [];
    const validateLists: Done["validateLists"] = [];
    let state = prev.s;
    // Incremental reduce: snapshot the change records now; the commit removes exactly these.
    const consumed = new Map<string, string>();
    const changes = new Map<string, { key: string; previous: string | null }[]>();
    if (builder.incremental) {
      for await (const [ckey, raw] of this.#kv.scan(kp("c", builder.id))) {
        const [, , collection, key] = split(ckey) as [string, string, string, string];
        consumed.set(ckey, raw);
        const list = changes.get(collection) ?? [];
        list.push({ key, previous: (JSON.parse(raw) as { p: string | null }).p });
        changes.set(collection, list);
      }
    }
    const check = (collection: string) => {
      if (!readable.has(collection))
        throw new Error(`Builder "${builder.id}" read undeclared "${collection}"`);
    };
    const incrementalOnly = (what: string) => {
      if (!builder.incremental)
        throw new Error(`Builder "${builder.id}": ${what} needs an incremental reduce builder`);
    };
    const ctx: TaskContext = {
      key: taskKey,
      get: async (collection, key) => {
        check(collection);
        const own = isMap && key === taskKey && builder.inputs.includes(collection);
        const row = await fetch(collection, key);
        const hash = row === undefined ? ABSENT : fingerprint(row.json);
        hashes[k(collection, key)] = hash;
        // A map task's own input rows are covered by key-triggering.
        if (!own) {
          reads.set(k(collection, key), [collection, key]);
          if (!this.#topo.derived.has(collection)) validate.push({ ref: [collection, key], hash });
        }
        return row === undefined ? undefined : (JSON.parse(row.json) as Json);
      },
      list: async (collection) => {
        check(collection);
        const rows = await this.list(collection);
        // A reduce builder's inputs are covered by collection-triggering.
        if (!(builder.kind === "reduce" && builder.inputs.includes(collection))) {
          lists.add(collection);
          if (!this.#topo.derived.has(collection)) {
            validateLists.push({
              collection,
              hash: fingerprint(canonicalJson(rows as unknown as Json)),
            });
          }
        }
        return rows;
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
      get state() {
        incrementalOnly("ctx.state");
        return state;
      },
      setState: (value) => {
        incrementalOnly("ctx.setState");
        canonicalJson(value);
        state = value;
      },
      changes: async (collection) => {
        incrementalOnly("ctx.changes");
        if (!builder.inputs.includes(collection)) {
          throw new Error(
            `Builder "${builder.id}": changes() of "${collection}", which is not an input`,
          );
        }
        const out: Change[] = [];
        for (const c of changes.get(collection) ?? []) {
          const row = await this.#row(collection, c.key);
          out.push({
            key: c.key,
            value: row === undefined ? undefined : (JSON.parse(row.json) as Json),
            previous: c.previous === null ? undefined : (JSON.parse(c.previous) as Json),
          });
        }
        return out;
      },
    };
    await builder.run(ctx);
    // A map task depends on its own input rows whether or not it read them.
    if (isMap) {
      for (const s of builder.inputs) {
        const row = await fetch(s, taskKey);
        hashes[k(s, taskKey)] = row === undefined ? ABSENT : fingerprint(row.json);
      }
    }
    const self = k(claim.builder, claim.task);
    for (const { ref } of emitted.values()) {
      const row = await this.#row(ref[0], ref[1]);
      if (row && row.owner !== "" && row.owner !== self && !(await this.#stale(row.owner))) {
        throw new ConflictingEmission(
          `${ref[0]}/${ref[1]}: already emitted by ${split(row.owner).join("/")}`,
        );
      }
    }
    const next: Trace = {
      r: [...reads.values()],
      l: [...lists],
      o: [...emitted.values()].map((e) => e.ref),
      ...(isMap ? { i: builder.inputs.map((s) => hashes[k(s, taskKey)] as string) } : {}),
      rh: [...reads.keys()].map((id) => hashes[id] as string),
      ...(builder.incremental && state !== undefined ? { s: state } : {}),
    };
    return this.#done(claim, prev, rawPrev, next, emitted, consumed, validate, validateLists);
  }

  #done(
    claim: Claim,
    prev: Trace,
    rawPrev: string | undefined,
    next: Trace | undefined,
    emitted: Emitted,
    consumed: Map<string, string>,
    validate: Done["validate"],
    validateLists: Done["validateLists"],
  ): Done {
    return { claim, kind: "done", prev, rawPrev, next, emitted, consumed, validate, validateLists };
  }

  /** An owner task that is itself queued is stale: it may let go of the row when it runs. */
  async #stale(owner: string): Promise<boolean> {
    const [builder, task] = split(owner) as [string, string];
    if (!this.#topo.builders.has(builder)) return true;
    return (await this.#kv.get(this.#qkey(builder, task))) !== undefined;
  }

  /**
   * For tasks that read source rows beyond their own key: check those rows are
   * unchanged. Shared stores first register the new reverse-index entries: a
   * write from another engine landing before the registration is caught by the
   * check; one landing after finds the registration and re-queues the task.
   * Returns false if stale.
   */
  async #validate(o: Done): Promise<boolean> {
    if (o.validate.length === 0 && o.validateLists.length === 0) return true;
    if (this.#shared) await this.#register(o);
    for (const { ref, hash } of o.validate) {
      const row = await this.#row(ref[0], ref[1]);
      if ((row === undefined ? ABSENT : fingerprint(row.json)) !== hash) return false;
    }
    for (const { collection, hash } of o.validateLists) {
      if (fingerprint(canonicalJson((await this.list(collection)) as unknown as Json)) !== hash) {
        return false;
      }
    }
    return true;
  }

  /** Commit the task's new reverse-index entries for source reads ahead of its results. */
  async #register(o: Done): Promise<void> {
    const { builder, task } = o.claim;
    const had = new Set(o.prev.r.map((r) => k(r[0], r[1])));
    const hadLists = new Set(o.prev.l);
    const register: KvWrite[] = [];
    for (const { ref } of o.validate) {
      if (!had.has(k(ref[0], ref[1])))
        register.push({ key: k("x", ref[0], ref[1], builder, task), value: "" });
    }
    for (const { collection } of o.validateLists) {
      if (!hadLists.has(collection))
        register.push({ key: k("xl", collection, builder, task), value: "" });
    }
    if (register.length > 0) await this.#kv.commit(register);
  }

  /**
   * Commit a batch of outcomes in one store transaction. Each task's writes are
   * collected separately; on a shared store they are guarded by the task's
   * claim (its queue row still holding the claimed value), so the result of an
   * engine whose claim went stale is dropped as a whole. Dequeues go last.
   */
  async #commitBatch(outcomes: Outcome[], stats: RunStats, writesBefore: number): Promise<void> {
    await this.#locked(async () => {
      // Reads can only have gone stale if a source write landed while the batch
      // ran: in this engine (counted; none can land now, they take this lock) or
      // in another engine sharing the store. Stale results stay queued.
      const racy = this.#shared || this.#sourceWrites !== writesBefore;
      const valid = new Set<Outcome>();
      for (const o of outcomes) {
        if (o.kind !== "done") valid.add(o);
        else if ((!racy || (await this.#validate(o))) && (await this.#changesUnchanged(o))) {
          valid.add(o);
        }
      }
      // Rows written earlier in this batch shadow the stored ones.
      const overlay = new Map<string, StoredRow | null>();
      const row = async (collection: string, key: string) => {
        const id = k(collection, key);
        if (overlay.has(id)) return overlay.get(id) ?? undefined;
        return this.#row(collection, key);
      };
      const merged = new Map<string, KvWrite>();
      const writtenBy = new Map<string, string>();
      const dequeues: KvWrite[] = [];
      const absorb = (claim: Claim, writes: Map<string, KvWrite>) => {
        for (const [key, w] of writes) {
          if (key === claim.qkey && w.value === undefined && w.ifValue === claim.raw) {
            dequeues.push(w);
            continue;
          }
          let out = this.#shared ? { ...w, guard: { key: claim.qkey, value: claim.raw } } : w;
          // A queue row re-armed by several tasks: any one of them suffices.
          if (
            writtenBy.has(key) &&
            writtenBy.get(key) !== claim.qkey &&
            key.startsWith(`q${SEP}`)
          ) {
            out = { key, value: w.value };
          }
          merged.set(key, out);
          writtenBy.set(key, claim.qkey);
        }
      };
      for (const o of outcomes) {
        const writes = new Map<string, KvWrite>();
        try {
          if (!valid.has(o)) {
            this.#release(o.claim, writes); // claimable again at once
          } else if (o.kind === "failed") {
            await this.#failWrites(o.claim, o.error, writes, stats);
          } else if (o.kind === "skip") {
            this.#dequeue(o.claim, writes);
            if ((await this.#kv.get(k("d", o.claim.builder, o.claim.task))) !== undefined) {
              set(writes, k("d", o.claim.builder, o.claim.task), undefined);
            }
            stats.skipped++;
          } else {
            await this.#doneWrites(o, row, overlay, writes, stats);
          }
        } finally {
          absorb(o.claim, writes);
        }
      }
      const all = [...merged.values(), ...dequeues];
      if (all.length > 0) await this.#kv.commit(all);
    });
  }

  /** The writes of a successful task (or, on a conflict, of its failure). */
  async #doneWrites(
    o: Done,
    row: (collection: string, key: string) => Promise<StoredRow | undefined>,
    overlay: Map<string, StoredRow | null>,
    writes: Map<string, KvWrite>,
    stats: RunStats,
  ): Promise<void> {
    const { builder, task } = o.claim;
    const self = k(builder, task);
    // Ownership against earlier tasks of the same batch, and settled owners.
    for (const { ref } of o.emitted.values()) {
      const r = await row(ref[0], ref[1]);
      if (r && r.owner !== "" && r.owner !== self) {
        const sameBatch = overlay.has(k(ref[0], ref[1]));
        if (sameBatch || !(await this.#stale(r.owner))) {
          const error = new ConflictingEmission(`${ref[0]}/${ref[1]}: emitted by another task`);
          await this.#failWrites(o.claim, error, writes, stats);
          return;
        }
      }
    }
    for (const { ref, json } of o.emitted.values()) {
      const r = await row(ref[0], ref[1]);
      if (r?.json === json && r.owner === self) continue;
      set(writes, k("r", ref[0], ref[1]), `${self}${OWNER_SEP}${json}`);
      overlay.set(k(ref[0], ref[1]), { owner: self, json });
      if (r?.json !== json) await this.#enqueueDependents(ref[0], ref[1], r?.json, writes);
    }
    for (const ref of o.prev.o) {
      if (o.emitted.has(k(ref[0], ref[1]))) continue;
      const r = await row(ref[0], ref[1]);
      if (r?.owner !== self) continue; // handed over to another task
      set(writes, k("r", ref[0], ref[1]), undefined);
      overlay.set(k(ref[0], ref[1]), null);
      await this.#enqueueDependents(ref[0], ref[1], r.json, writes);
    }
    this.#traceWrites(builder, task, o.prev, o.rawPrev, o.next, writes);
    for (const [ckey, raw] of o.consumed) {
      if (!writes.has(ckey)) writes.set(ckey, { key: ckey, ifValue: raw });
    }
    this.#dequeue(o.claim, writes);
    if ((await this.#kv.get(k("d", builder, task))) !== undefined) {
      set(writes, k("d", builder, task), undefined);
    }
    stats.executed++;
  }

  /**
   * Incremental reduce: the change records are exactly those the task saw. A
   * change that landed meanwhile (new key, or a refreshed token) makes the
   * result stale — it may or may not be reflected in what the task listed — so
   * the task stays queued and runs again over the same state.
   */
  async #changesUnchanged(o: Done): Promise<boolean> {
    if (!this.#topo.builder(o.claim.builder).incremental) return true;
    let n = 0;
    for await (const [ckey, raw] of this.#kv.scan(kp("c", o.claim.builder))) {
      if (o.consumed.get(ckey) !== raw) return false;
      n++;
    }
    return n === o.consumed.size;
  }

  #traceWrites(
    builder: string,
    task: string,
    prev: Trace,
    rawPrev: string | undefined,
    next: Trace | undefined,
    writes: Map<string, KvWrite>,
  ): void {
    const nextRaw = next ? JSON.stringify(next) : undefined;
    if (nextRaw !== rawPrev) set(writes, k("f", builder, task), nextRaw);
    const before = new Set(prev.r.map((r) => k(r[0], r[1])));
    const after = new Set((next?.r ?? []).map((r) => k(r[0], r[1])));
    for (const id of before) if (!after.has(id)) set(writes, k("x", id, builder, task), undefined);
    for (const id of after) if (!before.has(id)) set(writes, k("x", id, builder, task), "");
    const lb = new Set(prev.l);
    const la = new Set(next?.l ?? []);
    for (const s of lb) if (!la.has(s)) set(writes, k("xl", s, builder, task), undefined);
    for (const s of la) if (!lb.has(s)) set(writes, k("xl", s, builder, task), "");
  }

  /** Dequeue unless re-queued since the claim (by this batch or a concurrent write). */
  #dequeue(claim: Claim, writes: Map<string, KvWrite>): void {
    if (writes.has(claim.qkey)) return;
    writes.set(claim.qkey, { key: claim.qkey, ifValue: claim.raw });
  }

  /** Give up our lease (keep the task queued as it was). */
  #release(claim: Claim, writes: Map<string, KvWrite>): void {
    if (writes.has(claim.qkey)) return;
    const { o: _o, u: _u, ...free } = claim.row;
    writes.set(claim.qkey, { key: claim.qkey, value: JSON.stringify(free), ifValue: claim.raw });
  }

  /** Count a failed attempt; dead-letter at `maxAttempts`. */
  async #failWrites(
    claim: Claim,
    error: unknown,
    writes: Map<string, KvWrite>,
    stats: RunStats,
  ): Promise<void> {
    stats.failed++;
    this.#log.warn("task failed", { builder: claim.builder, key: claim.task, error });
    if (writes.has(claim.qkey)) return; // re-queued by this batch: fresh attempt
    // A newer change re-queued it with a fresh attempt count: leave it.
    if ((await this.#kv.get(claim.qkey)) !== claim.raw) return;
    const attempts = claim.row.a + 1;
    if (attempts < this.#maxAttempts) {
      const retry: QueueRow = { g: claim.row.g, a: attempts };
      writes.set(claim.qkey, { key: claim.qkey, value: JSON.stringify(retry), ifValue: claim.raw });
      return;
    }
    stats.deadLettered++;
    this.#log.error("task dead-lettered", { builder: claim.builder, key: claim.task, error });
    writes.set(claim.qkey, { key: claim.qkey, ifValue: claim.raw });
    set(
      writes,
      k("d", claim.builder, claim.task),
      JSON.stringify({ attempts, error: errorText(error) }),
    );
  }

  // ---- storage helpers --------------------------------------------------------

  async #row(collection: string, key: string): Promise<StoredRow | undefined> {
    const raw = await this.#kv.get(k("r", collection, key));
    if (raw === undefined) return undefined;
    const i = raw.indexOf(OWNER_SEP);
    return { owner: raw.slice(0, i), json: raw.slice(i + 1) };
  }

  /** Serialise read-check-commit sections of this engine (put/remove, batch commits). */
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

function set(writes: Map<string, KvWrite>, key: string, value: string | undefined): void {
  writes.set(key, { key, value });
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Fingerprint of a row's canonical JSON, for "did what this task read change?".
 * Small values are kept verbatim (exact); larger ones as length + two
 * independent 32-bit hashes (FNV-1a and a murmur-style mix) — a false "equal"
 * needs a 64-bit collision at the same length.
 */
function fingerprint(json: string): string {
  if (json.length <= 48) return `=${json}`;
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return `#${json.length.toString(36)}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}
