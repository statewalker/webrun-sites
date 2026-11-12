/**
 * P0 — full recompute. The reference semantics and the benchmark baseline.
 *
 * `run()` re-evaluates every task of every builder from the sources (skipping
 * the run entirely when no source changed since the last one), diffs the
 * result with the stored rows and commits the difference in one transaction.
 * A task that keeps failing keeps its previous outputs.
 */
import type { KV } from "../core/kv.js";
import {
  type BuilderDef,
  ConflictingEmission,
  type DeadLetter,
  type Engine,
  type EngineOptions,
  type Json,
  type RunStats,
  type TaskContext,
} from "../core/types.js";
import { canonicalJson, errorText, k, kp, split, Topology } from "../core/util.js";

type Rows = Map<string, Map<string, string>>; // collection → key → canonical json

/** Map-builder task keys: the union of keys over the builder's inputs, sorted. */
export function taskKeys(builder: BuilderDef, rows: Rows): string[] {
  if (builder.kind === "reduce") return ["*"];
  const keys = new Set<string>();
  for (const s of builder.inputs) for (const key of rows.get(s)?.keys() ?? []) keys.add(key);
  return [...keys].sort();
}

export interface TaskResult {
  emitted: Map<string, { collection: string; key: string; json: string }>;
}

/** Execute one task against `rows`; throws what the builder throws. */
export async function execTask(builder: BuilderDef, key: string, rows: Rows): Promise<TaskResult> {
  const readable = new Set([...builder.inputs, ...(builder.reads ?? [])]);
  const emitted = new Map<string, { collection: string; key: string; json: string }>();
  const check = (collection: string) => {
    if (!readable.has(collection))
      throw new Error(`Builder "${builder.id}" read undeclared "${collection}"`);
  };
  const ctx: TaskContext = {
    key,
    async get(collection, k2) {
      check(collection);
      const json = rows.get(collection)?.get(k2);
      return json === undefined ? undefined : (JSON.parse(json) as Json);
    },
    async list(collection) {
      check(collection);
      const m = rows.get(collection);
      if (!m) return [];
      return [...m.keys()]
        .sort()
        .map((k2) => ({ key: k2, value: JSON.parse(m.get(k2) as string) }));
    },
    emit(collection, k2, value) {
      if (!builder.outputs.includes(collection)) {
        throw new Error(`Builder "${builder.id}" emitted to undeclared collection "${collection}"`);
      }
      const json = canonicalJson(value);
      const id = k(collection, k2);
      const prior = emitted.get(id);
      if (prior && prior.json !== json) {
        throw new ConflictingEmission(`${collection}/${k2}: emitted twice with different values`);
      }
      emitted.set(id, { collection, key: k2, json });
    },
  };
  await builder.run(ctx);
  return { emitted };
}

