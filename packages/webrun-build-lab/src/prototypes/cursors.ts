/**
 * Prototype A: "changelog cursors" (push-by-log, consumer-driven discovery).
 *
 * Writes never fan out. Every row change gets a fresh global **stamp** and is
 * recorded once in its collection's changelog. Each consumer builder keeps a
 * **cursor** (a global stamp) and finds its work by range-scanning the
 * changelogs of the collections it depends on, from the cursor onwards. This is
 * the Kafka consumer-offset / webrun-dataflow UpdatesStore watermark idea.
 *
 * KV layout (parts joined with U+0000, see `k()`):
 *   r/<collection>/<key>             → `<seq>\0<owner>\0<json>`, or `<seq>\0<owner>` for a tombstone.
 *                                  `seq` is the row's last stamp and `owner` is its producer
 *                                  task (`builder\u0002task`, "" for sources). Keeping the stamp
 *                                  and owner in the row lets one `get` do early cut-off,
 *                                  conflict detection and changelog compaction.
 *   c/<collection>/<seq>/<key>       → "" : the changelog. It is compacted to one entry per key:
 *                                  a change deletes the key's previous entry.
 *   t/<builder>/<task>              → {b, o, d, l, dl?}: the task record. `b` ("built at") is the
 *                                  global stamp at which the task's last execution began to
 *                                  read. `o` is its provenance (output rows), `d` its extra
 *                                  row reads, `l` the collections it listed, `dl` a dead-letter flag.
 *   rd/<builder>/<collection>/<key>/<task> : reverse index of extra row reads (`d`).
 *   rl/<builder>/<collection>/<task>       : reverse index of whole-collection reads (`l`).
 *   x/<builder>/<task>              → {attempts, error}: dead letters.
 *   m/stamp, m/cur/<builder>, m/rd/<builder>/<collection>, m/rl/<builder>/<collection>: the stamp counter,
 *                                  cursors, and "this builder has reverse deps on this collection" markers.
 *
 * Reads that are implied by the task's key are not indexed: a map task reading
 * `get(input, ownKey)`, or a reduce task reading its inputs. The changelog entry
 * of that key (or any input entry, for a reduce) already maps to the task. So
 * the reverse index only holds genuinely dynamic reads, and the per-(builder, collection)
 * marker lets discovery skip reverse-index lookups for builders that have none.
 *
 * Run: builders are processed in topological order, in passes, until a pass finds
 * nothing. For one builder, discovery scans every dependency collection's changelog
 * after the cursor. A key on an input becomes a candidate task (`"*"` for a
 * reduce). The `rd`/`rl` indexes map a key to the tasks that read it.
 * Each candidate carries the largest stamp that triggered it. Upstream builders
 * finished their discovered work earlier in the pass, so execution is
 * glitch-free and a diamond's join runs once.
 *
 * Crash safety without per-task cursor bookkeeping: a candidate is skipped when
 * `rec.b >= trigger stamp`. Commits are serialised and stamps are allocated in
 * commit order, so a change stamped `<= b` was already committed when the task
 * started reading, and the task saw it. A task's commit holds its rows, its
 * changelog entries, its record (with the new `b`), its dep-index diff and its
 * dead-letter change, all applied atomically. The cursor is only an
 * optimisation that bounds the scan. It is persisted lazily, piggybacked on the
 * commit of the builder's last candidate. After a crash, the rescan from an older
 * cursor re-finds committed tasks and skips each one for the cost of a `get`.
 * So a resumed run never re-executes committed work.
 *
 * Inherent costs:
 * - One changed row costs 3 row writes plus a delete: the row, the new changelog
 *   entry, the deleted old entry and `m/stamp` (once per commit). Every task
 *   execution rewrites its record (to carry `b`).
 * - Tombstones (rows and their changelog entries) are never collected: garbage
 *   collection would need the minimum cursor of every consumer. `list` scans
 *   past them.
 * - Discovery reads the task record per candidate (to check `b`). With
 *   dynamic reads it also does one reverse-index scan per changelog entry and
 *   consumer.
 * - A consumer scans every entry of its dependency collections, even the ones it
 *   ignores (a `reads` collection where it depends on a few keys). Entries are
 *   compacted per key, so this is bounded by the distinct keys changed.
 * - Commits go through one in-process lock, so stamps follow commit order. This
 *   is a single-writer design: one engine instance owns the KV at a time.
 * - Ownership is checked against stored rows. Handing a row from one task to
 *   another in the same run conflicts if the new owner runs first (P0 evaluates
 *   fresh and would accept it).
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

interface Rec {
  b: number;
  o: [string, string][];
  d: [string, string][];
  l: string[];
  dl?: 1;
}
type Write = { key: string; value?: string };
interface Row {
  seq: string;
  owner: string;
  json?: string;
}
/** A transaction being assembled under the commit lock. */
interface Tx {
  stamp: number;
  writes: Write[];
  touched: Set<string>;
  markers: Set<string>;
}
/** What one execution read beyond its implied reads. */
interface Reads {
  d: Map<string, [string, string]>;
  l: Set<string>;
}
type Outcome = "skipped" | "committed" | "stopped";

