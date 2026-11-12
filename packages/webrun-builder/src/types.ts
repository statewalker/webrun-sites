import type { Logger } from "./logger.js";
import type { KV } from "./store/kv.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A row of a collection. */
export interface Row {
  key: string;
  value: Json;
}

/** A reference to a row: `collection/key`. */
export interface RowRef {
  collection: string;
  key: string;
}

/**
 * What a task sees. Reads are its dependencies: when a row it read (or a collection
 * it listed) changes, the task runs again. Reads may be dynamic — which rows a
 * task reads may depend on values it read — as long as the collection is declared
 * in the builder's `inputs` or `reads`.
 */
export interface TaskContext {
  /** The task key: the row key for a map builder, `"*"` for a reduce builder. */
  readonly key: string;
  /** Read one row (a tracked dependency). */
  get(collection: string, key: string): Promise<Json | undefined>;
  /** Read a whole collection ordered by key (a tracked dependency on the collection). */
  list(collection: string): Promise<Row[]>;
  /** Produce an output row. Everything a task emits in a successful run is its output set. */
  emit(collection: string, key: string, value: Json): void;
  /**
   * Incremental reduce builders only: the state the task saved with `setState` in
   * its last successful run; `undefined` on the first run or after
   * `invalidate` — then recompute from `list` and save a fresh state.
   */
  readonly state: Json | undefined;
  /** Incremental reduce builders only: save state for the next run (small: it is stored with the trace). */
  setState(state: Json): void;
  /**
   * Incremental reduce builders only: the rows of input `collection` that changed
   * since the last successful run, with their current value (`undefined` if
   * removed) and their value at that run (`undefined` if new).
   */
  changes(collection: string): Promise<Change[]>;
}

export interface Change {
  key: string;
  value: Json | undefined;
  previous: Json | undefined;
}

/**
 * A builder: a pure function run per task.
 *
 * - `kind: "map"` (default) — one task per key present on any of `inputs`. When the
 *   key is gone from every input, the task is dead: its outputs are retracted and
 *   `dispose` is called; `run` is not.
 * - `kind: "reduce"` — one task (key `"*"`) that aggregates whole collections via
 *   `ctx.list`; it runs at least once, and again whenever anything it read changed.
 *
 * Each output row has exactly one producing task; a second producer fails with
 * `ConflictingEmission`. Re-emitting a value equal to the stored one is not a
 * change (early cut-off). Rows a task stops emitting are retracted, and the
 * retraction cascades.
 */
export interface BuilderDef {
  id: string;
  kind?: "map" | "reduce";
  /** Collections whose keys define this builder's tasks (map) or that it aggregates (reduce). */
  inputs: readonly string[];
  /** Extra collections the builder may read with `ctx.get` / `ctx.list`. */
  reads?: readonly string[];
  outputs: readonly string[];
  /**
   * Reduce builders only: fold `ctx.changes()` into `ctx.state` instead of
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
  builders: readonly BuilderDef[];
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
  /** Called after each committed batch (for progress displays and logs). */
  onProgress?: (progress: RunProgress) => void;
}

/** One committed batch of a run: all its tasks belong to one builder. */
export interface RunProgress {
  builder: string;
  /** Tasks claimed in the batch. */
  tasks: number;
  executed: number;
  skipped: number;
  failed: number;
  deadLettered: number;
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
  builder: string;
  key: string;
  attempts: number;
  error: string;
}

export interface BuildStatus {
  /** Queued tasks per builder (builders with none are omitted). */
  queued: Record<string, number>;
  deadLetters: number;
}

export class ConflictingEmission extends Error {
  override name = "ConflictingEmission";
}
