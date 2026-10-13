import type { Json } from "./types.js";

/**
 * JSON text with object keys sorted at every depth, so equal values have equal
 * text. Throws TypeError on anything JSON cannot represent exactly, instead of
 * letting JSON.stringify turn it into `null` or drop it.
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
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) out[key] = normalize(record[key]);
      return out;
    }
  }
  throw new TypeError(`Not a JSON value: ${Object.prototype.toString.call(value)}`);
}