const K_STAMP = k("m", "stamp");
/** Separates builder and task in a row's owner (must differ from SEP, which splits the row value). */
const OWNER_SEP = "\u0002";
/** The character right above SEP: `seq + AFTER_SEP` sorts after every `seq SEP key`. */
const AFTER_SEP = String.fromCharCode(SEP.charCodeAt(0) + 1);
/** Persist an idle cursor (no task commit to carry it) after scanning this many entries. */
const IDLE_CURSOR_PERSIST = 16;

function decodeRow(v: string | undefined): Row | undefined {
  if (v === undefined) return undefined;
  const i = v.indexOf(SEP);
  const j = v.indexOf(SEP, i + 1);
  if (j < 0) return { seq: v.slice(0, i), owner: v.slice(i + 1) };
  return { seq: v.slice(0, i), owner: v.slice(i + 1, j), json: v.slice(j + 1) };
}

function encodeRow(stamp: number, owner: string, json: string | undefined): string {
  const head = seqKey(stamp) + SEP + owner;
  return json === undefined ? head : head + SEP + json;
}

export class CursorEngine implements Engine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;
  /** Dependency collections (inputs ∪ reads) per builder. */
  readonly #deps = new Map<string, string[]>();

  // In-process caches. Each one is loaded from the KV on first use, so a new
  // instance over the same KV starts from the stored truth.
  #ready: Promise<void> | undefined;
  #stamp = 0; // last committed stamp
  #initStamp = 0; // stamp when this instance started
  readonly #lastChange = new Map<string, number>(); // collection → upper bound of its last stamp
  readonly #cursor = new Map<string, number>();
  readonly #markers = new Map<string, boolean>();
  readonly #reduceBuilt = new Set<string>();
  #lock: Promise<void> = Promise.resolve();

  constructor(opts: EngineOptions) {
    this.#kv = opts.kv;
    this.#topo = new Topology(opts.builders);
    this.#maxAttempts = opts.maxAttempts ?? 3;
    for (const c of opts.builders)
      this.#deps.set(c.id, [...new Set([...c.inputs, ...(c.reads ?? [])])]);
  }

  // ---- public API --------------------------------------------------------

  async put(collection: string, key: string, value: Json): Promise<void> {
    this.#topo.assertSource(collection);
    await this.#write(collection, key, canonicalJson(value));
  }

  async remove(collection: string, key: string): Promise<void> {
    this.#topo.assertSource(collection);
    await this.#write(collection, key, undefined);
  }

  async get(collection: string, key: string): Promise<Json | undefined> {
    const json = decodeRow(await this.#kv.get(k("r", collection, key)))?.json;
    return json === undefined ? undefined : (JSON.parse(json) as Json);
  }

  async list(collection: string): Promise<{ key: string; value: Json }[]> {
    const out: { key: string; value: Json }[] = [];
    for await (const [key, v] of this.#kv.scan(kp("r", collection))) {
      const json = decodeRow(v)?.json;
      if (json !== undefined) out.push({ key: split(key)[2] as string, value: JSON.parse(json) });
    }
    return out;
  }

  async deadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for await (const [key, json] of this.#kv.scan(kp("x"))) {
      const [, builder, task] = split(key);
      out.push({ builder: builder as string, key: task as string, ...JSON.parse(json) });
    }
    return out;
  }

  async run(opts?: RunOptions): Promise<RunStats> {
    await this.#init();
    const stats: RunStats = { executed: 0, failed: 0, deadLettered: 0, pending: false };
    const budget = { left: opts?.maxTasks ?? Number.POSITIVE_INFINITY };
    for (;;) {
      let found = false;
      for (const id of this.#topo.order) {
        const r = await this.#processCell(this.#topo.builder(id), stats, budget);
        if (r === "stopped") {
          stats.pending = true;
          return stats;
        }
        if (r === "found") found = true;
      }
      if (!found) return stats;
    }
  }

  // ---- scheduling --------------------------------------------------------

  /** Discover and execute one builder's pending tasks. */
  async #processCell(
    builder: BuilderDef,
    stats: RunStats,
    budget: { left: number },
  ): Promise<"idle" | "found" | "stopped"> {
    const hi = this.#stamp;
    const cur = await this.#cursorOf(builder.id);
    if (cur >= hi) return "idle";

    const cand = new Map<string, number>(); // task → largest triggering stamp
    if (builder.kind === "reduce" && !(await this.#isReduceBuilt(builder.id))) cand.set("*", 0);
    let scanned = 0;
    for (const s of this.#deps.get(builder.id) as string[]) {
      // Skip collections with no change after the cursor (known without I/O).
      if ((this.#lastChange.get(s) ?? this.#initStamp) <= cur) continue;
      scanned += await this.#discover(builder, s, cur, cand);
    }
    const cursorWrite: Write = { key: k("m", "cur", builder.id), value: String(hi) };
    if (cand.size === 0) {
      this.#cursor.set(builder.id, hi);
      if (scanned >= IDLE_CURSOR_PERSIST) await this.#serial(() => this.#kv.commit([cursorWrite]));
      return scanned > 0 ? "found" : "idle";
    }

    const tasks = [...cand.keys()].sort();
    let persisted = false;
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i] as string;
      const last = i === tasks.length - 1;
      const r = await this.#processTask(
        builder,
        task,
        cand.get(task) as number,
        stats,
        budget,
        last ? cursorWrite : undefined,
      );
      if (r === "stopped") return "stopped";
      if (last && r === "committed") persisted = true;
    }
    this.#cursor.set(builder.id, hi);
    if (!persisted && scanned >= IDLE_CURSOR_PERSIST)
      await this.#serial(() => this.#kv.commit([cursorWrite]));
    return "found";
  }

  /** Scan `collection`'s changelog after `cur` and add the tasks it triggers to `cand`. */
  async #discover(
    builder: BuilderDef,
    collection: string,
    cur: number,
    cand: Map<string, number>,
  ): Promise<number> {
    const add = (task: string, stamp: number) => {
      if ((cand.get(task) ?? -1) < stamp) cand.set(task, stamp);
    };
    const isInput = builder.inputs.includes(collection);
    const isMap = builder.kind !== "reduce";
    const rdOn = await this.#marker(k("m", "rd", builder.id, collection));
    const rlOn = await this.#marker(k("m", "rl", builder.id, collection));
    let max = 0;
    let n = 0;
    // Entries are `c/<collection>/<seq>/<key>`. Every key with stamp `cur` sorts below this anchor.
    const after = kp("c", collection) + seqKey(cur) + AFTER_SEP;
    for await (const [entry] of this.#kv.scan(kp("c", collection), { after })) {
      n++;
      const [, , seq, rowKey] = split(entry) as [string, string, string, string];
      const stamp = Number.parseInt(seq, 36);
      if (stamp > max) max = stamp;
      if (isInput) add(isMap ? rowKey : "*", stamp);
      if (rdOn) {
        for await (const [dep] of this.#kv.scan(kp("rd", builder.id, collection, rowKey))) {
          add(split(dep)[4] as string, stamp);
        }
      }
    }
    if (rlOn && n > 0) {
      for await (const [dep] of this.#kv.scan(kp("rl", builder.id, collection)))
        add(split(dep)[3] as string, max);
    }
    return n;
  }

  /**
   * Bring one task up to date. It is skipped if it already saw the trigger,
   * retracted if its key is gone from every input, and otherwise executed with
   * retries. `extra` writes (the cursor) ride on its commit.
   */
  async #processTask(
    builder: BuilderDef,
    task: string,
    trigger: number,
    stats: RunStats,
    budget: { left: number },
    extra: Write | undefined,
  ): Promise<Outcome> {
    const rec = await this.#loadRec(builder.id, task);
    if (rec && rec.b >= trigger) return "skipped";
    if (budget.left <= 0) return "stopped";

    // Capture the stamp before reading anything: all changes stamped `<= b`
    // are already committed and visible to this execution's reads.
    let b = this.#stamp;
    const pre = new Map<string, string | undefined>();
    if (builder.kind !== "reduce") {
      let alive = false;
      for (const s of builder.inputs) {
        const json = decodeRow(await this.#kv.get(k("r", s, task)))?.json;
        pre.set(k(s, task), json);
        if (json !== undefined) alive = true;
      }
      if (!alive) {
        if (!rec) return "skipped"; // never built, nothing to retract
        budget.left--;
        await this.#serial(async () => {
          const tx = this.#tx();
          await this.#retractOutputs(tx, builder.id, task, rec.o, new Set());
          await this.#depWrites(tx, builder.id, task, rec, { d: new Map(), l: new Set() });
          tx.writes.push({ key: k("t", builder.id, task) });
          if (rec.dl) tx.writes.push({ key: k("x", builder.id, task) });
          await this.#commit(tx, extra);
        });
        stats.executed++;
        return "committed";
      }
    }

    budget.left--;
    let lastError: unknown;
    let reads: Reads = { d: new Map(), l: new Set() };
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (attempt > 1) b = this.#stamp;
      reads = { d: new Map(), l: new Set() };
      try {
        const emitted = await this.#exec(builder, task, reads, attempt === 1 ? pre : undefined);
        const err = await this.#commitSuccess(builder, task, rec, b, emitted, reads, extra);
        if (err === undefined) {
          stats.executed++;
          return "committed";
        }
        lastError = err;
      } catch (error) {
        lastError = error;
      }
      stats.failed++;
    }

    // Dead-letter the task. Keep its previous outputs, and widen its deps with
    // what the last attempt read, so a later change to any of it retries the task.
    await this.#serial(async () => {
      const tx = this.#tx();
      for (const [s, rk] of rec?.d ?? [])
        if (!reads.d.has(k(s, rk))) reads.d.set(k(s, rk), [s, rk]);
      for (const s of rec?.l ?? []) reads.l.add(s);
      await this.#depWrites(tx, builder.id, task, rec, reads);
      const next: Rec = { b, o: rec?.o ?? [], d: [...reads.d.values()], l: [...reads.l], dl: 1 };
      tx.writes.push({ key: k("t", builder.id, task), value: JSON.stringify(next) });
      tx.writes.push({
        key: k("x", builder.id, task),
        value: JSON.stringify({ attempts: this.#maxAttempts, error: errorText(lastError) }),
      });
      await this.#commit(tx, extra);
    });
    stats.deadLettered++;
    return "committed";
  }

  /** Run the builder function once, tracking reads; returns its emissions. */
  async #exec(
    builder: BuilderDef,
    task: string,
    reads: Reads,
    pre: Map<string, string | undefined> | undefined,
  ): Promise<Map<string, [string, string, string]>> {
    const readable = new Set(this.#deps.get(builder.id));
    const isMap = builder.kind !== "reduce";
    const emitted = new Map<string, [string, string, string]>(); // id → [collection, key, json]
    const check = (collection: string) => {
      if (!readable.has(collection))
        throw new Error(`Builder "${builder.id}" read undeclared "${collection}"`);
    };
    const ctx: TaskContext = {
      key: task,
      get: async (collection, key) => {
        check(collection);
        const implied = builder.inputs.includes(collection) && (!isMap || key === task);
        if (!implied) reads.d.set(k(collection, key), [collection, key]);
        const id = k(collection, key);
        const json = pre?.has(id)
          ? pre.get(id)
          : decodeRow(await this.#kv.get(k("r", collection, key)))?.json;
        return json === undefined ? undefined : (JSON.parse(json) as Json);
      },
      list: async (collection) => {
        check(collection);
        if (isMap || !builder.inputs.includes(collection)) reads.l.add(collection);
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
        if (prior && prior[2] !== json) {
          throw new ConflictingEmission(
            `${collection}/${key}: emitted twice with different values`,
          );
        }
        emitted.set(id, [collection, key, json]);
      },
    };
    await builder.run(ctx);
    return emitted;
  }

  /**
   * Commit a successful execution atomically: changed outputs, retractions of
   * outputs it no longer emits, its dep-index diff, its record and a cleared
   * dead letter. Returns an error, without committing, when an emitted row is
   * owned by another task.
   */
  async #commitSuccess(
    builder: BuilderDef,
    task: string,
    rec: Rec | undefined,
    b: number,
    emitted: Map<string, [string, string, string]>,
    reads: Reads,
    extra: Write | undefined,
  ): Promise<unknown> {
    return this.#serial(async () => {
      const tx = this.#tx();
      const owner = builder.id + OWNER_SEP + task;
      try {
        for (const [collection, key, json] of emitted.values())
          await this.#writeRow(tx, collection, key, json, owner);
      } catch (error) {
        return error;
      }
      await this.#retractOutputs(tx, builder.id, task, rec?.o ?? [], new Set(emitted.keys()));
      await this.#depWrites(tx, builder.id, task, rec, reads);
      const next: Rec = {
        b,
        o: [...emitted.values()].map(([s, rk]) => [s, rk]),
        d: [...reads.d.values()],
        l: [...reads.l],
      };
      tx.writes.push({ key: k("t", builder.id, task), value: JSON.stringify(next) });
      if (rec?.dl) tx.writes.push({ key: k("x", builder.id, task) });
      await this.#commit(tx, extra);
      if (builder.kind === "reduce") this.#reduceBuilt.add(builder.id);
      return undefined;
    });
  }

  // ---- row writes and indexes ---------------------------------------------

  /** A source write: one row change in its own commit (none if unchanged). */
  async #write(collection: string, key: string, json: string | undefined): Promise<void> {
    await this.#init();
    await this.#serial(async () => {
      const tx = this.#tx();
      await this.#writeRow(tx, collection, key, json, "");
      if (tx.writes.length > 0) await this.#commit(tx);
    });
  }

  /**
   * Stage a row change (`json === undefined` retracts). Equal values are a
   * no-op (early cut-off). A changed row gets a new stamp and moves its
   * changelog entry. Writing a live row owned by another task throws
   * `ConflictingEmission`. A retraction only removes a row this owner owns.
   */
  async #writeRow(
    tx: Tx,
    collection: string,
    key: string,
    json: string | undefined,
    owner: string,
  ): Promise<void> {
    const rk = k("r", collection, key);
    const cur = decodeRow(await this.#kv.get(rk));
    if (json === undefined) {
      if (cur?.json === undefined || cur.owner !== owner) return;
    } else if (cur?.json !== undefined) {
      if (cur.owner !== owner) {
        throw new ConflictingEmission(
          `${collection}/${key}: already emitted by ${cur.owner.replace(OWNER_SEP, "/")}`,
        );
      }
      if (cur.json === json) return;
    }
    const stamp = ++tx.stamp;
    tx.writes.push({ key: rk, value: encodeRow(stamp, owner, json) });
    if (cur) tx.writes.push({ key: k("c", collection, cur.seq, key) });
    tx.writes.push({ key: k("c", collection, seqKey(stamp), key), value: "" });
    tx.touched.add(collection);
  }

  async #retractOutputs(
    tx: Tx,
    builderId: string,
    task: string,
    old: [string, string][],
    keep: Set<string>,
  ) {
    const owner = builderId + OWNER_SEP + task;
    for (const [s, rk] of old)
      if (!keep.has(k(s, rk))) await this.#writeRow(tx, s, rk, undefined, owner);
  }

  /** Stage the reverse-index diff between a task's old record and its new reads. */
  async #depWrites(
    tx: Tx,
    builderId: string,
    task: string,
    rec: Rec | undefined,
    reads: Reads,
  ): Promise<void> {
    const oldD = new Set((rec?.d ?? []).map(([s, rk]) => k(s, rk)));
    const oldL = new Set(rec?.l ?? []);
    for (const [id, [s, rk]] of reads.d) {
      if (oldD.has(id)) continue;
      tx.writes.push({ key: k("rd", builderId, s, rk, task), value: "" });
      await this.#ensureMarker(tx, k("m", "rd", builderId, s));
    }
    for (const [s, rk] of rec?.d ?? []) {
      if (!reads.d.has(k(s, rk))) tx.writes.push({ key: k("rd", builderId, s, rk, task) });
    }
    for (const s of reads.l) {
      if (oldL.has(s)) continue;
      tx.writes.push({ key: k("rl", builderId, s, task), value: "" });
      await this.#ensureMarker(tx, k("m", "rl", builderId, s));
    }
    for (const s of oldL) if (!reads.l.has(s)) tx.writes.push({ key: k("rl", builderId, s, task) });
  }

  /** Markers are set once and never cleared (a stale marker only costs a scan). */
  async #ensureMarker(tx: Tx, key: string): Promise<void> {
    if (tx.markers.has(key) || (await this.#marker(key))) return;
    tx.markers.add(key);
    tx.writes.push({ key, value: "1" });
  }

  // ---- state helpers ------------------------------------------------------

  #init(): Promise<void> {
    this.#ready ??= (async () => {
      this.#stamp = Number((await this.#kv.get(K_STAMP)) ?? 0);
      this.#initStamp = this.#stamp;
    })();
    return this.#ready;
  }

  #tx(): Tx {
    return { stamp: this.#stamp, writes: [], touched: new Set(), markers: new Set() };
  }

  /** Apply a staged transaction and publish its effects to the caches. Call under the lock. */
  async #commit(tx: Tx, extra?: Write): Promise<void> {
    const writes = extra ? [...tx.writes, extra] : tx.writes;
    if (tx.stamp > this.#stamp) writes.push({ key: K_STAMP, value: String(tx.stamp) });
    await this.#kv.commit(writes);
    this.#stamp = tx.stamp;
    for (const s of tx.touched) this.#lastChange.set(s, tx.stamp);
    for (const m of tx.markers) this.#markers.set(m, true);
  }

  /**
   * Serialise read-compare-commit sections. Stamps are allocated inside, so
   * stamp order is commit order. Changelog scans depend on that: once a stamp
   * is visible, every smaller stamp is committed.
   */
  async #serial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#lock;
    let release!: () => void;
    this.#lock = new Promise((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #loadRec(builderId: string, task: string): Promise<Rec | undefined> {
    const v = await this.#kv.get(k("t", builderId, task));
    return v === undefined ? undefined : (JSON.parse(v) as Rec);
  }

  async #cursorOf(builderId: string): Promise<number> {
    let c = this.#cursor.get(builderId);
    if (c === undefined) {
      c = Number((await this.#kv.get(k("m", "cur", builderId))) ?? 0);
      this.#cursor.set(builderId, c);
    }
    return c;
  }

  async #marker(key: string): Promise<boolean> {
    let m = this.#markers.get(key);
    if (m === undefined) {
      m = (await this.#kv.get(key)) !== undefined;
      this.#markers.set(key, m);
    }
    return m;
  }

  async #isReduceBuilt(builderId: string): Promise<boolean> {
    if (this.#reduceBuilt.has(builderId)) return true;
    if ((await this.#kv.get(k("t", builderId, "*"))) === undefined) return false;
    this.#reduceBuilt.add(builderId);
    return true;
  }
}
