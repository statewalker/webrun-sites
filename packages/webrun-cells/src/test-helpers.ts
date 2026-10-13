import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import type { Cell, CellInput, Emission } from "./types.js";

export function memDb(): NodeSqlDriver {
  return new NodeSqlDriver(new DatabaseSync(":memory:"));
}

export interface RecordingCell extends Cell {
  /** `signal/key` of every input the cell was handed, in order. */
  readonly seen: string[];
}

/** A cell that maps each input through `fn`. */
export function mapCell(
  id: string,
  inputs: string[],
  outputs: string[],
  fn: (input: CellInput) => Emission[],
): RecordingCell {
  const seen: string[] = [];
  return {
    id,
    inputs,
    outputs,
    seen,
    async *run(batch) {
      for await (const input of batch) {
        seen.push(`${input.signal}/${input.key}`);
        yield* fn(input);
      }
    },
  };
}