export class NaiveEngine implements Engine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;

  constructor(opts: EngineOptions) {
    this.#kv = opts.kv;
    this.#topo = new Topology(opts.builders);
    this.#maxAttempts = opts.maxAttempts ?? 3;
  }

  async put(collection: string, key: string, value: Json): Promise<void> {
    this.#topo.assertSource(collection);
    const json = canonicalJson(value);
    if ((await this.#kv.get(k("r", collection, key))) === json) return;
    await this.#kv.commit([
      { key: k("r", collection, key), value: json },
      { key: k("m", "dirty"), value: "1" },
    ]);
  }

  async remove(collection: string, key: string): Promise<void> {
    this.#topo.assertSource(collection);
    if ((await this.#kv.get(k("r", collection, key))) === undefined) return;
    await this.#kv.commit([{ key: k("r", collection, key) }, { key: k("m", "dirty"), value: "1" }]);
  }

  async get(collection: string, key: string): Promise<Json | undefined> {
    const json = await this.#kv.get(k("r", collection, key));
    return json === undefined ? undefined : (JSON.parse(json) as Json);
  }

  async list(collection: string): Promise<{ key: string; value: Json }[]> {
    const out: { key: string; value: Json }[] = [];
    for await (const [key, json] of this.#kv.scan(kp("r", collection))) {
      out.push({ key: split(key)[2] as string, value: JSON.parse(json) });
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

  async run(): Promise<RunStats> {
    const stats: RunStats = { executed: 0, failed: 0, deadLettered: 0, pending: false };
    if ((await this.#kv.get(k("m", "dirty"))) === undefined) return stats;

    // Load stored state: rows, provenance (task → outputs), dead letters.
    const stored: Rows = new Map();
    for await (const [key, json] of this.#kv.scan(kp("r"))) {
      const [, collection, rk] = split(key) as [string, string, string];
      put(stored, collection, rk, json);
    }
    const prov = new Map<string, string[]>(); // builder\0task → output ids
    for await (const [key, json] of this.#kv.scan(kp("o"))) {
      const [, builder, task] = split(key) as [string, string, string];
      prov.set(k(builder, task), JSON.parse(json) as string[]);
    }

    // Fresh evaluation: sources as stored, derived collections recomputed.
    const rows: Rows = new Map();
    for (const [collection, m] of stored)
      if (!this.#topo.derived.has(collection)) rows.set(collection, m);
    const owner = new Map<string, string>(); // output id → builder\0task
    const newProv = new Map<string, string[]>();
    const dead = new Map<string, DeadLetter>();

    for (const id of this.#topo.order) {
      const builder = this.#topo.builder(id);
      for (const key of taskKeys(builder, rows)) {
        const taskId = k(id, key);
        let result: TaskResult | undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.#maxAttempts && !result; attempt++) {
          try {
            const r = await execTask(builder, key, rows);
            for (const outId of r.emitted.keys()) {
              const o = owner.get(outId);
              if (o !== undefined && o !== taskId) {
                const [os, ok] = split(outId);
                throw new ConflictingEmission(`${os}/${ok}: already emitted by ${o}`);
              }
            }
            result = r;
          } catch (error) {
            lastError = error;
            stats.failed++;
          }
        }
        let outputs: [string, string, string][]; // [id, collection, key]
        if (result) {
          stats.executed++;
          outputs = [...result.emitted.entries()].map(([oid, e]) => [oid, e.collection, e.key]);
          for (const [oid, e] of result.emitted) {
            put(rows, e.collection, e.key, e.json);
            owner.set(oid, taskId);
          }
        } else {
          // Keep the previous outputs of a failing task.
          stats.deadLettered++;
          dead.set(taskId, {
            builder: id,
            key,
            attempts: this.#maxAttempts,
            error: errorText(lastError),
          });
          outputs = [];
          for (const oid of prov.get(taskId) ?? []) {
            const [collection, rk] = split(oid) as [string, string];
            const json = stored.get(collection)?.get(rk);
            if (json === undefined || owner.has(oid)) continue;
            put(rows, collection, rk, json);
            owner.set(oid, taskId);
            outputs.push([oid, collection, rk]);
          }
        }
        if (outputs.length > 0)
          newProv.set(
            taskId,
            outputs.map(([oid]) => oid),
          );
      }
    }

    // Diff and commit.
    const writes: { key: string; value?: string }[] = [];
    for (const collection of this.#topo.derived) {
      const before = stored.get(collection) ?? new Map();
      const after = rows.get(collection) ?? new Map();
      for (const [rk, json] of after) {
        if (before.get(rk) !== json) writes.push({ key: k("r", collection, rk), value: json });
      }
      for (const rk of before.keys())
        if (!after.has(rk)) writes.push({ key: k("r", collection, rk) });
    }
    for (const taskId of prov.keys())
      if (!newProv.has(taskId)) writes.push({ key: k("o", taskId) });
    for (const [taskId, outs] of newProv) {
      writes.push({ key: k("o", taskId), value: JSON.stringify(outs) });
    }
    for await (const [key] of this.#kv.scan(kp("d"))) writes.push({ key });
    for (const [taskId, d] of dead) {
      writes.push({
        key: k("d", taskId),
        value: JSON.stringify({ attempts: d.attempts, error: d.error }),
      });
    }
    writes.push({ key: k("m", "dirty") });
    await this.#kv.commit(dedupe(writes));
    return stats;
  }
}

function put(rows: Rows, collection: string, key: string, json: string): void {
  let m = rows.get(collection);
  if (!m) {
    m = new Map();
    rows.set(collection, m);
  }
  m.set(key, json);
}

/** Last write per key wins (a delete followed by a put of the same key). */
function dedupe(writes: { key: string; value?: string }[]): { key: string; value?: string }[] {
  const m = new Map<string, { key: string; value?: string }>();
  for (const w of writes) m.set(w.key, w);
  return [...m.values()];
}
