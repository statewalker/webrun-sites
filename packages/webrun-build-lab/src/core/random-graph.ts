/**
 * Random builder graphs for massive tests: many collections, many builders of mixed
 * behaviour (transform, cut-off, filter, fan-out, multi-input join, dynamic
 * reads, reduce, group-by reduce), deterministic so every engine and the
 * oracle compute the same thing.
 *
 * Construction guarantees the contract's preconditions: the graph is a DAG
 * (builders only read collections created before their outputs), every derived collection
 * has exactly one producing builder, and output keys are unique per task, so no
 * two tasks ever emit the same row.
 */
import { rng } from "./fixtures.js";
import type { BuilderDef, Json } from "./types.js";

export interface GraphSpec {
  seed: number;
  /** Source collections. */
  sources: number;
  /** Builders to generate. */
  builders: number;
  /** Size of the source key universe (`k0…k{n-1}`). */
  keys: number;
}

export interface RandomGraph {
  builders: BuilderDef[];
  sources: string[];
  /** Every derived collection (for snapshots). */
  derived: string[];
  /** Generate a random source edit. */
  edit(rand: () => number):
    | { op: "put"; collection: string; key: string; value: Json }
    | {
        op: "remove";
        collection: string;
        key: string;
      };
  keyAt(i: number): string;
}

/** FNV-1a over a string, as an unsigned 32-bit number. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const h = (v: Json | undefined) => hash(JSON.stringify(v ?? null));

type Kind =
  | "transform"
  | "cutoff"
  | "filter"
  | "fanout"
  | "join"
  | "dynamic"
  | "reduce"
  | "groupby";
const KINDS: Kind[] = [
  "transform",
  "transform",
  "cutoff",
  "cutoff",
  "filter",
  "fanout",
  "join",
  "dynamic",
  "dynamic",
  "reduce",
  "groupby",
];

export function randomGraph(spec: GraphSpec): RandomGraph {
  const rand = rng(spec.seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const sources = Array.from({ length: spec.sources }, (_, i) => `src${i}`);
  // Collections readable by later builders; reduce outputs have few keys, so map builders
  // are keyed by "keyed" collections only (to keep task counts meaningful).
  const keyed: string[] = [...sources];
  const all: string[] = [...sources];
  const derived: string[] = [];
  const builders: BuilderDef[] = [];
  const keyAt = (i: number) => `k${i}`;

  for (let c = 0; c < spec.builders; c++) {
    const id = `c${c}`;
    const kind = pick(KINDS);
    const out = `s${c}`;
    // Prefer recent collections so the graph gets deep, not only wide.
    const recent = (xs: string[]) =>
      xs[Math.max(0, xs.length - 1 - Math.floor(rand() * Math.min(xs.length, 6)))] as string;
    const input = recent(keyed);
    const salt = c;
    let builder: BuilderDef;
    switch (kind) {
      case "transform":
        builder = {
          id,
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            ctx.emit(out, ctx.key, `${salt}:${h(await ctx.get(input, ctx.key)) % 100000}`);
          },
        };
        break;
      case "cutoff":
        // Tiny codomain: most upstream changes are cut off here.
        builder = {
          id,
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            ctx.emit(out, ctx.key, h(await ctx.get(input, ctx.key)) % 3);
          },
        };
        break;
      case "filter":
        builder = {
          id,
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            const v = await ctx.get(input, ctx.key);
            if (h(v) % 2 === 0) ctx.emit(out, ctx.key, v ?? null);
          },
        };
        break;
      case "fanout":
        builder = {
          id,
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            const v = await ctx.get(input, ctx.key);
            const n = h(v) % 4; // 0..3 rows: appear/disappear → retractions
            for (let i = 0; i < n; i++)
              ctx.emit(out, `${ctx.key}#${i}`, `${salt}.${i}.${h(v) % 1000}`);
          },
        };
        break;
      case "join": {
        const other = pick(keyed.filter((s) => s !== input));
        const inputs = other ? [input, other] : [input];
        builder = {
          id,
          inputs,
          outputs: [out],
          async run(ctx) {
            const parts: Json[] = [];
            for (const s of inputs) parts.push((await ctx.get(s, ctx.key)) ?? null);
            ctx.emit(out, ctx.key, h(parts) % 50000);
          },
        };
        break;
      }
      case "dynamic": {
        // Reads 1–3 rows of another collection, chosen by the value it read first.
        const target = pick(all);
        const reads = target === input ? [] : [target];
        builder = {
          id,
          inputs: [input],
          reads,
          outputs: [out],
          async run(ctx) {
            const v = await ctx.get(input, ctx.key);
            let acc = h(v);
            const n = 1 + (acc % 3);
            for (let i = 0; i < n; i++) {
              const key = keyAt((acc >>> (i * 5)) % spec.keys);
              acc = hash(`${acc}|${JSON.stringify((await ctx.get(target, key)) ?? null)}`);
            }
            ctx.emit(out, ctx.key, acc % 100000);
          },
        };
        break;
      }
      case "reduce":
        builder = {
          id,
          kind: "reduce",
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            const rows = await ctx.list(input);
            ctx.emit(out, "agg", { n: rows.length, h: h(rows) % 1000000 });
          },
        };
        break;
      case "groupby":
        builder = {
          id,
          kind: "reduce",
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            const buckets = new Map<number, number>();
            for (const r of await ctx.list(input)) {
              const b = h(r.value) % 5;
              buckets.set(b, (buckets.get(b) ?? 0) + 1);
            }
            for (const [b, n] of buckets) ctx.emit(out, `g${b}`, n);
          },
        };
        break;
    }
    builders.push(builder);
    derived.push(out);
    all.push(out);
    if (kind !== "reduce" && kind !== "groupby") keyed.push(out);
  }

  return {
    builders,
    sources,
    derived,
    keyAt,
    edit(r) {
      const collection = sources[Math.floor(r() * sources.length)] as string;
      const key = keyAt(Math.floor(r() * spec.keys));
      if (r() < 0.2) return { op: "remove", collection, key };
      return { op: "put", collection, key, value: `v${Math.floor(r() * 1000)}` };
    },
  };
}
