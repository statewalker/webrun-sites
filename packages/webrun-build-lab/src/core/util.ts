import type { Json } from "./types.js";

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
 * The static signal-level topology (order, ranks, readers, validation) — the
 * same one the real engine uses, so prototypes schedule identically.
 */
import { Topology as EngineTopology } from "@statewalker/webrun-builder";
import type { CellDef } from "./types.js";

/** The engine's topology, typed with the lab's cell contract (no incremental reduce). */
export class Topology extends EngineTopology {
  constructor(cells: readonly CellDef[]) {
    super(cells as unknown as ConstructorParameters<typeof EngineTopology>[0]);
  }

  override cell(id: string): CellDef {
    return super.cell(id) as unknown as CellDef;
  }
}
