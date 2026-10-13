import type { SqlDriver } from "@statewalker/webrun-files-sqlite";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One claimed input: the current row of `signal`/`key` at claim time. */
export interface CellInput {
  signal: string;
  key: string;
  value: Json;
}

/** A row a cell produces, attributed to the input it last pulled. */
export interface Emission {
  signal: string;
  key: string;
  value: Json;
}

export interface Cell {
  id: string;
  inputs: readonly string[];
  outputs: readonly string[];
  /**
   * Iterate `inputs` and yield emissions. Pulling the next input commits the
   * previous one; returning commits the current one; throwing fails it.
   */
  run(inputs: AsyncIterable<CellInput>): AsyncIterable<Emission>;
}

export interface CellEngineOptions {
  db: SqlDriver;
  cells: readonly Cell[];
  /** Lease holder id; defaults to a random UUID. */
  owner?: string;
  leaseMs?: number;
  maxAttempts?: number;
  batchSize?: number;
  now?: () => number;
}

export interface RunResult {
  /** Inputs committed, including retractions of removed inputs. */
  committed: number;
  /** Failed attempts, including those that ended in the dead letter. */
  failed: number;
  deadLettered: number;
}

export interface DeadLetter {
  cell: string;
  signal: string;
  key: string;
  attempts: number;
  error: string;
}
