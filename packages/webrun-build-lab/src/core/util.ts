import { DataflowGraph } from "@statewalker/webrun-dataflow";
import type { CellDef, Json } from "./types.js";

/**
 * JSON text with object keys sorted at every depth, so equal values have equal
 * text. Throws on values JSON cannot represent exactly.
 */
export function canonicalJson(value: Json): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Not a JSON value: ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(record).sort()) out[key] = normalize(record[key]);
      return out;
    }
  }
  throw new TypeError(`Not a JSON value: ${Object.prototype.toString.call(value)}`);
}

/**
 * Key-tuple encoding for the ordered KV. Parts are joined with U+0001 (which
 * sorts below every printable character), so a prefix of parts is a prefix of
 * the key and tuples sort part by part. Parts must not contain U+0000/U+0001.
 * (Not U+0000: SQLite truncates TEXT at NUL.)
 */
export const SEP = "\u0001";

export function k(...parts: (string | number)[]): string {
  return parts.join(SEP);
}

/** Prefix that matches every key starting with the given parts. */
export function kp(...parts: (string | number)[]): string {
  return parts.join(SEP) + SEP;
}

export function split(key: string): string[] {
  return key.split(SEP);
}

/** Fixed-width, order-preserving encoding of a non-negative integer. */
export function seqKey(n: number): string {
  return n.toString(36).padStart(11, "0");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

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

  /** Cells whose map tasks are keyed by `signal`. */
  mappersOf(signal: string): string[] {
    return this.order.filter((id) => {
      const c = this.cells.get(id) as CellDef;
      return c.kind !== "reduce" && c.inputs.includes(signal);
    });
  }

  /** Every cell transitively upstream of `id` (excluding itself). */
  upstreamOf(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = this.cell(stack.pop() as string);
      for (const s of [...cur.inputs, ...(cur.reads ?? [])]) {
        for (const p of this.graph.getCellsProducing(s)) {
          if (!out.has(p)) {
            out.add(p);
            stack.push(p);
          }
        }
      }
    }
    return out;
  }
}
