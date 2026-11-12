/**
 * P0 — full recompute. The reference semantics and the benchmark baseline.
 *
 * `run()` re-evaluates every task of every cell from the sources (skipping
 * the run entirely when no source changed since the last one), diffs the
 * result with the stored rows and commits the difference in one transaction.
 * A task that keeps failing keeps its previous outputs.
 */
import type { KV } from "../core/kv.js";
import {
  type CellDef,
  ConflictingEmission,
  type DeadLetter,
  type Engine,
  type EngineOptions,
  type Json,
  type RunStats,
  type TaskContext,
} from "../core/types.js";
import { canonicalJson, errorText, k, kp, split, Topology } from "../core/util.js";

type Rows = Map<string, Map<string, string>>; // signal → key → canonical json

/** Map-cell task keys: the union of keys over the cell's inputs, sorted. */
export function taskKeys(cell: CellDef, rows: Rows): string[] {
  if (cell.kind === "reduce") return ["*"];
  const keys = new Set<string>();
  for (const s of cell.inputs) for (const key of rows.get(s)?.keys() ?? []) keys.add(key);
  return [...keys].sort();
}

export interface TaskResult {
  emitted: Map<string, { signal: string; key: string; json: string }>;
}

/** Execute one task against `rows`; throws what the cell throws. */
export async function execTask(cell: CellDef, key: string, rows: Rows): Promise<TaskResult> {
  const readable = new Set([...cell.inputs, ...(cell.reads ?? [])]);
  const emitted = new Map<string, { signal: string; key: string; json: string }>();
  const check = (signal: string) => {
    if (!readable.has(signal)) throw new Error(`Cell "${cell.id}" read undeclared "${signal}"`);
  };
  const ctx: TaskContext = {
    key,
    async get(signal, k2) {
      check(signal);
      const json = rows.get(signal)?.get(k2);
      return json === undefined ? undefined : (JSON.parse(json) as Json);
    },
    async list(signal) {
      check(signal);
      const m = rows.get(signal);
      if (!m) return [];
      return [...m.keys()]
        .sort()
        .map((k2) => ({ key: k2, value: JSON.parse(m.get(k2) as string) }));
    },
    emit(signal, k2, value) {
      if (!cell.outputs.includes(signal)) {
        throw new Error(`Cell "${cell.id}" emitted to undeclared signal "${signal}"`);
      }
      const json = canonicalJson(value);
      const id = k(signal, k2);
      const prior = emitted.get(id);
      if (prior && prior.json !== json) {
        throw new ConflictingEmission(`${signal}/${k2}: emitted twice with different values`);
      }
      emitted.set(id, { signal, key: k2, json });
    },
  };
  await cell.run(ctx);
  return { emitted };
}

export class NaiveEngine implements Engine {
  readonly #kv: KV;
  readonly #topo: Topology;
  readonly #maxAttempts: number;

  constructor(opts: EngineOptions) {
    this.#kv = opts.kv;
    this.#topo = new Topology(opts.cells);
    this.#maxAttempts = opts.maxAttempts ?? 3;
  }

  async put(signal: string, key: string, value: Json): Promise<void> {
    this.#topo.assertSource(signal);
    const json = canonicalJson(value);
    if ((await this.#kv.get(k("r", signal, key))) === json) return;
    await this.#kv.commit([
      { key: k("r", signal, key), value: json },
      { key: k("m", "dirty"), value: "1" },
    ]);
  }

