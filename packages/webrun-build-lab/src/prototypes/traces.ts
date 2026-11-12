/**
 * C — verifying traces (pull; Salsa / Shake / "Build Systems à la Carte").
 *
 * Writes do not fan out and there is no work queue. Instead every row carries
 * the revision at which its value last actually changed, every task keeps a
 * trace of what it read, and `run()` *verifies* traces in topological order:
 * a task re-executes iff something it read changed after it was last verified.
 *
 * Revisions
 * ---------
 * - `R`, the global revision, is bumped once per committed change: a source
 *   `put`/`remove`, or a task commit that changed at least one output row.
 *   Each collection stores the revision of its last change (`s|sig`), so `R` is the
 *   max over those rows and needs no counter row of its own.
 * - `V` (`m|v`) is "verified through": after a run that verified every trace,
 *   no trace is stale with respect to any change at or before `V`. `run()`
 *   with `V === R` returns at once (O(1); nothing is read but cached state).
 * - A trace's own `r` is the revision observed when it last executed. Its
 *   effective verified-at is `max(V, r)`. Only executed tasks write their trace;
 *   tasks verified without executing write nothing. Derived changes take a
 *   fresh revision at commit time, so a run stopped by `maxTasks` or a crash
 *   leaves a consistent state: the next run re-verifies from the old `V`, and
 *   tasks committed meanwhile are fresh because their `r` covers what they saw.
 *
 * Verification of a trace (verified-at `w`)
 * -----------------------------------------
 * - `list(sig)` dependency: stale iff `changedAt(sig) > w`.
 * - `get(sig,key)` dependency: skipped wholesale when `changedAt(sig) <= w`
 *   (collection-level pruning, from memory); otherwise the row is fetched and the
 *   trace is stale iff it was present and is now missing or has
 *   `changedAt > w`, or was missing and now exists. Remembering presence means
 *   deletions need no tombstones.
 * - Early cut-off falls out: re-emitting an equal value writes nothing and does
 *   not move `changedAt`, so readers verify clean.
 *
 * Task discovery (the one index beyond pure traces)
 * -------------------------------------------------
 * Map tasks appear/die when a key appears/disappears on an input. A pure-pull
 * engine would have to merge-scan every input collection against the traces each
 * run. Instead each row creation/deletion on a collection that some map builder is
 * keyed by appends `e|sig|seq(rev)|key` (an *existence* log; value updates are
 * not logged). A run scans each changed input's log after `V` to find the
 * candidate new/dead keys; the log is garbage-collected up to the new `V` at
 * the end of a complete run, so it only holds entries since the last run.
 *
 * Inherent costs
 * --------------
 * - Verification is proportional to the number of traces of every builder that
 *   declares a changed collection: such a builder's traces are all scanned, and each
 *   trace with a `get` dependency on a changed collection costs a row read (memoised
 *   per run). One edited doc among N therefore costs ~N trace rows scanned and
 *   ~N gets per affected builder, while the executions stay minimal. Builders whose
 *   declared collections did not change are skipped without reading anything.
 *   A reverse index (row → readers) would remove this, but that is the eager
 *   design; a full row changelog would too, but that is the cursor design.
 * - Each task execution rewrites its trace (deps + outputs), and every change
 *   rewrites the per-collection `changedAt` row.
 * - Output rows store their owner task (for the one-producer rule) and their
 *   `changedAt`, so derived rows are a little larger than plain values.
 *
 * Assumptions: one live engine per store at a time. Cached state (`R`, `V`,
 * collection revisions) is loaded from the KV on first use and kept up to date by
 * this instance's own commits; a per-run row memo is dropped after each run.
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
import { canonicalJson, errorText, k, kp, SEP, seqKey, split, Topology } from "../core/util.js";

/** A stored row. `owner` is `k(builder, key)` of the producing task ("" for sources). */
interface Row {
  at: number;
  owner: string;
  json: string;
}

