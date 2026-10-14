import { type Cell, CellEngine, type CellInput } from "@statewalker/webrun-cells";
import type { SqlDriver } from "@statewalker/webrun-files-sqlite";
import { INDEX_CELLS } from "./index-cells.js";
import { type ListRows, questionCells } from "./question-cells.js";
import type { PipelineEvent } from "./types.js";

export interface PipelineOptions {
  db: SqlDriver;
  /** Milliseconds each cell waits before handling an input; read per input. Default: () => 0. */
  delay?: () => number;
  onEvent?: (event: PipelineEvent) => void;
}

export interface Pipeline {
  engine: CellEngine;
  /** The unwrapped cell descriptors, for drawing the graph. */
  cells: readonly Cell[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reports each input's start, emissions and end, and waits `delay()` before handing it over. */
function observe(cell: Cell, onEvent: (e: PipelineEvent) => void, delay: () => number): Cell {
  return {
    id: cell.id,
    inputs: cell.inputs,
    outputs: cell.outputs,
    async *run(inputs) {
      let current: CellInput | undefined;
      const finish = () => {
        if (current)
          onEvent({ type: "done", cell: cell.id, signal: current.signal, key: current.key });
        current = undefined;
      };
      async function* tap(): AsyncGenerator<CellInput> {
        for await (const input of inputs) {
          finish();
          current = input;
          onEvent({ type: "start", cell: cell.id, signal: input.signal, key: input.key });
          const ms = delay();
          if (ms > 0) await sleep(ms);
          yield input;
        }
        finish();
      }
      try {
        for await (const e of cell.run(tap())) {
          onEvent({ type: "emit", cell: cell.id, signal: e.signal, key: e.key });
          yield e;
        }
        finish();
      } catch (error) {
        if (current) {
          onEvent({
            type: "fail",
            cell: cell.id,
            signal: current.signal,
            key: current.key,
            error: String(error),
          });
          current = undefined;
        }
        throw error;
      }
    },
  };
}

export function createPipeline(opts: PipelineOptions): Pipeline {
  const onEvent = opts.onEvent ?? (() => {});
  const delay = opts.delay ?? (() => 0);
  let engine: CellEngine | undefined;
  const list: ListRows = (signal) => (engine as CellEngine).list(signal);
  const cells = [...INDEX_CELLS, ...questionCells(list)];
  engine = new CellEngine({
    db: opts.db,
    cells: cells.map((c) => observe(c, onEvent, delay)),
  });
  return { engine, cells };
}
