import type { Logger } from "./logger.js";
import type { KV } from "./store/kv.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A row of a signal. */
export interface Row {
  key: string;
  value: Json;
}

/** A reference to a row: `signal/key`. */
export interface RowRef {
  signal: string;
  key: string;
}

/**
 * What a task sees. Reads are its dependencies: when a row it read (or a signal
 * it listed) changes, the task runs again. Reads may be dynamic — which rows a
 * task reads may depend on values it read — as long as the signal is declared
 * in the cell's `inputs` or `reads`.
 */
export interface TaskContext {
  /** The task key: the row key for a map cell, `"*"` for a reduce cell. */
  readonly key: string;
  /** Read one row (a tracked dependency). */
  get(signal: string, key: string): Promise<Json | undefined>;
  /** Read a whole signal ordered by key (a tracked dependency on the signal). */
  list(signal: string): Promise<Row[]>;
  /** Produce an output row. Everything a task emits in a successful run is its output set. */
  emit(signal: string, key: string, value: Json): void;
  /**
   * Incremental reduce cells only: the state the task saved with `setState` in
   * its last successful run; `undefined` on the first run or after
   * `invalidate` — then recompute from `list` and save a fresh state.
   */
  readonly state: Json | undefined;
  /** Incremental reduce cells only: save state for the next run (small: it is stored with the trace). */
  setState(state: Json): void;
  /**
   * Incremental reduce cells only: the rows of input `signal` that changed
   * since the last successful run, with their current value (`undefined` if
   * removed) and their value at that run (`undefined` if new).
   */
  changes(signal: string): Promise<Change[]>;
}

export interface Change {
  key: string;
  value: Json | undefined;
  previous: Json | undefined;
}

/**
 * A cell: a pure function run per task.
 *
 * - `kind: "map"` (default) — one task per key present on any of `inputs`. When the
 *   key is gone from every input, the task is dead: its outputs are retracted and
 *   `dispose` is called; `run` is not.
 * - `kind: "reduce"` — one task (key `"*"`) that aggregates whole signals via
 *   `ctx.list`; it runs at least once, and again whenever anything it read changed.
 *
 * Each output row has exactly one producing task; a second producer fails with
 * `ConflictingEmission`. Re-emitting a value equal to the stored one is not a
 * change (early cut-off). Rows a task stops emitting are retracted, and the
 * retraction cascades.
 */
export interface CellDef {
  id: string;
  kind?: "map" | "reduce";
  /** Signals whose keys define this cell's tasks (map) or that it aggregates (reduce). */
  inputs: readonly string[];
  /** Extra signals the cell may read with `ctx.get` / `ctx.list`. */
  reads?: readonly string[];
  outputs: readonly string[];
  /**
   * Reduce cells only: fold `ctx.changes()` into `ctx.state` instead of
   * re-listing the inputs on every change. The engine then records, per input
   * row change, the value the row had at the task's last run.
   */
  incremental?: boolean;
  run(ctx: TaskContext): void | Promise<void>;
  /**
   * Clean up external side effects (files written by `run`) of a dead map task.
   * Called before the retraction commits, so it may run again after a crash:
   * keep it idempotent. A throw fails the task like a throw from `run`.
   */
  dispose?(key: string, outputs: readonly RowRef[]): void | Promise<void>;
}

export interface BuildEngineOptions {
  /** Where all state lives: rows, queue, traces, dead letters. */
  store: KV;
  cells: readonly CellDef[];
  /** Attempts before a failing task moves to the dead letter (default 3). */
  maxAttempts?: number;
  /**
   * Tasks committed per store transaction (default 64). A crash loses at most
   * one batch of work; larger batches make cold builds cheaper.
   */
  batchSize?: number;
  /** Tasks of one batch executed concurrently (default 1). */
  concurrency?: number;
  logger?: Logger;
  /**
   * Several engines (processes) share this store (default false): claims are
   * then leases taken with conditional writes, so a task runs in one engine at
   * a time. Needs a store whose conditions hold across those engines — `SqlKV`
   * across processes, `MemKV` within one; not `FilesKV` (single process).
   * Costs one extra commit per batch.
   */
  shared?: boolean;
  /**
   * With `shared`: how long a claimed batch stays reserved (default 30 s); a
   * crashed engine's claims become available again after this. Keep it longer
   * than a batch takes.
   */
  leaseMs?: number;
  /** Clock for leases (default `Date.now`). */
  now?: () => number;
  /** Lease holder id (default: random). */
  owner?: string;
}

export interface RunOptions {
  /** Stop after this many task executions (cooperative interruption). */
  maxTasks?: number;
  /** Stop between batches once aborted. */
  signal?: AbortSignal;
}

export interface RunStats {
  /** Task executions that committed, including retractions of dead tasks. */
  executed: number;
  /** Queued tasks found unchanged (everything they read hashes equal) and dequeued without running. */
  skipped: number;
  /** Failed attempts. */
  failed: number;
  /** Tasks moved to the dead letter in this run. */
  deadLettered: number;
  /**
   * True when the run stopped with work still queued: `maxTasks`, abort, or
   * the most upstream work is leased by another engine.
   */
  pending: boolean;
}

export interface DeadLetter {
  cell: string;
  key: string;
  attempts: number;
  error: string;
}

export interface BuildStatus {
  /** Queued tasks per cell (cells with none are omitted). */
  queued: Record<string, number>;
  deadLetters: number;
}

export class ConflictingEmission extends Error {
  override name = "ConflictingEmission";
}
