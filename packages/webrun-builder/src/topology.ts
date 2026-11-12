import { DataflowGraph } from "@statewalker/webrun-dataflow";
import { assertName } from "./keys.js";
import type { CellDef } from "./types.js";

/**
 * The static signal-level topology of a cell set: `inputs` and `reads` both
 * count as dependencies for ordering and cycle detection. Validates the cell
 * set: unique ids, no cycles, no cell reading its own output, one producer per
 * output signal is NOT required (row ownership is enforced per row).
 */
export class Topology {
  readonly cells: Map<string, CellDef>;
  /** All cell ids, upstream first. */
  readonly order: string[];
  /** Position of each cell in `order`. */
  readonly rank: Map<string, number>;
  readonly graph: DataflowGraph;
  /** Signals produced by some cell. */
  readonly derived: Set<string>;

  constructor(cells: readonly CellDef[]) {
    for (const c of cells) {
      assertName("Cell id", c.id);
      for (const s of [...c.inputs, ...(c.reads ?? []), ...c.outputs]) assertName("Signal", s);
      const deps = [...c.inputs, ...(c.reads ?? [])];
      const own = c.outputs.find((s) => deps.includes(s));
      if (own !== undefined) throw new Error(`Cell "${c.id}" consumes its own output "${own}"`);
      if (c.kind !== "reduce" && c.inputs.length === 0) {
        throw new Error(`Map cell "${c.id}" needs at least one input`);
      }
    }
    this.graph = new DataflowGraph(
      cells.map((c) => ({
        id: c.id,
        inputs: [...new Set([...c.inputs, ...(c.reads ?? [])])],
        outputs: [...c.outputs],
      })),
    );
    this.order = this.graph.getExecutionOrderFromCells(this.graph.getAllCells());
    this.rank = new Map(this.order.map((id, i) => [id, i]));
    this.cells = new Map(cells.map((c) => [c.id, c]));
    this.derived = new Set(cells.flatMap((c) => c.outputs));
  }

  cell(id: string): CellDef {
    const c = this.cells.get(id);
    if (!c) throw new Error(`Unknown cell "${id}"`);
    return c;
  }

  assertSource(signal: string): void {
    if (this.derived.has(signal)) {
      throw new Error(`"${signal}" is not a source signal: it is produced by a cell`);
    }
  }

  /** Cells that may read `signal` (as input or extra read). */
  readersOf(signal: string): string[] {
    return [...this.graph.getCellsConsuming(signal)];
  }
}