  async remove(signal: string, key: string): Promise<void> {
    this.#topo.assertSource(signal);
    if ((await this.#kv.get(k("r", signal, key))) === undefined) return;
    await this.#kv.commit([{ key: k("r", signal, key) }, { key: k("m", "dirty"), value: "1" }]);
  }

  async get(signal: string, key: string): Promise<Json | undefined> {
    const json = await this.#kv.get(k("r", signal, key));
    return json === undefined ? undefined : (JSON.parse(json) as Json);
  }

  async list(signal: string): Promise<{ key: string; value: Json }[]> {
    const out: { key: string; value: Json }[] = [];
    for await (const [key, json] of this.#kv.scan(kp("r", signal))) {
      out.push({ key: split(key)[2] as string, value: JSON.parse(json) });
    }
    return out;
  }

  async deadLetters(): Promise<DeadLetter[]> {
    const out: DeadLetter[] = [];
    for await (const [key, json] of this.#kv.scan(kp("d"))) {
      const [, cell, task] = split(key);
      out.push({ cell: cell as string, key: task as string, ...JSON.parse(json) });
    }
    return out;
  }

  async run(): Promise<RunStats> {
    const stats: RunStats = { executed: 0, failed: 0, deadLettered: 0, pending: false };
    if ((await this.#kv.get(k("m", "dirty"))) === undefined) return stats;

    // Load stored state: rows, provenance (task → outputs), dead letters.
    const stored: Rows = new Map();
    for await (const [key, json] of this.#kv.scan(kp("r"))) {
      const [, signal, rk] = split(key) as [string, string, string];
      put(stored, signal, rk, json);
    }
    const prov = new Map<string, string[]>(); // cell\0task → output ids
    for await (const [key, json] of this.#kv.scan(kp("o"))) {
      const [, cell, task] = split(key) as [string, string, string];
      prov.set(k(cell, task), JSON.parse(json) as string[]);
    }

    // Fresh evaluation: sources as stored, derived signals recomputed.
    const rows: Rows = new Map();
    for (const [signal, m] of stored) if (!this.#topo.derived.has(signal)) rows.set(signal, m);
    const owner = new Map<string, string>(); // output id → cell\0task
    const newProv = new Map<string, string[]>();
    const dead = new Map<string, DeadLetter>();

    for (const id of this.#topo.order) {
      const cell = this.#topo.cell(id);
      for (const key of taskKeys(cell, rows)) {
        const taskId = k(id, key);
        let result: TaskResult | undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= this.#maxAttempts && !result; attempt++) {
          try {
            const r = await execTask(cell, key, rows);
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
        let outputs: [string, string, string][]; // [id, signal, key]
        if (result) {
          stats.executed++;
          outputs = [...result.emitted.entries()].map(([oid, e]) => [oid, e.signal, e.key]);
          for (const [oid, e] of result.emitted) {
            put(rows, e.signal, e.key, e.json);
            owner.set(oid, taskId);
          }
        } else {
          // Keep the previous outputs of a failing task.
          stats.deadLettered++;
          dead.set(taskId, {
            cell: id,
            key,
            attempts: this.#maxAttempts,
            error: errorText(lastError),
          });
          outputs = [];
          for (const oid of prov.get(taskId) ?? []) {
            const [signal, rk] = split(oid) as [string, string];
            const json = stored.get(signal)?.get(rk);
            if (json === undefined || owner.has(oid)) continue;
            put(rows, signal, rk, json);
            owner.set(oid, taskId);
            outputs.push([oid, signal, rk]);
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
    for (const signal of this.#topo.derived) {
      const before = stored.get(signal) ?? new Map();
      const after = rows.get(signal) ?? new Map();
      for (const [rk, json] of after) {
        if (before.get(rk) !== json) writes.push({ key: k("r", signal, rk), value: json });
      }
      for (const rk of before.keys()) if (!after.has(rk)) writes.push({ key: k("r", signal, rk) });
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

function put(rows: Rows, signal: string, key: string, json: string): void {
  let m = rows.get(signal);
  if (!m) {
    m = new Map();
    rows.set(signal, m);
  }
  m.set(key, json);
}

/** Last write per key wins (a delete followed by a put of the same key). */
function dedupe(writes: { key: string; value?: string }[]): { key: string; value?: string }[] {
  const m = new Map<string, { key: string; value?: string }>();
  for (const w of writes) m.set(w.key, w);
  return [...m.values()];
}