/**
 * A task trace. `g`: get-deps per collection as [collection, presentKeys, missingKeys];
 * `l`: listed collections; `o`: outputs per collection; `f`: currently dead-lettered.
 */
interface Trace {
  r: number;
  g: [string, string[], string[]][];
  l: string[];
  o: [string, string[]][];
  f?: 1;
}

type Write = { key: string; value?: string };
type Reads = { gets: Map<string, Map<string, boolean>>; lists: Set<string> };
type Change = { collection: string; key: string; json?: string; existence: boolean };

const SEQ = 11; // seqKey width
/** Sorts right after every `seq SEP …` key with the same seq. */
const AFTER_SEP = String.fromCharCode(SEP.charCodeAt(0) + 1);

/** Row value: `seq(at)` + (owner-builder SEP owner-key | "") + SEP + json. */
function encodeRow(row: Row): string {
  return seqKey(row.at) + row.owner + SEP + row.json;
}
function decodeRow(text: string): Row {
  const at = Number.parseInt(text.slice(0, SEQ), 36);
  if (text[SEQ] === SEP) return { at, owner: "", json: text.slice(SEQ + 1) };
  const i = text.indexOf(SEP, text.indexOf(SEP, SEQ) + 1);
  return { at, owner: text.slice(SEQ, i), json: text.slice(i + 1) };
}

/** Thrown to unwind a run that reached `maxTasks`. */
class Stop {}

