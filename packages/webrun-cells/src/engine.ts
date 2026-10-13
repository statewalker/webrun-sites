import { DataflowGraph } from "@statewalker/webrun-dataflow";
import type { SqlDriver, SqlStatement } from "@statewalker/webrun-files-sqlite";
import { canonicalJson } from "./canonical-json.js";
import { SCHEMA } from "./schema.js";
import type {
  Cell,
  CellEngineOptions,
  CellInput,
  DeadLetter,
  Emission,
  Json,
  RunResult,
} from "./types.js";

/** One seq bump per transaction: every pending row it writes gets the new value. */
const BUMP: SqlStatement = { sql: "UPDATE cells_meta SET value = value + 1 WHERE name = 'seq'" };

export class ConflictingEmission extends Error {
  override name = "ConflictingEmission";
}

type Claimed = { signal: string; key: string; seq: number; attempts: number };
type Live = { claim: Claimed; input: CellInput };
type Row = { signal: string; key: string; json: string };

const rowId = (signal: string, key: string) => JSON.stringify([signal, key]);

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

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

  async deadLetters(): Promise<DeadLetter[]> {
    await this.#init();
    return this.#db.all<DeadLetter>(
      "SELECT cell, signal, key, attempts, error FROM cells_dead_letter ORDER BY cell, signal, key",
    );
  }

  /** Put a dead-lettered input back in the queue with a fresh attempt count. */
  async requeue(cell: string, signal: string, key: string): Promise<void> {
    if (!this.#cells.has(cell)) throw new Error(`Unknown cell "${cell}"`);
    await this.#init();
    await this.#db.transaction([
      {
        sql: "DELETE FROM cells_dead_letter WHERE cell = ? AND signal = ? AND key = ?",
        params: [cell, signal, key],
      },
      BUMP,
      this.#pendingInsert(cell, signal, key),
    ]);
  }

  /**
   * Claim → run → commit until no claimable work is left. Restarts from the
   * most upstream cell after every batch, so a consumer only runs once its
   * producers have drained.
   */
  async run(): Promise<RunResult> {
    await this.#init();
    const result: RunResult = { committed: 0, failed: 0, deadLettered: 0 };
    // Cells whose last batch pulled nothing: not claimed again in this run.
    const stalled = new Set<string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of this.#order) {
        if (stalled.has(id)) continue;
        const batch = await this.#claim(id);
        if (batch.length === 0) continue;
        if (!(await this.#runBatch(this.#cells.get(id) as Cell, batch, result))) stalled.add(id);
        progressed = true;
        break;
      }
    }
    return result;
  }

  async #claim(cell: string): Promise<Claimed[]> {
    const now = this.#now();
    const rows = await this.#db.all<Claimed>(
      "SELECT signal, key, seq, attempts FROM cells_pending WHERE cell = ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY seq, signal, key LIMIT ?",
      cell,
      now,
      this.#batchSize,
    );
    if (rows.length === 0) return [];
    // The lease condition is repeated so a concurrent claimer that selected the
    // same rows gets a zero count and drops them.
    const counts = await this.#db.transaction(
      rows.map((r) => ({
        sql: "UPDATE cells_pending SET lease_owner = ?, lease_until = ? WHERE cell = ? AND signal = ? AND key = ? AND seq = ? AND (lease_until IS NULL OR lease_until <= ?)",
        params: [this.#owner, now + this.#leaseMs, cell, r.signal, r.key, r.seq, now],
      })),
    );
    return rows.filter((_, i) => counts[i] === 1);
  }

  /** Returns false when the batch made no progress at all (cell pulled nothing). */
  async #runBatch(cell: Cell, batch: Claimed[], result: RunResult): Promise<boolean> {
    const live: Live[] = [];
    for (const claim of batch) {
      const value = await this.#value(claim.signal, claim.key);
      if (value === undefined) {
        // The input row is gone: retract what it produced, without the cell.
        await this.#commit(cell, claim, new Map());
        result.committed++;
      } else {
        live.push({ claim, input: { signal: claim.signal, key: claim.key, value: JSON.parse(value) as Json } });
      }
    }
    const retracted = live.length < batch.length;
    if (live.length === 0) return retracted;

    let current = -1; // index in `live` of the input last pulled
    let committedUpTo = -1; // inputs live[0..committedUpTo] are committed
    let emitted = new Map<string, Row>();
    let fatal: unknown; // a database error during a commit
    let failure: unknown; // the current input's failure

    const commitCurrent = async (): Promise<boolean> => {
      if (current <= committedUpTo) return true;
      try {
        await this.#commit(cell, (live[current] as Live).claim, emitted);
        committedUpTo = current;
        result.committed++;
        return true;
      } catch (error) {
        fatal = error;
        return false;
      }
    };

    // Created once, so a cell that asks for the iterator twice cannot replay inputs.
    const iterator = (async function* () {
      for (const [i, item] of live.entries()) {
        if (current >= 0 && !(await commitCurrent())) return;
        current = i;
        emitted = new Map();
        yield item.input;
      }
    })();

    const accept = async (e: Emission): Promise<Error | undefined> => {
      if (current < 0) return new Error(`Cell "${cell.id}" emitted before pulling an input`);
      if (!cell.outputs.includes(e.signal)) {
        return new Error(`Cell "${cell.id}" emitted to undeclared signal "${e.signal}"`);
      }
      let json: string;
      try {
        json = canonicalJson(e.value);
      } catch (error) {
        return error as Error;
      }
      const id = rowId(e.signal, e.key);
      const claim = (live[current] as Live).claim;
      const prior = emitted.get(id);
      if (prior && prior.json !== json) {
        return new ConflictingEmission(`${e.signal}/${e.key}: emitted twice with different values`);
      }
      const stored = await this.#value(e.signal, e.key);
      if (stored !== undefined && stored !== json) {
        const [other] = await this.#db.all<{ cell: string; in_signal: string; in_key: string }>(
          "SELECT cell, in_signal, in_key FROM cells_provenance WHERE out_signal = ? AND out_key = ? AND NOT (cell = ? AND in_signal = ? AND in_key = ?) LIMIT 1",
          e.signal,
          e.key,
          cell.id,
          claim.signal,
          claim.key,
        );
        if (other) {
          return new ConflictingEmission(
            `${e.signal}/${e.key}: ${cell.id}(${claim.signal}/${claim.key}) emits a value different from ${other.cell}(${other.in_signal}/${other.in_key})`,
          );
        }
      }
      emitted.set(id, { signal: e.signal, key: e.key, json });
      return undefined;
    };

    let gen: AsyncIterator<Emission> | undefined;
    try {
      gen = cell.run({ [Symbol.asyncIterator]: () => iterator })[Symbol.asyncIterator]();
      for (;;) {
        const step = await gen.next();
        if (step.done || fatal) break;
        failure = await accept(step.value);
        if (failure) break;
      }
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined || fatal) await gen?.return?.(undefined);
    if (fatal) throw fatal;

    if (failure !== undefined) {
      const at = Math.max(current, 0);
      await this.#fail(cell, (live[at] as Live).claim, failure, result);
      await this.#release(cell, live.slice(at + 1).map((l) => l.claim));
      return true;
    }
    if (current >= 0 && !(await commitCurrent())) throw fatal;
    await this.#release(cell, live.slice(current + 1).map((l) => l.claim));
    return retracted || current >= 0;
  }

  /**
   * One transaction: replace the input's provenance, write changed outputs and
   * queue their consumers, retract outputs no longer emitted (unless another
   * input still produces them), dequeue the claimed seq, clear any dead letter.
   */
  async #commit(cell: Cell, claim: Claimed, emitted: Map<string, Row>): Promise<void> {
    const input = [cell.id, claim.signal, claim.key];
    const previous = await this.#db.all<{ out_signal: string; out_key: string }>(
      "SELECT out_signal, out_key FROM cells_provenance WHERE cell = ? AND in_signal = ? AND in_key = ?",
      ...input,
    );
    const statements: SqlStatement[] = [
      { sql: "DELETE FROM cells_provenance WHERE cell = ? AND in_signal = ? AND in_key = ?", params: input },
    ];
    for (const row of emitted.values()) {
      statements.push({
        sql: "INSERT INTO cells_provenance (cell, in_signal, in_key, out_signal, out_key) VALUES (?, ?, ?, ?, ?)",
        params: [...input, row.signal, row.key],
      });
      if ((await this.#value(row.signal, row.key)) !== row.json) {
        statements.push(
          {
            sql: "INSERT INTO cells_rows (signal, key, value) VALUES (?, ?, ?) ON CONFLICT (signal, key) DO UPDATE SET value = excluded.value",
            params: [row.signal, row.key, row.json],
          },
          ...this.#enqueue(row.signal, row.key),
        );
      }
    }
    for (const { out_signal, out_key } of previous) {
      if (emitted.has(rowId(out_signal, out_key))) continue;
      statements.push(
        {
          sql: "DELETE FROM cells_rows WHERE signal = ? AND key = ? AND NOT EXISTS (SELECT 1 FROM cells_provenance WHERE out_signal = ? AND out_key = ?)",
          params: [out_signal, out_key, out_signal, out_key],
        },
        ...this.#enqueue(out_signal, out_key, true),
      );
    }
    statements.push(
      { sql: "DELETE FROM cells_pending WHERE cell = ? AND signal = ? AND key = ? AND seq = ?", params: [...input, claim.seq] },
      { sql: "UPDATE cells_pending SET lease_owner = NULL, lease_until = NULL WHERE cell = ? AND signal = ? AND key = ?", params: input },
      { sql: "DELETE FROM cells_dead_letter WHERE cell = ? AND signal = ? AND key = ?", params: input },
    );
    await this.#db.transaction(statements);
  }

  /** Retry immediately (lease cleared, attempts + 1) or move to the dead letter. */
  async #fail(cell: Cell, claim: Claimed, error: unknown, result: RunResult): Promise<void> {
    result.failed++;
    const input = [cell.id, claim.signal, claim.key];
    const unlease: SqlStatement = {
      sql: "UPDATE cells_pending SET lease_owner = NULL, lease_until = NULL WHERE cell = ? AND signal = ? AND key = ?",
      params: input,
    };
    const attempts = claim.attempts + 1;
    if (attempts < this.#maxAttempts) {
      await this.#db.transaction([
        {
          sql: "UPDATE cells_pending SET attempts = attempts + 1 WHERE cell = ? AND signal = ? AND key = ? AND seq = ?",
          params: [...input, claim.seq],
        },
        unlease,
      ]);
      return;
    }
    result.deadLettered++;
    await this.#db.transaction([
      {
        sql: "INSERT INTO cells_dead_letter (cell, signal, key, attempts, error) VALUES (?, ?, ?, ?, ?) ON CONFLICT (cell, signal, key) DO UPDATE SET attempts = excluded.attempts, error = excluded.error",
        params: [...input, attempts, errorText(error)],
      },
      { sql: "DELETE FROM cells_pending WHERE cell = ? AND signal = ? AND key = ? AND seq = ?", params: [...input, claim.seq] },
      unlease,
    ]);
  }

  async #release(cell: Cell, claims: Claimed[]): Promise<void> {
    if (claims.length === 0) return;
    await this.#db.transaction(
      claims.map((c) => ({
        sql: "UPDATE cells_pending SET lease_owner = NULL, lease_until = NULL WHERE cell = ? AND signal = ? AND key = ? AND lease_owner = ?",
        params: [cell.id, c.signal, c.key, this.#owner],
      })),
    );
  }

  #assertSource(signal: string): void {
    if (this.#graph.getCellsProducing(signal).size > 0) {
      throw new Error(`"${signal}" is not a source signal: it is produced by a cell`);
    }
  }

  #init(): Promise<void> {
    this.#ready ??= Promise.resolve()
      .then(() => this.#db.transaction(SCHEMA))
      .then(
        () => undefined,
        (error) => {
          this.#ready = undefined;
          throw error;
        },
      );
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
