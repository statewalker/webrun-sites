import { DataflowGraph } from "@statewalker/webrun-dataflow";
import type { SqlDriver, SqlStatement } from "@statewalker/webrun-files-sqlite";
import { canonicalJson } from "./canonical-json.js";
import { SCHEMA } from "./schema.js";
import type { Cell, CellEngineOptions, Json } from "./types.js";

/** One seq bump per transaction: every pending row it writes gets the new value. */
const BUMP: SqlStatement = { sql: "UPDATE cells_meta SET value = value + 1 WHERE name = 'seq'" };

export class CellEngine {
  readonly #db: SqlDriver;
  readonly #cells: Map<string, Cell>;
  readonly #graph: DataflowGraph;
  /** All cells, upstream first. */
  readonly #order: string[];
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #now: () => number;
  #ready?: Promise<void>;

  constructor(opts: CellEngineOptions) {
    for (const cell of opts.cells) {
      const own = cell.outputs.find((signal) => cell.inputs.includes(signal));
      if (own !== undefined) throw new Error(`Cell "${cell.id}" consumes its own output "${own}"`);
    }
    this.#graph = new DataflowGraph(
      opts.cells.map((c) => ({ id: c.id, inputs: [...c.inputs], outputs: [...c.outputs] })),
    );
    this.#order = this.#graph.getExecutionOrderFromCells(this.#graph.getAllCells());
    this.#cells = new Map(opts.cells.map((c) => [c.id, c]));
    this.#db = opts.db;
    this.#owner = opts.owner ?? crypto.randomUUID();
    this.#leaseMs = opts.leaseMs ?? 30_000;
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#batchSize = opts.batchSize ?? 32;
    this.#now = opts.now ?? Date.now;
  }

  async put(signal: string, key: string, value: Json): Promise<void> {
    this.#assertSource(signal);
    const json = canonicalJson(value);
    await this.#init();
    if ((await this.#value(signal, key)) === json) return;
    await this.#db.transaction([
      {
        sql: "INSERT INTO cells_rows (signal, key, value) VALUES (?, ?, ?) ON CONFLICT (signal, key) DO UPDATE SET value = excluded.value",
        params: [signal, key, json],
      },
      ...this.#enqueue(signal, key),
    ]);
  }

  async remove(signal: string, key: string): Promise<void> {
    this.#assertSource(signal);
    await this.#init();
    if ((await this.#value(signal, key)) === undefined) return;
    await this.#db.transaction([
      { sql: "DELETE FROM cells_rows WHERE signal = ? AND key = ?", params: [signal, key] },
      ...this.#enqueue(signal, key),
    ]);
  }

  async get(signal: string, key: string): Promise<Json | undefined> {
    await this.#init();
    const value = await this.#value(signal, key);
    return value === undefined ? undefined : (JSON.parse(value) as Json);
  }

  async list(signal: string): Promise<{ key: string; value: Json }[]> {
    await this.#init();
    const rows = await this.#db.all<{ key: string; value: string }>(
      "SELECT key, value FROM cells_rows WHERE signal = ? ORDER BY key",
      signal,
    );
    return rows.map(({ key, value }) => ({ key, value: JSON.parse(value) as Json }));
  }

  #assertSource(signal: string): void {
    if (this.#graph.getCellsProducing(signal).size > 0) {
      throw new Error(`"${signal}" is not a source signal: it is produced by a cell`);
    }
  }

  #init(): Promise<void> {
    this.#ready ??= Promise.resolve(this.#db.transaction(SCHEMA)).then(() => undefined);
    return this.#ready;
  }

  async #value(signal: string, key: string): Promise<string | undefined> {
    const [row] = await this.#db.all<{ value: string }>(
      "SELECT value FROM cells_rows WHERE signal = ? AND key = ?",
      signal,
      key,
    );
    return row?.value;
  }

  /** Queue every consumer of `signal` for `key`. */
  #enqueue(signal: string, key: string, onlyIfAbsent = false): SqlStatement[] {
    const consumers = [...this.#graph.getCellsConsuming(signal)];
    if (consumers.length === 0) return [];
    return [BUMP, ...consumers.map((cell) => this.#pendingInsert(cell, signal, key, onlyIfAbsent))];
  }

  /**
   * Upsert a queue row with the current seq. A newer change replaces the seq,
   * so a commit that deletes "its" seq leaves the newer change queued.
   * `onlyIfAbsent`: enqueue only if the row no longer exists at commit time.
   */
  #pendingInsert(cell: string, signal: string, key: string, onlyIfAbsent = false): SqlStatement {
    const guard = onlyIfAbsent ? " AND NOT EXISTS (SELECT 1 FROM cells_rows WHERE signal = ? AND key = ?)" : "";
    return {
      sql: `INSERT INTO cells_pending (cell, signal, key, seq) SELECT ?, ?, ?, value FROM cells_meta WHERE name = 'seq'${guard} ON CONFLICT (cell, signal, key) DO UPDATE SET seq = excluded.seq, attempts = 0`,
      params: onlyIfAbsent ? [cell, signal, key, signal, key] : [cell, signal, key],
    };
  }
}
