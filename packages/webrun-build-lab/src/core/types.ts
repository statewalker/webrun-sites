/**
 * The common contract every prototype engine implements. The conformance suite
 * and the benchmark talk to engines only through these types.
 *
 * Model
 * -----
 * - A **collection** is a named collection of rows `key → value` (values are small
 *   JSON: data, or a fingerprint of an artifact stored elsewhere).
 * - A **source** collection is written by the caller (`put` / `remove`); every other
 *   collection is written only by builders.
 * - A **builder** is a pure function run per **task**:
 *   - `kind: "map"` (default): one task per key present on any of the builder's
 *     `inputs`. The task key is that key. When the key is gone from every input,
 *     the task is dead: the engine retracts what it emitted, without calling it.
 *   - `kind: "reduce"`: a single task (key `"*"`) that reads whole collections via
 *     `ctx.list`. It runs whenever anything it read changed.
 * - A task reads through `ctx.get` / `ctx.list` (only on collections declared in
 *   `inputs` or `reads`) and writes through `ctx.emit` (only to `outputs`).
 *   Everything a task emitted in its last successful execution is its output
 *   set; outputs it no longer emits are retracted. Each output row has exactly
 *   one producing task; a second producer fails with `ConflictingEmission`.
 * - Reads are the task's dependencies. They may be dynamic (which keys a task
 *   reads may depend on values it read), as long as the collections are declared.
 *
 * Guarantees an engine must give
 * ------------------------------
 * - **Correct**: after `run()` resolves with nothing pending, every collection
 *   equals what a from-scratch evaluation of the builders over the sources gives.
 * - **Incremental**: only tasks whose reads changed are executed.
 * - **Early cut-off**: re-emitting a value equal to the stored one is not a
 *   change and triggers nothing downstream.
 * - **Glitch-free**: a task is not executed while one of its upstream tasks
 *   still has pending work in this run (so a diamond's join runs once).
 * - **Idempotent / resumable**: a task's results commit atomically with the
 *   removal of its pending state; a crash at any commit loses only uncommitted
 *   tasks, and a new engine over the same store finishes the work.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface TaskContext {
  /** The task key (`"*"` for a reduce builder). */
  readonly key: string;
  /** Read one row; a tracked dependency. */
  get(collection: string, key: string): Promise<Json | undefined>;
  /** Read a whole collection ordered by key; a tracked dependency on the collection. */
  list(collection: string): Promise<{ key: string; value: Json }[]>;
  /** Produce an output row. */
  emit(collection: string, key: string, value: Json): void;
}

export interface BuilderDef {
  id: string;
  kind?: "map" | "reduce";
  /** Collections whose keys define this builder's tasks (map) / that it aggregates (reduce). */
  inputs: readonly string[];
  /** Extra collections the builder may read with `ctx.get` / `ctx.list` (dynamic dependencies). */
  reads?: readonly string[];
  outputs: readonly string[];
  run(ctx: TaskContext): Promise<void> | void;
}

export interface RunOptions {
  /** Stop after executing this many tasks (cooperative interruption). */
  maxTasks?: number;
}

export interface RunStats {
  /** Task executions that completed and committed (including retractions). */
  executed: number;
  /** Failed attempts. */
  failed: number;
  /** Tasks moved to the dead letter in this run. */
  deadLettered: number;
  /** Whether work is still pending (only with `maxTasks`, or a dead letter). */
  pending: boolean;
}

export interface DeadLetter {
  builder: string;
  key: string;
  attempts: number;
  error: string;
}

export interface Engine {
  put(collection: string, key: string, value: Json): Promise<unknown>;
  remove(collection: string, key: string): Promise<unknown>;
  get(collection: string, key: string): Promise<Json | undefined>;
  list(collection: string): Promise<{ key: string; value: Json }[]>;
  run(opts?: RunOptions): Promise<RunStats>;
  deadLetters(): Promise<DeadLetter[]>;
}

export interface EngineOptions {
  kv: import("./kv.js").KV;
  builders: readonly BuilderDef[];
  /** Attempts before a failing task is dead-lettered (default 3). */
  maxAttempts?: number;
}

export type EngineFactory = (opts: EngineOptions) => Engine;

export class ConflictingEmission extends Error {
  override name = "ConflictingEmission";
}