export class TraceEngine implements Engine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;
  /** Collections some map builder is keyed by: only they keep an existence log. */
  readonly #keyed: Set<string>;

  #loaded = false;
  #R = 0;
  #V = 0;
  readonly #sigAt = new Map<string, number>();
  /** Per-run memo of rows (null = missing); kept in sync with our own commits. */
  #memo: Map<string, Row | null> | undefined;
  #running = false;
  #externalWrite = false;

  constructor(opts: EngineOptions) {
    this.#kv = opts.kv;
    this.#topo = new Topology(opts.builders);
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#keyed = new Set(
      opts.builders.filter((c) => c.kind !== "reduce").flatMap((c) => [...c.inputs]),
    );
  }

  // ---------------------------------------------------------------- state

  async #load(): Promise<void> {
    if (this.#loaded) return;
    for await (const [key, value] of this.#kv.scan(kp("s"))) {
      const at = Number.parseInt(value, 36);
      this.#sigAt.set(split(key)[1] as string, at);
      if (at > this.#R) this.#R = at;
    }
    const v = await this.#kv.get(k("m", "v"));
    this.#V = v === undefined ? 0 : Number.parseInt(v, 36);
    this.#loaded = true;
  }

  #at(collection: string): number {
    return this.#sigAt.get(collection) ?? 0;
  }

  async #readRow(collection: string, key: string): Promise<Row | null> {
    const id = k("r", collection, key);
    const cached = this.#memo?.get(id);
    if (cached !== undefined) return cached;
    const text = await this.#kv.get(id);
    const row = text === undefined ? null : decodeRow(text);
    this.#memo?.set(id, row);
    return row;
  }

  /**
   * Turn row changes into KV writes under one fresh revision: rows, the
   * per-collection revision, and existence-log entries. Returns the cache updates
   * to apply once the commit succeeded.
   */
  #changeWrites(changes: Change[], owner: string, writes: Write[]): () => void {
    if (changes.length === 0) return () => {};
    const rev = ++this.#R;
    const touched = new Set<string>();
    const rows: [string, Row | null][] = [];
    for (const c of changes) {
      const id = k("r", c.collection, c.key);
      const row = c.json === undefined ? null : { at: rev, owner, json: c.json };
      writes.push({ key: id, value: row ? encodeRow(row) : undefined });
      rows.push([id, row]);
      touched.add(c.collection);
      if (c.existence && this.#keyed.has(c.collection)) {
        writes.push({ key: k("e", c.collection, seqKey(rev), c.key), value: "" });
      }
    }
    for (const s of touched) writes.push({ key: k("s", s), value: seqKey(rev) });
    return () => {
      for (const s of touched) this.#sigAt.set(s, rev);
      for (const [id, row] of rows) this.#memo?.set(id, row);
    };
  }

  // ------------------------------------------------------------ public API

  async put(collection: string, key: string, value: Json): Promise<void> {
    this.#topo.assertSource(collection);
    await this.#load();
    const json = canonicalJson(value);
    const row = await this.#readRow(collection, key);
    if (row?.json === json) return;
    await this.#write({ collection, key, json, existence: row === null });
  }

  async remove(collection: string, key: string): Promise<void> {
    this.#topo.assertSource(collection);
    await this.#load();
    if ((await this.#readRow(collection, key)) === null) return;
    await this.#write({ collection, key, existence: true });
  }

  async #write(change: Change): Promise<void> {
    const writes: Write[] = [];
    const apply = this.#changeWrites([change], "", writes);
    await this.#kv.commit(writes);
    apply();
    if (this.#running) this.#externalWrite = true;
  }

  async get(collection: string, key: string): Promise<Json | undefined> {
    const text = await this.#kv.get(k("r", collection, key));
    return text === undefined ? undefined : (JSON.parse(decodeRow(text).json) as Json);
  }

  async list(collection: string): Promise<{ key: string; value: Json }[]> {
    const out: { key: string; value: Json }[] = [];
    for await (const [key, text] of this.#kv.scan(kp("r", collection))) {
      out.push({ key: split(key)[2] as string, value: JSON.parse(decodeRow(text).json) });
    }
    return out;
  }

  async deadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for await (const [key, json] of this.#kv.scan(kp("d"))) {
      const [, builder, task] = split(key);
      out.push({ builder: builder as string, key: task as string, ...JSON.parse(json) });
    }
    return out;
  }

  // ------------------------------------------------------------------ run

  async run(opts: RunOptions = {}): Promise<RunStats> {
    const stats: RunStats = { executed: 0, failed: 0, deadLettered: 0, pending: false };
    await this.#load();
    if (this.#V >= this.#R) return stats; // nothing changed since the last complete run
    const V = this.#V;
    const rStart = this.#R;
    const budget = () => {
      if (opts.maxTasks !== undefined && stats.executed >= opts.maxTasks) throw new Stop();
    };
    this.#memo = new Map();
    this.#running = true;
    this.#externalWrite = false;
    try {
      for (const id of this.#topo.order)
        await this.#verifyCell(this.#topo.builder(id), V, stats, budget);
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      stats.pending = true;
    } finally {
      this.#running = false;
      this.#memo = undefined;
    }
    if (stats.pending) return stats;
    // Every trace is verified. A write that landed mid-run may have been missed
    // by tasks verified before it: then only claim the revision we started at.
    const newV = this.#externalWrite ? rStart : this.#R;
    if (this.#externalWrite) stats.pending = true;
    const writes: Write[] = [{ key: k("m", "v"), value: seqKey(newV) }];
    for (const collection of this.#keyed) {
      if (this.#at(collection) <= V) continue;
      for await (const [key] of this.#kv.scan(kp("e", collection))) {
        if (Number.parseInt(split(key)[2] as string, 36) > newV) break;
        writes.push({ key });
      }
    }
    await this.#kv.commit(writes);
    this.#V = newV;
    return stats;
  }

  async #verifyCell(
    builder: BuilderDef,
    V: number,
    stats: RunStats,
    budget: () => void,
  ): Promise<void> {
    const changed = [...builder.inputs, ...(builder.reads ?? [])].some((s) => this.#at(s) > V);
    if (builder.kind === "reduce") {
      const text = await this.#kv.get(k("t", builder.id, "*"));
      const trace = text === undefined ? undefined : (JSON.parse(text) as Trace);
      if (!trace || (changed && (await this.#stale(trace, V)))) {
        budget();
        await this.#execute(builder, "*", trace, stats);
      }
      return;
    }
    if (!changed) return;

    // Keys whose existence changed on an input since V: candidate births/deaths.
    const candidates = new Set<string>();
    for (const s of builder.inputs) {
      if (this.#at(s) <= V) continue;
      const after = kp("e", s) + seqKey(V) + AFTER_SEP;
      for await (const [key] of this.#kv.scan(kp("e", s), { after })) {
        candidates.add(split(key)[3] as string);
      }
    }

    // Verify every existing trace of the builder (commits during the scan are fine).
    for await (const [tkey, text] of this.#kv.scan(kp("t", builder.id))) {
      const key = split(tkey)[2] as string;
      const trace = JSON.parse(text) as Trace;
      if (candidates.delete(key) && !(await this.#live(builder, key))) {
        budget();
        await this.#retract(builder, key, trace, stats);
      } else if (await this.#stale(trace, V)) {
        budget();
        await this.#execute(builder, key, trace, stats);
      }
    }
    // Candidates without a trace that are live are new tasks.
    for (const key of [...candidates].sort()) {
      if (!(await this.#live(builder, key))) continue;
      budget();
      await this.#execute(builder, key, undefined, stats);
    }
  }

  /** A map task is live while its key exists on some input. */
  async #live(builder: BuilderDef, key: string): Promise<boolean> {
    for (const s of builder.inputs) if ((await this.#readRow(s, key)) !== null) return true;
    return false;
  }

  /** Did anything the trace read change after it was last verified? */
  async #stale(trace: Trace, V: number): Promise<boolean> {
    const w = Math.max(V, trace.r);
    for (const s of trace.l) if (this.#at(s) > w) return true;
    for (const [s, present, missing] of trace.g) {
      if (this.#at(s) <= w) continue;
      for (const key of present) {
        const row = await this.#readRow(s, key);
        if (row === null || row.at > w) return true;
      }
      for (const key of missing) if ((await this.#readRow(s, key)) !== null) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ execution

  /** Run a task (with retries) and commit its outputs + trace atomically. */
  async #execute(builder: BuilderDef, key: string, prev: Trace | undefined, stats: RunStats) {
    const taskId = k(builder.id, key);
    const seen = this.#R; // everything up to here is visible to the task
    let lastError: unknown;
    let reads: Reads = { gets: new Map(), lists: new Set() };
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      reads = { gets: new Map(), lists: new Set() };
      let changes: Change[];
      let outputs: Map<string, string[]>;
      try {
        const emitted = await this.#invoke(builder, key, reads);
        ({ changes, outputs } = await this.#plan(taskId, prev, emitted, reads));
      } catch (error) {
        lastError = error;
        stats.failed++;
        continue;
      }
      // Outside the try: a failing commit (crash) must propagate, not retry.
      const writes: Write[] = [];
      const apply = this.#changeWrites(changes, taskId, writes);
      const trace = this.#trace(seen, reads, [...outputs]);
      writes.push({ key: k("t", taskId), value: JSON.stringify(trace) });
      if (prev?.f) writes.push({ key: k("d", taskId) });
      await this.#kv.commit(writes);
      apply();
      stats.executed++;
      return;
    }
    // Dead letter: keep the previous outputs; the trace of the last attempt makes
    // a later change to anything it read give the task a fresh try.
    const trace = { ...this.#trace(seen, reads, prev?.o ?? []), f: 1 as const };
    await this.#kv.commit([
      { key: k("t", taskId), value: JSON.stringify(trace) },
      {
        key: k("d", taskId),
        value: JSON.stringify({ attempts: this.#maxAttempts, error: errorText(lastError) }),
      },
    ]);
    stats.deadLettered++;
  }

  /** Retract a dead task without calling its builder. */
  async #retract(builder: BuilderDef, key: string, trace: Trace, stats: RunStats) {
    const taskId = k(builder.id, key);
    const changes: Change[] = [];
    for (const [collection, keys] of trace.o) {
      for (const rk of keys) changes.push({ collection, key: rk, existence: true });
    }
    const writes: Write[] = [];
    const apply = this.#changeWrites(changes, taskId, writes);
    writes.push({ key: k("t", taskId) });
    if (trace.f) writes.push({ key: k("d", taskId) });
    await this.#kv.commit(writes);
    apply();
    stats.executed++;
  }

  #trace(seen: number, reads: Reads, outputs: [string, string[]][]): Trace {
    const g: Trace["g"] = [];
    for (const [s, keys] of reads.gets) {
      const present: string[] = [];
      const missing: string[] = [];
      for (const [rk, p] of keys) (p ? present : missing).push(rk);
      g.push([s, present, missing]);
    }
    return { r: seen, g, l: [...reads.lists], o: outputs };
  }

  /** Call the builder with a tracking context; returns its emissions. */
  async #invoke(builder: BuilderDef, key: string, reads: Reads) {
    const readable = new Set([...builder.inputs, ...(builder.reads ?? [])]);
    const emitted = new Map<string, { collection: string; key: string; json: string }>();
    const check = (collection: string) => {
      if (!readable.has(collection))
        throw new Error(`Builder "${builder.id}" read undeclared "${collection}"`);
    };
    const ctx: TaskContext = {
      key,
      get: async (collection, rk) => {
        check(collection);
        const row = await this.#readRow(collection, rk);
        trackGet(reads, collection, rk, row !== null);
        return row === null ? undefined : (JSON.parse(row.json) as Json);
      },
      list: async (collection) => {
        check(collection);
        reads.lists.add(collection);
        return this.list(collection);
      },
      emit(collection, rk, value) {
        if (!builder.outputs.includes(collection)) {
          throw new Error(
            `Builder "${builder.id}" emitted to undeclared collection "${collection}"`,
          );
        }
        const json = canonicalJson(value);
        const id = k(collection, rk);
        const prior = emitted.get(id);
        if (prior && prior.json !== json) {
          throw new ConflictingEmission(`${collection}/${rk}: emitted twice with different values`);
        }
        emitted.set(id, { collection, key: rk, json });
      },
    };
    await builder.run(ctx);
    return emitted;
  }

  /**
   * Diff emissions against stored rows and the previous output set. Equal
   * values produce no change (early cut-off). A row owned by another task is a
   * conflict; it is recorded as a read so the task retries once it is freed.
   */
  async #plan(
    taskId: string,
    prev: Trace | undefined,
    emitted: Map<string, { collection: string; key: string; json: string }>,
    reads: Reads,
  ) {
    const changes: Change[] = [];
    const outputs = new Map<string, string[]>();
    for (const e of emitted.values()) {
      const row = await this.#readRow(e.collection, e.key);
      if (row !== null && row.owner !== taskId) {
        trackGet(reads, e.collection, e.key, true);
        const [oc, ok] = split(row.owner);
        throw new ConflictingEmission(`${e.collection}/${e.key}: already emitted by ${oc}/${ok}`);
      }
      let keys = outputs.get(e.collection);
      if (!keys) {
        keys = [];
        outputs.set(e.collection, keys);
      }
      keys.push(e.key);
      if (row?.json !== e.json) {
        changes.push({
          collection: e.collection,
          key: e.key,
          json: e.json,
          existence: row === null,
        });
      }
    }
    for (const [collection, keys] of prev?.o ?? []) {
      for (const rk of keys) {
        if (!emitted.has(k(collection, rk))) changes.push({ collection, key: rk, existence: true });
      }
    }
    return { changes, outputs };
  }
}

function trackGet(reads: Reads, collection: string, key: string, present: boolean): void {
  let m = reads.gets.get(collection);
  if (!m) {
    m = new Map();
    reads.gets.set(collection, m);
  }
  if (!m.has(key)) m.set(key, present);
}
