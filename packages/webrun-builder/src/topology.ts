import { assertName } from "./keys.js";
import type { BuilderDef } from "./types.js";

/**
 * The static collection-level topology of a builder set. A builder depends on every builder
 * producing a collection it declares in `inputs` or `reads`. Validates the set
 * (unique ids, reserved characters, no self-consumption, map builders have inputs,
 * no cycles) and computes a deterministic topological order — upstream first,
 * declaration order breaking ties — whose positions are the queue ranks.
 *
 * Several builders may output the same collection; row ownership is enforced per row.
 */
export class Topology {
  readonly builders: Map<string, BuilderDef>;
  /** All builder ids, upstream first. */
  readonly order: string[];
  /** Position of each builder in `order` (the queue rank). */
  readonly rank: Map<string, number>;
  /** Collections produced by some builder. */
  readonly derived: Set<string>;
  readonly #readers = new Map<string, string[]>();

  constructor(builders: readonly BuilderDef[]) {
    this.builders = new Map();
    const producers = new Map<string, string[]>();
    for (const c of builders) {
      assertName("Builder id", c.id);
      for (const s of [...c.inputs, ...(c.reads ?? []), ...c.outputs]) assertName("Collection", s);
      if (this.builders.has(c.id)) throw new Error(`Duplicate builder id: ${c.id}`);
      const deps = depsOf(c);
      const own = c.outputs.find((s) => deps.includes(s));
      if (own !== undefined) throw new Error(`Builder "${c.id}" consumes its own output "${own}"`);
      if (c.kind !== "reduce" && c.inputs.length === 0) {
        throw new Error(`Map builder "${c.id}" needs at least one input`);
      }
      this.builders.set(c.id, c);
      for (const s of deps) push(this.#readers, s, c.id);
      for (const s of c.outputs) push(producers, s, c.id);
    }
    this.derived = new Set(producers.keys());

    // Kahn's algorithm; the ready set is kept in declaration order.
    const upstream = new Map<string, Set<string>>();
    const downstream = new Map<string, Set<string>>();
    for (const c of builders) {
      const ups = new Set<string>();
      for (const s of depsOf(c)) for (const p of producers.get(s) ?? []) ups.add(p);
      upstream.set(c.id, ups);
      for (const p of ups) {
        let set = downstream.get(p);
        if (!set) {
          set = new Set();
          downstream.set(p, set);
        }
        set.add(c.id);
      }
    }
    const declared = new Map(builders.map((c, i) => [c.id, i]));
    const pending = new Map([...upstream].map(([id, ups]) => [id, ups.size]));
    const ready = builders.filter((c) => pending.get(c.id) === 0).map((c) => c.id);
    const order: string[] = [];
    while (ready.length > 0) {
      const id = ready.shift() as string;
      order.push(id);
      for (const d of downstream.get(id) ?? []) {
        const left = (pending.get(d) as number) - 1;
        pending.set(d, left);
        if (left === 0) insertSorted(ready, d, declared);
      }
    }
    if (order.length < builders.length) {
      const stuck = new Set(builders.map((c) => c.id).filter((id) => !order.includes(id)));
      // Only builders on a cycle reach themselves; the rest are merely downstream of one.
      const onCycle = [...stuck].filter((id) => reachesSelf(id, stuck, upstream));
      throw new Error(`Cycle detected among builders: ${onCycle.join(", ")}`);
    }
    this.order = order;
    this.rank = new Map(order.map((id, i) => [id, i]));
  }

  builder(id: string): BuilderDef {
    const c = this.builders.get(id);
    if (!c) throw new Error(`Unknown builder "${id}"`);
    return c;
  }

  assertSource(collection: string): void {
    if (this.derived.has(collection)) {
      throw new Error(`"${collection}" is not a source collection: it is produced by a builder`);
    }
  }

  /** Builders that may read `collection` (as input or extra read). */
  readersOf(collection: string): string[] {
    return this.#readers.get(collection) ?? [];
  }
}

function depsOf(c: BuilderDef): string[] {
  return [...new Set([...c.inputs, ...(c.reads ?? [])])];
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

function insertSorted(ready: string[], id: string, declared: Map<string, number>): void {
  const at = declared.get(id) as number;
  let i = ready.length;
  while (i > 0 && (declared.get(ready[i - 1] as string) as number) > at) i--;
  ready.splice(i, 0, id);
}

function reachesSelf(
  start: string,
  scope: Set<string>,
  upstream: Map<string, Set<string>>,
): boolean {
  const seen = new Set<string>();
  const stack = [...(upstream.get(start) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === start) return true;
    if (seen.has(cur) || !scope.has(cur)) continue;
    seen.add(cur);
    stack.push(...(upstream.get(cur) ?? []));
  }
  return false;
}
