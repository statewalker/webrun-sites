# @statewalker/webrun-cells Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new package `packages/webrun-cells` in this repository: a delta-driven derivation engine whose rows, work queue, provenance and dead letters live in SQLite tables.

**Architecture:** `CellEngine` takes a `SqlDriver` (from `@statewalker/webrun-files-sqlite`) and a list of cells declared as `{ id, inputs, outputs, run }`. `DataflowGraph` (from `@statewalker/webrun-dataflow`) supplies consumers, topological order and cycle detection. A cell's `run` is an async generator over an engine-owned iterator of claimed inputs. Pulling the next input commits the previous input's emissions, provenance and dequeue in one `transaction(statements)`. Values are canonical JSON text, compared exactly. Leases on queue rows make crash replay and several engines on one database safe.

**Tech Stack:** TypeScript 7, `node:sqlite` (Node 24, no experimental warning), vitest 5, tsdown, pnpm workspace catalogs, changesets.

**Spec:** `~/workspace-statewalker/notes/2026/2026-10/2026-10-13/grill-module-webrun-cells.md` (grill-module note). Read it before starting. Where it and `webrun-cells-implementation-guide.md` (same folder) disagree, the grill note wins.

## Global Constraints

- Package name `@statewalker/webrun-cells`, directory `packages/webrun-cells`, version `0.0.0` (a changeset bumps it).
- All file names kebab-case.
- SQL port: `SqlDriver` from `@statewalker/webrun-files-sqlite` (`^0.10.3`). No statement in a `transaction(statements)` may depend on reading another's result. Reads happen before the transaction; conditions that must hold at commit time go in SQL (`WHERE NOT EXISTS …`).
- Topology: `DataflowGraph` from `@statewalker/webrun-dataflow` (`workspace:^`). It throws `Duplicate cell id: …` and `Cycle detected among cells: …`. It deliberately does not treat self-loops as cycles, so `CellEngine` checks those itself.
- Tables share the prefix `cells_`: `cells_rows`, `cells_pending`, `cells_provenance`, `cells_dead_letter`, `cells_meta`.
- Values are `Json`, stored as canonical JSON (object keys sorted at every depth). Anything JSON cannot represent exactly (`undefined`, `NaN`, `±Infinity`, `Date`, class instances, nested `undefined`) is a `TypeError`.
- Defaults: `leaseMs = 30_000`, `maxAttempts = 3`, `batchSize = 32`, `now = Date.now`, `owner = crypto.randomUUID()`.
- Retries are immediate (same `run()`); no backoff.
- Tests go through `CellEngine` only, on a real `node:sqlite` `DatabaseSync` behind `NodeSqlDriver`. No mocks of the engine or the driver.
- `webrun-builder` and `webrun-dataflow` are not modified.
- Commits use conventional messages scoped `(webrun-cells)` and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Two `run()` calls on the same engine at once: each input should be committed exactly once. Test in Task 4.
2. A dead-lettered input whose source later changes should get a fresh try, and the dead letter should be cleared on success. Test in Task 3.
3. Non-JSON values (`undefined`, `NaN`, `Infinity`, `Date`, `{ a: undefined }`) should be rejected with `TypeError`, not silently stored as `null`. Test in Task 1.
4. `null` is a real value, not a deletion: a cell should run with `value: null`. Test in Task 2.
5. A cell that consumes its own output (`inputs: ["x"], outputs: ["x"]`) should be rejected at construction, because `DataflowGraph` does not flag it. Test in Task 1.

## Refinement of one spec test goal

The spec says: "A cell returning early leaves the unpulled inputs queued; the next `run()` processes them." The implementation refines this. Unpulled inputs are released to the queue. If the batch pulled at least one input, `run()` keeps claiming that cell and processes the released inputs in the same run. If the cell returned without pulling any input, `run()` stops claiming that cell until the next `run()`, so a cell that never pulls cannot spin forever. Task 3 tests both halves.

## File Structure

```
packages/webrun-cells/
  package.json            scaffold (copied shape from webrun-builder)
  tsconfig.json           same compiler options as webrun-builder
  vitest.config.ts        same as webrun-builder
  README.md               package-shape README (Task 5)
  src/
    index.ts              public exports
    types.ts              Json, Cell, CellInput, Emission, CellEngineOptions, RunResult, DeadLetter
    canonical-json.ts     canonicalJson(): sorted-key JSON text, TypeError on non-JSON
    schema.ts             SCHEMA: SqlStatement[] (CREATE TABLE IF NOT EXISTS …, seq counter)
    engine.ts             CellEngine, ConflictingEmission
    test-helpers.ts       memDb(), mapCell()  (tests only; not exported from index.ts)
    sources.test.ts       Task 1
    graph.test.ts         Task 1
    cascade.test.ts       Task 2
    retraction.test.ts    Task 2
    failures.test.ts      Task 3
    leases.test.ts        Task 4
    persistence.test.ts   Task 4
pnpm-workspace.yaml       + catalog entry for @statewalker/webrun-files-sqlite
tools/consumer-install/consumer-install.test.ts   + PACKAGES entry (Task 5)
.changeset/webrun-cells.md                        (Task 5)
```

---

### Task 1: Scaffold, schema, graph validation, source rows

**Files:**
- Create: `packages/webrun-cells/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/webrun-cells/src/{index,types,canonical-json,schema,engine,test-helpers}.ts`
- Modify: `pnpm-workspace.yaml` (catalog)
- Test: `packages/webrun-cells/src/sources.test.ts`, `packages/webrun-cells/src/graph.test.ts`

**Interfaces:**
- Produces: `CellEngine` with `constructor(opts: CellEngineOptions)`, `put(signal, key, value: Json): Promise<void>`, `remove(signal, key): Promise<void>`, `get(signal, key): Promise<Json | undefined>`, `list(signal): Promise<{ key: string; value: Json }[]>`; private helpers `#init()`, `#value(signal, key): Promise<string | undefined>`, `#enqueue(signal, key, onlyIfAbsent?): SqlStatement[]`, `#pendingInsert(cell, signal, key, onlyIfAbsent?): SqlStatement`. Plus internal `canonicalJson(value): string` (not exported from `index.ts`), `SCHEMA`, and test helpers `memDb(): NodeSqlDriver` and `mapCell(id, inputs, outputs, fn): RecordingCell`.

- [ ] **Step 1: Scaffold the package**

Add to the `catalog:` block of `pnpm-workspace.yaml`, next to the other `@statewalker/webrun-files*` lines:

```yaml
  "@statewalker/webrun-files-sqlite": "^0.10.3"
```

`packages/webrun-cells/package.json`:

```json
{
  "name": "@statewalker/webrun-cells",
  "version": "0.0.0",
  "private": false,
  "type": "module",
  "description": "SQLite-backed incremental cell engine: signal rows, a work queue, provenance and dead letters in SQL tables; early cut-off on unchanged outputs and provenance-based retraction.",
  "bugs": {
    "url": "https://github.com/statewalker/webrun-sites/issues"
  },
  "homepage": "https://github.com/statewalker/webrun-sites/tree/main/packages/webrun-cells#readme",
  "author": {
    "name": "Mikhail Kotelnikov",
    "email": "mikhail.kotelnikov@gmail.com"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/statewalker/webrun-sites.git",
    "directory": "packages/webrun-cells"
  },
  "exports": {
    ".": {
      "source": "./src/index.ts",
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsdown",
    "prepack": "pnpm run build",
    "dev": "tsdown --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "clean": "rimraf dist",
    "lint": "biome check --write .",
    "format": "biome format --write ."
  },
  "dependencies": {
    "@statewalker/webrun-dataflow": "workspace:^",
    "@statewalker/webrun-files-sqlite": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "rimraf": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "sideEffects": false,
  "publishConfig": {
    "access": "public"
  }
}
```

Copy `packages/webrun-builder/tsconfig.json` and `packages/webrun-builder/vitest.config.ts` unchanged into `packages/webrun-cells/`.

Run: `pnpm install` (from the repo root). Expected: lockfile updated, `@statewalker/webrun-files-sqlite@0.10.3` resolved.

- [ ] **Step 2: Write types, canonical JSON, schema and test helpers**

`src/types.ts`:

```ts
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
```

`src/canonical-json.ts`:

```ts
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
```

`src/schema.ts`:

```ts
import type { SqlStatement } from "@statewalker/webrun-files-sqlite";

/** Idempotent: safe to run on every open. */
export const SCHEMA: SqlStatement[] = [
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_rows (
      signal TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY (signal, key)) WITHOUT ROWID`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_pending (
      cell TEXT NOT NULL, signal TEXT NOT NULL, key TEXT NOT NULL,
      seq INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT, lease_until INTEGER,
      PRIMARY KEY (cell, signal, key)) WITHOUT ROWID`,
  },
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_provenance (
      cell TEXT NOT NULL, in_signal TEXT NOT NULL, in_key TEXT NOT NULL,
      out_signal TEXT NOT NULL, out_key TEXT NOT NULL,
      PRIMARY KEY (cell, in_signal, in_key, out_signal, out_key)) WITHOUT ROWID`,
  },
  { sql: "CREATE INDEX IF NOT EXISTS cells_provenance_out ON cells_provenance (out_signal, out_key)" },
  {
    sql: `CREATE TABLE IF NOT EXISTS cells_dead_letter (
      cell TEXT NOT NULL, signal TEXT NOT NULL, key TEXT NOT NULL,
      attempts INTEGER NOT NULL, error TEXT NOT NULL,
      PRIMARY KEY (cell, signal, key)) WITHOUT ROWID`,
  },
  { sql: "CREATE TABLE IF NOT EXISTS cells_meta (name TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID" },
  { sql: "INSERT OR IGNORE INTO cells_meta (name, value) VALUES ('seq', 0)" },
];
```

`src/test-helpers.ts`:

```ts
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
```

- [ ] **Step 3: Write the failing tests**

`src/sources.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";

const upper = () =>
  mapCell("upper", ["docs"], ["upper"], (i) => [
    { signal: "upper", key: i.key, value: String(i.value).toUpperCase() },
  ]);

describe("source rows", () => {
  it("stores, reads and lists rows in key order", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [] });
    await engine.put("docs", "b", { n: 2 });
    await engine.put("docs", "a", "x");
    expect(await engine.get("docs", "a")).toBe("x");
    expect(await engine.get("docs", "missing")).toBeUndefined();
    expect(await engine.list("docs")).toEqual([
      { key: "a", value: "x" },
      { key: "b", value: { n: 2 } },
    ]);
  });

  it("removes a row; removing a missing row is a no-op", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [] });
    await engine.put("docs", "a", 1);
    await engine.remove("docs", "a");
    await engine.remove("docs", "a");
    expect(await engine.list("docs")).toEqual([]);
  });

  it("rejects writes to a derived signal", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [upper()] });
    await expect(engine.put("upper", "k", "v")).rejects.toThrow(/not a source signal/);
    await expect(engine.remove("upper", "k")).rejects.toThrow(/not a source signal/);
  });

  it("rejects values JSON cannot represent exactly", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [] });
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(0), { a: undefined }]) {
      await expect(engine.put("docs", "k", bad as never)).rejects.toThrow(TypeError);
    }
    expect(await engine.list("docs")).toEqual([]);
  });
});
```

`src/graph.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";

const cell = (id: string, inputs: string[], outputs: string[]) => mapCell(id, inputs, outputs, () => []);

describe("graph validation", () => {
  it("rejects a cycle between cells", () => {
    expect(
      () => new CellEngine({ db: memDb(), cells: [cell("a", ["x"], ["y"]), cell("b", ["y"], ["x"])] }),
    ).toThrow(/Cycle detected/);
  });

  it("rejects a cell that consumes its own output", () => {
    expect(() => new CellEngine({ db: memDb(), cells: [cell("a", ["x"], ["x"])] })).toThrow(
      /consumes its own output/,
    );
  });

  it("rejects duplicate cell ids", () => {
    expect(
      () => new CellEngine({ db: memDb(), cells: [cell("a", ["x"], ["y"]), cell("a", ["x"], ["z"])] }),
    ).toThrow(/Duplicate cell id/);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: FAIL. `./engine.js` cannot be resolved.

- [ ] **Step 5: Write the engine skeleton**

`src/engine.ts`:

```ts
import { DataflowGraph } from "@statewalker/webrun-dataflow";
import type { SqlDriver, SqlStatement } from "@statewalker/webrun-files-sqlite";
import { canonicalJson } from "./canonical-json.js";
import { SCHEMA } from "./schema.js";
import type { Cell, CellEngineOptions, Json } from "./types.js";

/** One seq bump per transaction: every pending row it writes gets the new value. */
const BUMP: SqlStatement = { sql: "UPDATE cells_meta SET value = value + 1 WHERE name = 'seq'" };

export class CellEngine {
  readonly #db: SqlDriver;
  readonly #cells: Map<string, Cell>;
  readonly #graph: DataflowGraph;
  /** All cells, upstream first. */
  readonly #order: string[];
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #batchSize: number;
  readonly #now: () => number;
  #ready?: Promise<void>;

  constructor(opts: CellEngineOptions) {
    for (const cell of opts.cells) {
      const own = cell.outputs.find((signal) => cell.inputs.includes(signal));
      if (own !== undefined) throw new Error(`Cell "${cell.id}" consumes its own output "${own}"`);
    }
    this.#graph = new DataflowGraph(
      opts.cells.map((c) => ({ id: c.id, inputs: [...c.inputs], outputs: [...c.outputs] })),
    );
    this.#order = this.#graph.getExecutionOrderFromCells(this.#graph.getAllCells());
    this.#cells = new Map(opts.cells.map((c) => [c.id, c]));
    this.#db = opts.db;
    this.#owner = opts.owner ?? crypto.randomUUID();
    this.#leaseMs = opts.leaseMs ?? 30_000;
    this.#maxAttempts = opts.maxAttempts ?? 3;
    this.#batchSize = opts.batchSize ?? 32;
    this.#now = opts.now ?? Date.now;
  }

  async put(signal: string, key: string, value: Json): Promise<void> {
    this.#assertSource(signal);
    const json = canonicalJson(value);
    await this.#init();
    if ((await this.#value(signal, key)) === json) return;
    await this.#db.transaction([
      {
        sql: "INSERT INTO cells_rows (signal, key, value) VALUES (?, ?, ?) ON CONFLICT (signal, key) DO UPDATE SET value = excluded.value",
        params: [signal, key, json],
      },
      ...this.#enqueue(signal, key),
    ]);
  }

  async remove(signal: string, key: string): Promise<void> {
    this.#assertSource(signal);
    await this.#init();
    if ((await this.#value(signal, key)) === undefined) return;
    await this.#db.transaction([
      { sql: "DELETE FROM cells_rows WHERE signal = ? AND key = ?", params: [signal, key] },
      ...this.#enqueue(signal, key),
    ]);
  }

  async get(signal: string, key: string): Promise<Json | undefined> {
    await this.#init();
    const value = await this.#value(signal, key);
    return value === undefined ? undefined : (JSON.parse(value) as Json);
  }

  async list(signal: string): Promise<{ key: string; value: Json }[]> {
    await this.#init();
    const rows = await this.#db.all<{ key: string; value: string }>(
      "SELECT key, value FROM cells_rows WHERE signal = ? ORDER BY key",
      signal,
    );
    return rows.map(({ key, value }) => ({ key, value: JSON.parse(value) as Json }));
  }

  #assertSource(signal: string): void {
    if (this.#graph.getCellsProducing(signal).size > 0) {
      throw new Error(`"${signal}" is not a source signal: it is produced by a cell`);
    }
  }

  #init(): Promise<void> {
    this.#ready ??= Promise.resolve(this.#db.transaction(SCHEMA)).then(() => undefined);
    return this.#ready;
  }

  async #value(signal: string, key: string): Promise<string | undefined> {
    const [row] = await this.#db.all<{ value: string }>(
      "SELECT value FROM cells_rows WHERE signal = ? AND key = ?",
      signal,
      key,
    );
    return row?.value;
  }

  /** Queue every consumer of `signal` for `key`. */
  #enqueue(signal: string, key: string, onlyIfAbsent = false): SqlStatement[] {
    const consumers = [...this.#graph.getCellsConsuming(signal)];
    if (consumers.length === 0) return [];
    return [BUMP, ...consumers.map((cell) => this.#pendingInsert(cell, signal, key, onlyIfAbsent))];
  }

  /**
   * Upsert a queue row with the current seq. A newer change replaces the seq,
   * so a commit that deletes "its" seq leaves the newer change queued.
   * `onlyIfAbsent`: enqueue only if the row no longer exists at commit time.
   */
  #pendingInsert(cell: string, signal: string, key: string, onlyIfAbsent = false): SqlStatement {
    const guard = onlyIfAbsent ? " AND NOT EXISTS (SELECT 1 FROM cells_rows WHERE signal = ? AND key = ?)" : "";
    return {
      sql: `INSERT INTO cells_pending (cell, signal, key, seq) SELECT ?, ?, ?, value FROM cells_meta WHERE name = 'seq'${guard} ON CONFLICT (cell, signal, key) DO UPDATE SET seq = excluded.seq, attempts = 0`,
      params: onlyIfAbsent ? [cell, signal, key, signal, key] : [cell, signal, key],
    };
  }
}
```

(The fields `#cells`, `#order`, `#owner`, `#leaseMs`, `#maxAttempts`, `#batchSize` and `#now` are used from Task 2 on. If `tsc` reports them unused under `noUnusedLocals` in this task, that is expected; it does not affect `vitest`. Do not add workarounds; Task 2 uses them.)

`src/index.ts`:

```ts
export { CellEngine } from "./engine.js";
export type { Cell, CellEngineOptions, CellInput, DeadLetter, Emission, Json, RunResult } from "./types.js";
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: PASS, 7 tests.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml packages/webrun-cells
git commit -m "feat(webrun-cells): package scaffold, schema, graph checks and source rows"
```

---

### Task 2: The run loop: claim, pull-next commit, cut-off, retraction

**Files:**
- Modify: `packages/webrun-cells/src/engine.ts`
- Modify: `packages/webrun-cells/src/index.ts` (export `ConflictingEmission`)
- Test: `packages/webrun-cells/src/cascade.test.ts`, `packages/webrun-cells/src/retraction.test.ts`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `CellEngine.run(): Promise<RunResult>`; `export class ConflictingEmission extends Error`; private `#claim(cell): Promise<Claimed[]>`, `#runBatch(cell, batch, result): Promise<boolean>`, `#commit(cell, claim, emitted): Promise<void>`, `#fail(cell, claim, error, result): Promise<void>`, `#release(cell, claims): Promise<void>`. `type Claimed = { signal: string; key: string; seq: number; attempts: number }`. Task 3 calls `#fail` semantics through `run()` and adds `deadLetters()` and `requeue()`.

- [ ] **Step 1: Write the failing tests**

`src/cascade.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const split = () =>
  mapCell("split", ["docs"], ["chunks"], (i) =>
    String(i.value)
      .split(" ")
      .map((word, n) => ({ signal: "chunks", key: `${i.key}#${n}`, value: word })),
  );
const upper = () =>
  mapCell("upper", ["chunks"], ["upper"], (i) => [
    { signal: "upper", key: i.key, value: String(i.value).toUpperCase() },
  ]);

describe("cascade", () => {
  it("converges a chain in one run, whatever order the cells are given in", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [upper(), split()] });
    await engine.put("docs", "a", "hello world");
    expect(await engine.run()).toEqual({ committed: 3, failed: 0, deadLettered: 0 });
    expect(await engine.list("upper")).toEqual([
      { key: "a#0", value: "HELLO" },
      { key: "a#1", value: "WORLD" },
    ]);
    expect(await engine.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
  });

  it("queues consumers once for an unchanged value and stops at unchanged outputs", async () => {
    const s = split();
    const u = upper();
    const engine = new CellEngine({ db: memDb(), cells: [s, u] });
    await engine.put("docs", "a", "x y");
    await engine.run();
    await engine.put("docs", "a", "x y");
    await engine.run();
    expect(s.seen).toEqual(["docs/a"]);

    await engine.put("docs", "a", "x z");
    await engine.run();
    expect(s.seen).toEqual(["docs/a", "docs/a"]);
    // a#0 is still "x": early cut-off, upper does not see it again
    expect(u.seen).toEqual(["chunks/a#0", "chunks/a#1", "chunks/a#1"]);
    expect(await engine.get("upper", "a#1")).toBe("Z");
  });

  it("does not count object key order as a change", async () => {
    const c = mapCell("c", ["docs"], ["out"], () => []);
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", { a: 1, b: 2 });
    await engine.run();
    await engine.put("docs", "a", { b: 2, a: 1 });
    await engine.run();
    expect(c.seen).toEqual(["docs/a"]);
  });

  it("treats null as a value, not a deletion", async () => {
    const c = mapCell("c", ["docs"], ["out"], (i) => [{ signal: "out", key: i.key, value: i.value }]);
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", null);
    await engine.run();
    expect(c.seen).toEqual(["docs/a"]);
    expect(await engine.list("out")).toEqual([{ key: "a", value: null }]);
  });

  it("runs both producers of a diamond before the shared consumer", async () => {
    const log: string[] = [];
    const left = mapCell("left", ["docs"], ["l"], (i) => {
      log.push("left");
      return [{ signal: "l", key: i.key, value: 1 }];
    });
    const right = mapCell("right", ["docs"], ["r"], (i) => {
      log.push("right");
      return [{ signal: "r", key: i.key, value: 2 }];
    });
    const join = mapCell("join", ["l", "r"], ["j"], (i) => {
      log.push(`join:${i.signal}`);
      return [{ signal: "j", key: `${i.signal}:${i.key}`, value: i.value }];
    });
    const engine = new CellEngine({ db: memDb(), cells: [join, right, left] });
    await engine.put("docs", "a", "x");
    await engine.run();
    expect(log.slice(0, 2).sort()).toEqual(["left", "right"]);
    expect(log.slice(2).sort()).toEqual(["join:l", "join:r"]);
  });

  it("keeps a change that arrives while its cell runs queued", async () => {
    const values: unknown[] = [];
    let engine: CellEngine;
    const copy: Cell = {
      id: "copy",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const input of inputs) {
          values.push(input.value);
          if (values.length === 1) await engine.put("docs", "a", "v2");
          yield { signal: "out", key: input.key, value: input.value };
        }
      },
    };
    engine = new CellEngine({ db: memDb(), cells: [copy] });
    await engine.put("docs", "a", "v1");
    expect(await engine.run()).toEqual({ committed: 2, failed: 0, deadLettered: 0 });
    expect(values).toEqual(["v1", "v2"]);
    expect(await engine.get("out", "a")).toBe("v2");
  });
});
```

`src/retraction.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";

const split = () =>
  mapCell("split", ["docs"], ["chunks"], (i) =>
    String(i.value)
      .split(" ")
      .map((word, n) => ({ signal: "chunks", key: `${i.key}#${n}`, value: word })),
  );
const upper = () =>
  mapCell("upper", ["chunks"], ["upper"], (i) => [
    { signal: "upper", key: i.key, value: String(i.value).toUpperCase() },
  ]);

describe("retraction", () => {
  it("deletes outputs a re-run no longer emits, and cascades without invoking cells", async () => {
    const u = upper();
    const engine = new CellEngine({ db: memDb(), cells: [split(), u] });
    await engine.put("docs", "a", "x y z");
    await engine.run();
    await engine.put("docs", "a", "x y");
    await engine.run();
    expect((await engine.list("chunks")).map((r) => r.key)).toEqual(["a#0", "a#1"]);
    expect((await engine.list("upper")).map((r) => r.key)).toEqual(["a#0", "a#1"]);
    expect(u.seen).toEqual(["chunks/a#0", "chunks/a#1", "chunks/a#2"]);
  });

  it("retracts everything derived from a removed source", async () => {
    const s = split();
    const engine = new CellEngine({ db: memDb(), cells: [s, upper()] });
    await engine.put("docs", "a", "x y");
    await engine.put("docs", "b", "w");
    await engine.run();
    await engine.remove("docs", "a");
    await engine.run();
    expect(await engine.list("chunks")).toEqual([{ key: "b#0", value: "w" }]);
    expect(await engine.list("upper")).toEqual([{ key: "b#0", value: "W" }]);
    expect(s.seen).toEqual(["docs/a", "docs/b"]);
  });

  it("keeps an output another input still produces", async () => {
    const words = mapCell("words", ["docs"], ["words"], (i) =>
      String(i.value)
        .split(" ")
        .map((w) => ({ signal: "words", key: w, value: w })),
    );
    const engine = new CellEngine({ db: memDb(), cells: [words] });
    await engine.put("docs", "a", "x y");
    await engine.put("docs", "b", "y z");
    await engine.run();
    expect((await engine.list("words")).map((r) => r.key)).toEqual(["x", "y", "z"]);
    await engine.remove("docs", "a");
    await engine.run();
    expect((await engine.list("words")).map((r) => r.key)).toEqual(["y", "z"]);
    await engine.remove("docs", "b");
    await engine.run();
    expect(await engine.list("words")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: FAIL with `engine.run is not a function`.

- [ ] **Step 3: Implement the run loop**

In `src/engine.ts`, extend the type import to `import type { Cell, CellEngineOptions, CellInput, Emission, Json, RunResult } from "./types.js";` and add, after `BUMP`:

```ts
export class ConflictingEmission extends Error {
  override name = "ConflictingEmission";
}

type Claimed = { signal: string; key: string; seq: number; attempts: number };
type Live = { claim: Claimed; input: CellInput };
type Row = { signal: string; key: string; json: string };

const rowId = (signal: string, key: string) => JSON.stringify([signal, key]);

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
```

Add these methods to `CellEngine`, after `list`:

```ts
  /**
   * Claim → run → commit until no claimable work is left. Restarts from the
   * most upstream cell after every batch, so a consumer only runs once its
   * producers have drained.
   */
  async run(): Promise<RunResult> {
    await this.#init();
    const result: RunResult = { committed: 0, failed: 0, deadLettered: 0 };
    // Cells whose last batch pulled nothing: not claimed again in this run.
    const stalled = new Set<string>();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of this.#order) {
        if (stalled.has(id)) continue;
        const batch = await this.#claim(id);
        if (batch.length === 0) continue;
        if (!(await this.#runBatch(this.#cells.get(id) as Cell, batch, result))) stalled.add(id);
        progressed = true;
        break;
      }
    }
    return result;
  }

  async #claim(cell: string): Promise<Claimed[]> {
    const now = this.#now();
    const rows = await this.#db.all<Claimed>(
      "SELECT signal, key, seq, attempts FROM cells_pending WHERE cell = ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY seq, signal, key LIMIT ?",
      cell,
      now,
      this.#batchSize,
    );
    if (rows.length === 0) return [];
    // The lease condition is repeated so a concurrent claimer that selected the
    // same rows gets a zero count and drops them.
    const counts = await this.#db.transaction(
      rows.map((r) => ({
        sql: "UPDATE cells_pending SET lease_owner = ?, lease_until = ? WHERE cell = ? AND signal = ? AND key = ? AND seq = ? AND (lease_until IS NULL OR lease_until <= ?)",
        params: [this.#owner, now + this.#leaseMs, cell, r.signal, r.key, r.seq, now],
      })),
    );
    return rows.filter((_, i) => counts[i] === 1);
  }

  /** Returns false when the batch made no progress at all (cell pulled nothing). */
  async #runBatch(cell: Cell, batch: Claimed[], result: RunResult): Promise<boolean> {
    const live: Live[] = [];
    for (const claim of batch) {
      const value = await this.#value(claim.signal, claim.key);
      if (value === undefined) {
        // The input row is gone: retract what it produced, without the cell.
        await this.#commit(cell, claim, new Map());
        result.committed++;
      } else {
        live.push({ claim, input: { signal: claim.signal, key: claim.key, value: JSON.parse(value) as Json } });
      }
    }
    const retracted = live.length < batch.length;
    if (live.length === 0) return retracted;

    let current = -1; // index in `live` of the input last pulled
    let committedUpTo = -1; // inputs live[0..committedUpTo] are committed
    let emitted = new Map<string, Row>();
    let fatal: unknown; // a database error during a commit
    let failure: unknown; // the current input's failure

    const commitCurrent = async (): Promise<boolean> => {
      if (current <= committedUpTo) return true;
      try {
        await this.#commit(cell, (live[current] as Live).claim, emitted);
        committedUpTo = current;
        result.committed++;
        return true;
      } catch (error) {
        fatal = error;
        return false;
      }
    };

    // Created once, so a cell that asks for the iterator twice cannot replay inputs.
    const iterator = (async function* () {
      for (const [i, item] of live.entries()) {
        if (current >= 0 && !(await commitCurrent())) return;
        current = i;
        emitted = new Map();
        yield item.input;
      }
    })();

    const accept = async (e: Emission): Promise<Error | undefined> => {
      if (current < 0) return new Error(`Cell "${cell.id}" emitted before pulling an input`);
      if (!cell.outputs.includes(e.signal)) {
        return new Error(`Cell "${cell.id}" emitted to undeclared signal "${e.signal}"`);
      }
      let json: string;
      try {
        json = canonicalJson(e.value);
      } catch (error) {
        return error as Error;
      }
      const id = rowId(e.signal, e.key);
      const claim = (live[current] as Live).claim;
      const prior = emitted.get(id);
      if (prior && prior.json !== json) {
        return new ConflictingEmission(`${e.signal}/${e.key}: emitted twice with different values`);
      }
      const stored = await this.#value(e.signal, e.key);
      if (stored !== undefined && stored !== json) {
        const [other] = await this.#db.all<{ cell: string; in_signal: string; in_key: string }>(
          "SELECT cell, in_signal, in_key FROM cells_provenance WHERE out_signal = ? AND out_key = ? AND NOT (cell = ? AND in_signal = ? AND in_key = ?) LIMIT 1",
          e.signal,
          e.key,
          cell.id,
          claim.signal,
          claim.key,
        );
        if (other) {
          return new ConflictingEmission(
            `${e.signal}/${e.key}: ${cell.id}(${claim.signal}/${claim.key}) emits a value different from ${other.cell}(${other.in_signal}/${other.in_key})`,
          );
        }
      }
      emitted.set(id, { signal: e.signal, key: e.key, json });
      return undefined;
    };

    const gen = cell.run({ [Symbol.asyncIterator]: () => iterator })[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await gen.next();
        if (step.done || fatal) break;
        failure = await accept(step.value);
        if (failure) break;
      }
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined || fatal) await gen.return?.(undefined);
    if (fatal) throw fatal;

    if (failure !== undefined) {
      const at = Math.max(current, 0);
      await this.#fail(cell, (live[at] as Live).claim, failure, result);
      await this.#release(cell, live.slice(at + 1).map((l) => l.claim));
      return true;
    }
    if (current >= 0 && !(await commitCurrent())) throw fatal;
    await this.#release(cell, live.slice(current + 1).map((l) => l.claim));
    return retracted || current >= 0;
  }

  /**
   * One transaction: replace the input's provenance, write changed outputs and
   * queue their consumers, retract outputs no longer emitted (unless another
   * input still produces them), dequeue the claimed seq, clear any dead letter.
   */
  async #commit(cell: Cell, claim: Claimed, emitted: Map<string, Row>): Promise<void> {
    const input = [cell.id, claim.signal, claim.key];
    const previous = await this.#db.all<{ out_signal: string; out_key: string }>(
      "SELECT out_signal, out_key FROM cells_provenance WHERE cell = ? AND in_signal = ? AND in_key = ?",
      ...input,
    );
    const statements: SqlStatement[] = [
      { sql: "DELETE FROM cells_provenance WHERE cell = ? AND in_signal = ? AND in_key = ?", params: input },
    ];
    for (const row of emitted.values()) {
      statements.push({
        sql: "INSERT INTO cells_provenance (cell, in_signal, in_key, out_signal, out_key) VALUES (?, ?, ?, ?, ?)",
        params: [...input, row.signal, row.key],
      });
      if ((await this.#value(row.signal, row.key)) !== row.json) {
        statements.push(
          {
            sql: "INSERT INTO cells_rows (signal, key, value) VALUES (?, ?, ?) ON CONFLICT (signal, key) DO UPDATE SET value = excluded.value",
            params: [row.signal, row.key, row.json],
          },
          ...this.#enqueue(row.signal, row.key),
        );
      }
    }
    for (const { out_signal, out_key } of previous) {
      if (emitted.has(rowId(out_signal, out_key))) continue;
      statements.push(
        {
          sql: "DELETE FROM cells_rows WHERE signal = ? AND key = ? AND NOT EXISTS (SELECT 1 FROM cells_provenance WHERE out_signal = ? AND out_key = ?)",
          params: [out_signal, out_key, out_signal, out_key],
        },
        ...this.#enqueue(out_signal, out_key, true),
      );
    }
    statements.push(
      { sql: "DELETE FROM cells_pending WHERE cell = ? AND signal = ? AND key = ? AND seq = ?", params: [...input, claim.seq] },
      { sql: "UPDATE cells_pending SET lease_owner = NULL, lease_until = NULL WHERE cell = ? AND signal = ? AND key = ?", params: input },
      { sql: "DELETE FROM cells_dead_letter WHERE cell = ? AND signal = ? AND key = ?", params: input },
    );
    await this.#db.transaction(statements);
  }

  /** Retry immediately (lease cleared, attempts + 1) or move to the dead letter. */
  async #fail(cell: Cell, claim: Claimed, error: unknown, result: RunResult): Promise<void> {
    result.failed++;
    const input = [cell.id, claim.signal, claim.key];
    const unlease: SqlStatement = {
      sql: "UPDATE cells_pending SET lease_owner = NULL, lease_until = NULL WHERE cell = ? AND signal = ? AND key = ?",
      params: input,
    };
    const attempts = claim.attempts + 1;
    if (attempts < this.#maxAttempts) {
      await this.#db.transaction([
        {
          sql: "UPDATE cells_pending SET attempts = attempts + 1 WHERE cell = ? AND signal = ? AND key = ? AND seq = ?",
          params: [...input, claim.seq],
        },
        unlease,
      ]);
      return;
    }
    result.deadLettered++;
    await this.#db.transaction([
      {
        sql: "INSERT INTO cells_dead_letter (cell, signal, key, attempts, error) VALUES (?, ?, ?, ?, ?) ON CONFLICT (cell, signal, key) DO UPDATE SET attempts = excluded.attempts, error = excluded.error",
        params: [...input, attempts, errorText(error)],
      },
      { sql: "DELETE FROM cells_pending WHERE cell = ? AND signal = ? AND key = ? AND seq = ?", params: [...input, claim.seq] },
      unlease,
    ]);
  }

  async #release(cell: Cell, claims: Claimed[]): Promise<void> {
    if (claims.length === 0) return;
    await this.#db.transaction(
      claims.map((c) => ({
        sql: "UPDATE cells_pending SET lease_owner = NULL, lease_until = NULL WHERE cell = ? AND signal = ? AND key = ? AND lease_owner = ?",
        params: [cell.id, c.signal, c.key, this.#owner],
      })),
    );
  }
```

In `src/index.ts`, change the engine export line to `export { CellEngine, ConflictingEmission } from "./engine.js";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: PASS, 16 tests (7 from Task 1 + 6 cascade + 3 retraction).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @statewalker/webrun-cells typecheck`
Expected: no errors. (`#cells`, `#order` and the option fields are now used.)

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-cells/src
git commit -m "feat(webrun-cells): run loop with pull-next commit, early cut-off and provenance retraction"
```

---

### Task 3: Failures, dead letters, requeue, early return

**Files:**
- Modify: `packages/webrun-cells/src/engine.ts`
- Test: `packages/webrun-cells/src/failures.test.ts`

**Interfaces:**
- Consumes: `run()`, `#fail`, `#enqueue`/`#pendingInsert`, `ConflictingEmission` from Task 2.
- Produces: `deadLetters(): Promise<DeadLetter[]>` (ordered by cell, signal, key) and `requeue(cell: string, signal: string, key: string): Promise<void>` (throws `Unknown cell "…"` for an id not in the graph).

- [ ] **Step 1: Write the failing tests**

`src/failures.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const copy = (fail: (key: string) => boolean) =>
  mapCell("copy", ["docs"], ["out"], (i) => {
    if (fail(i.key)) throw new Error("boom");
    return [{ signal: "out", key: i.key, value: i.value }];
  });

describe("failures", () => {
  it("retries a throwing input, dead-letters it, and commits the rest", async () => {
    let calls = 0;
    const c = copy((key) => {
      if (key !== "bad") return false;
      calls++;
      return true;
    });
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 3 });
    await engine.put("docs", "good", 1);
    await engine.put("docs", "bad", 2);
    expect(await engine.run()).toEqual({ committed: 1, failed: 3, deadLettered: 1 });
    expect(calls).toBe(3);
    expect(await engine.list("out")).toEqual([{ key: "good", value: 1 }]);
    expect(await engine.deadLetters()).toEqual([
      { cell: "copy", signal: "docs", key: "bad", attempts: 3, error: "Error: boom" },
    ]);
  });

  it("requeues a dead letter", async () => {
    let broken = true;
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => broken)], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    broken = false;
    await engine.requeue("copy", "docs", "a");
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "a")).toBe(1);
    expect(await engine.deadLetters()).toEqual([]);
    await expect(engine.requeue("nope", "docs", "a")).rejects.toThrow(/Unknown cell "nope"/);
  });

  it("gives a dead-lettered input a fresh try when its source changes, and clears the dead letter", async () => {
    let broken = true;
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => broken)], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    expect(await engine.deadLetters()).toHaveLength(1);
    broken = false;
    await engine.put("docs", "a", 2); // a new value enqueues the input again
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "a")).toBe(2);
    expect(await engine.deadLetters()).toEqual([]);
  });

  it("keeps the old outputs of a failing input", async () => {
    let broken = false;
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => broken)], maxAttempts: 1 });
    await engine.put("docs", "a", "v1");
    await engine.run();
    broken = true;
    await engine.put("docs", "a", "v2");
    await engine.run();
    expect(await engine.get("out", "a")).toBe("v1");
  });

  it("commits input 1 even when input 2 of the same batch throws", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [copy((key) => key === "b")], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 2);
    await engine.run();
    expect(await engine.list("out")).toEqual([{ key: "a", value: 1 }]);
  });

  it("fails an input whose cell emits to an undeclared signal", async () => {
    const c = mapCell("c", ["docs"], ["out"], (i) => [{ signal: "other", key: i.key, value: 1 }]);
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    expect((await engine.deadLetters())[0]?.error).toMatch(/undeclared signal "other"/);
  });

  it("fails an input whose emission conflicts with another input's", async () => {
    const c = mapCell("c", ["docs"], ["out"], (i) => [{ signal: "out", key: "same", value: i.value }]);
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 2);
    await engine.run();
    expect(await engine.get("out", "same")).toBe(1);
    const [dead] = await engine.deadLetters();
    expect(dead?.key).toBe("b");
    expect(dead?.error).toMatch(/^ConflictingEmission: /);
  });

  it("fails the first input when a cell yields before pulling one", async () => {
    const eager: Cell = {
      id: "eager",
      inputs: ["docs"],
      outputs: ["out"],
      async *run() {
        yield { signal: "out", key: "x", value: 1 };
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [eager], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    expect((await engine.deadLetters())[0]?.error).toMatch(/before pulling an input/);
  });

  it("leaves inputs queued for the next run when a cell returns without pulling", async () => {
    let lazy = true;
    const c: Cell = {
      id: "c",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        if (lazy) return;
        for await (const i of inputs) yield { signal: "out", key: i.key, value: i.value };
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", 1);
    expect(await engine.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
    lazy = false;
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
  });

  it("finishes the batch in the same run when a cell pulls one input per invocation", async () => {
    const one: Cell = {
      id: "one",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const i of inputs) {
          yield { signal: "out", key: i.key, value: i.value };
          return;
        }
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [one] });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 2);
    expect(await engine.run()).toEqual({ committed: 2, failed: 0, deadLettered: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: FAIL with `engine.deadLetters is not a function` (and `engine.requeue is not a function`).

- [ ] **Step 3: Implement `deadLetters` and `requeue`**

Extend the type import in `src/engine.ts` with `DeadLetter`, and add after `list`:

```ts
  async deadLetters(): Promise<DeadLetter[]> {
    await this.#init();
    return this.#db.all<DeadLetter>(
      "SELECT cell, signal, key, attempts, error FROM cells_dead_letter ORDER BY cell, signal, key",
    );
  }

  /** Put a dead-lettered input back in the queue with a fresh attempt count. */
  async requeue(cell: string, signal: string, key: string): Promise<void> {
    if (!this.#cells.has(cell)) throw new Error(`Unknown cell "${cell}"`);
    await this.#init();
    await this.#db.transaction([
      { sql: "DELETE FROM cells_dead_letter WHERE cell = ? AND signal = ? AND key = ?", params: [cell, signal, key] },
      BUMP,
      this.#pendingInsert(cell, signal, key),
    ]);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: PASS, 26 tests (16 + 10).

- [ ] **Step 5: Commit**

```bash
git add packages/webrun-cells/src
git commit -m "feat(webrun-cells): dead letters, requeue and failure-path tests"
```

---

### Task 4: Leases, concurrency, persistence

**Files:**
- Test: `packages/webrun-cells/src/leases.test.ts`, `packages/webrun-cells/src/persistence.test.ts`
- Modify: `packages/webrun-cells/src/engine.ts` only if a test exposes a defect

**Interfaces:**
- Consumes: the whole public API.
- Produces: nothing new. These tests pin behaviour implemented in Task 2's `#claim`, so they may pass on first run. Establish the red phase by **mutation**, as described in Step 2.

- [ ] **Step 1: Write the tests**

`src/leases.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const copyCell = () => mapCell("copy", ["docs"], ["out"], (i) => [{ signal: "out", key: i.key, value: i.value }]);

describe("leases", () => {
  it("reclaims work from an engine that never commits, only after leaseMs", async () => {
    const sqlite = new DatabaseSync(":memory:");
    let now = 1_000;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hang: Cell = {
      id: "copy",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const i of inputs) {
          entered();
          await new Promise(() => {}); // a process that died mid-batch
          yield { signal: "out", key: i.key, value: i.value };
        }
      },
    };
    const opts = { leaseMs: 100, now: () => now };
    const a = new CellEngine({ db: new NodeSqlDriver(sqlite), cells: [hang], owner: "A", ...opts });
    const b = new CellEngine({ db: new NodeSqlDriver(sqlite), cells: [copyCell()], owner: "B", ...opts });
    await a.put("docs", "k", "v");
    void a.run();
    await started;

    now += 99;
    expect(await b.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
    now += 1;
    expect(await b.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await b.get("out", "k")).toBe("v");
  });

  it("commits each input once when two runs of one engine overlap", async () => {
    const c = copyCell();
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    for (const key of ["a", "b", "c"]) await engine.put("docs", key, key);
    const [r1, r2] = await Promise.all([engine.run(), engine.run()]);
    expect(r1.committed + r2.committed).toBe(3);
    expect(c.seen.sort()).toEqual(["docs/a", "docs/b", "docs/c"]);
  });
});
```

`src/persistence.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell } from "./test-helpers.js";

const dir = mkdtempSync(join(tmpdir(), "webrun-cells-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const split = () =>
  mapCell("split", ["docs"], ["chunks"], (i) => {
    if (i.key === "bad") throw new Error("boom");
    return String(i.value)
      .split(" ")
      .map((word, n) => ({ signal: "chunks", key: `${i.key}#${n}`, value: word }));
  });

/** Open the file database, run `fn` against a fresh engine, close it. */
async function session<T>(file: string, fn: (engine: CellEngine) => Promise<T>): Promise<T> {
  const sqlite = new DatabaseSync(file);
  try {
    return await fn(new CellEngine({ db: new NodeSqlDriver(sqlite), cells: [split()], maxAttempts: 1 }));
  } finally {
    sqlite.close();
  }
}

describe("persistence", () => {
  it("keeps queue, rows, provenance and dead letters across reopening", async () => {
    const file = join(dir, "cells.db");
    await session(file, async (e) => {
      await e.put("docs", "a", "x y");
      await e.put("docs", "bad", "z");
    });
    await session(file, async (e) => {
      expect(await e.run()).toEqual({ committed: 1, failed: 1, deadLettered: 1 }); // the queue survived
    });
    await session(file, async (e) => {
      expect((await e.list("chunks")).map((r) => r.key)).toEqual(["a#0", "a#1"]);
      expect((await e.deadLetters()).map((d) => d.key)).toEqual(["bad"]);
      await e.remove("docs", "a");
    });
    await session(file, async (e) => {
      await e.run();
      expect(await e.list("chunks")).toEqual([]); // provenance survived
    });
  });
});
```

- [ ] **Step 2: Run, then prove the tests can fail (mutation)**

Run: `pnpm --filter @statewalker/webrun-cells test`
Expected: PASS, 29 tests.

Then mutate `#claim` in `src/engine.ts`: delete ` AND (lease_until IS NULL OR lease_until <= ?)` from the `UPDATE` statement and drop the trailing `now` from its params. Re-run.
Expected: FAIL. The overlap test reports more than 3 commits or a duplicate in `seen`, and/or the lease test commits before `leaseMs`. If nothing fails, the tests do not pin the lease guard: strengthen them before going on.

Revert the mutation (`git checkout packages/webrun-cells/src/engine.ts`) and re-run. Expected: PASS, 29 tests.

- [ ] **Step 3: Commit**

```bash
git add packages/webrun-cells/src/leases.test.ts packages/webrun-cells/src/persistence.test.ts
git commit -m "test(webrun-cells): leases, overlapping runs and persistence across reopen"
```

---

### Task 5: README, changeset, consumer-install, full verification

**Files:**
- Create: `packages/webrun-cells/README.md`
- Create: `.changeset/webrun-cells.md`
- Modify: `tools/consumer-install/consumer-install.test.ts` (the `PACKAGES` array)

**Interfaces:**
- Consumes: the public API from Tasks 1–3: `CellEngine`, `ConflictingEmission`, the types.

- [ ] **Step 1: Add the package to consumer-install (failing first)**

In `tools/consumer-install/consumer-install.test.ts`, add to `PACKAGES` after the `webrun-builder` line:

```ts
  { name: "@statewalker/webrun-cells", dir: "webrun-cells", subpaths: ["."] },
```

Run: `pnpm --filter @statewalker/webrun-cells build && pnpm --filter @statewalker/consumer-install-tests test`
Expected: PASS (29 tests). If the new entry fails, fix the package manifest, not the harness.

- [ ] **Step 2: Write the changeset**

`.changeset/webrun-cells.md`:

```md
---
"@statewalker/webrun-cells": minor
---

New package: a SQLite-backed incremental cell engine. Signal rows, the work queue, provenance and dead letters live in SQL tables behind `SqlDriver`; cells are async generators whose pulled inputs commit atomically; unchanged outputs stop the cascade; outputs no longer produced are retracted.
```

- [ ] **Step 3: Write the README**

`packages/webrun-cells/README.md`. It follows the package shape of the README rules. It must not mention notes, the lost prototype, or history.

````md
# @statewalker/webrun-cells

## What it is

An incremental engine for derived data whose entire state lives in SQLite. Callers write rows into named
**signals**. Every **cell** that consumes a signal is queued for the changed key. `run()` claims queued inputs,
hands them to the cell, and commits what the cell **emits** (rows on its output signals) in the same transaction
that removes the input from the queue. An output equal to the stored row stops the cascade. An output a cell no
longer emits, or one derived from a removed row, is deleted, and the deletion cascades. Failing inputs are
retried and then parked in a dead-letter table while the rest of the graph converges.

## Why it exists

Keeping derived data current over a changing corpus (split, extract, embed, index) needs the minimum correct
cascade: only affected keys, in dependency order, resumable after a crash, with nothing left behind when a source
disappears. When the queue, the outputs and the record of which input produced which output are rows in one
database, each step commits atomically and "what is left to do" is a `SELECT`, not something recomputed after a
restart. `@statewalker/webrun-builder` solves a neighbouring problem with stage-level convergence over files.
Use this package when the unit of work is a key, and when failures must not stall the rest of the pipeline.

## How to use

```sh
pnpm add @statewalker/webrun-cells @statewalker/webrun-files-sqlite
```

The engine talks to SQLite through `SqlDriver` from `@statewalker/webrun-files-sqlite`, which provides
`NodeSqlDriver` (`node:sqlite`), `DoSqlDriver` (a Durable Object's SQLite storage) and `D1SqlDriver`. The test
suite runs on `NodeSqlDriver`.

```ts
import { CellEngine, type Cell } from "@statewalker/webrun-cells";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { DatabaseSync } from "node:sqlite";

const split: Cell = {
  id: "split",
  inputs: ["docs"],
  outputs: ["chunks"],
  async *run(inputs) {
    for await (const input of inputs) {
      for (const [n, word] of String(input.value).split(" ").entries())
        yield { signal: "chunks", key: `${input.key}#${n}`, value: word };
    }
  },
};

const engine = new CellEngine({ db: new NodeSqlDriver(new DatabaseSync("cells.db")), cells: [split] });
await engine.put("docs", "a", "hello world");
await engine.run(); // { committed: 1, failed: 0, deadLettered: 0 }
await engine.list("chunks"); // [{ key: "a#0", value: "hello" }, { key: "a#1", value: "world" }]
```

| Member | Does |
|---|---|
| `new CellEngine({ db, cells, owner?, leaseMs?, maxAttempts?, batchSize?, now? })` | validates the graph; the schema is created on first use |
| `put(signal, key, value)` / `remove(signal, key)` | write a **source** signal (one no cell outputs) |
| `get(signal, key)` / `list(signal)` | read any signal |
| `run()` | claim → run → commit until nothing claimable is left; resolves `{ committed, failed, deadLettered }` |
| `deadLetters()` / `requeue(cell, signal, key)` | inspect parked inputs and put one back |

## Examples

### A cell commits one input at a time, when it pulls the next

```ts
async *run(inputs) {
  for await (const input of inputs) {   // pulling input 2 commits input 1
    yield { signal: "out", key: input.key, value: f(input.value) };
  }                                      // returning commits the last input
}
```

If the cell throws while handling input 2, input 1 stays committed and input 2 is retried. If the cell returns
before pulling every input, the inputs it did not pull go back to the queue.

### Removing a source retracts everything derived from it

```ts
await engine.remove("docs", "a");
await engine.run(); // chunks a#0, a#1 deleted; their consumers' outputs deleted in turn
```

Cells are not invoked for a removal. The engine knows from provenance which rows an input produced.

### Inspecting and retrying failures

```ts
for (const d of await engine.deadLetters()) {
  console.log(d.cell, d.signal, d.key, d.attempts, d.error);
  await engine.requeue(d.cell, d.signal, d.key);
}
```

## Internals

### Five tables

```
cells_rows        (signal, key) → value          canonical JSON text
cells_pending     (cell, signal, key) → seq, attempts, lease_owner, lease_until
cells_provenance  (cell, in_signal, in_key, out_signal, out_key)
cells_dead_letter (cell, signal, key) → attempts, error
cells_meta        'seq' → counter
```

All names carry the `cells_` prefix, so the engine can share a database with other tables, such as a Durable
Object's.

### Why values are compared as text, not hashed

Values are stored as JSON with object keys sorted at every depth, and "unchanged" means byte-equal text. A hash
would be cheaper to compare, but a collision would silently skip a real update and leave stale outputs, with
nothing to point at the cause. Values JSON cannot represent exactly (`undefined`, `NaN`, `Infinity`, `Date`)
are rejected with a `TypeError` instead of being stored as `null`.

### Why a newer change survives a commit

Every enqueue stamps the queue row with a fresh `seq`. A commit deletes the queue row only if it still carries
the `seq` that was claimed. A change that arrives while the cell runs replaces the `seq`, so the input stays
queued and runs again with the new value.

### Why the commit never reads inside its transaction

`SqlDriver.transaction(statements)` takes a fixed list of statements, which is what D1's `batch()` allows. The
engine reads what it needs (previous provenance, stored values) before the transaction. Conditions that must hold
at commit time are written in SQL: an orphan row is deleted `WHERE NOT EXISTS` another producer, and its
consumers are queued only if the row is really gone.

### The graph is declared and acyclic

Cells declare `inputs` and `outputs`. Construction fails on duplicate ids, on cycles (`Cycle detected among
cells: …`), and on a cell that consumes its own output. `put`/`remove` on a signal some cell outputs fail with
`"…" is not a source signal`. Because the graph is acyclic and every commit removes a queue row, `run()`
terminates.

### Dependencies

`@statewalker/webrun-dataflow` for topology and cycle detection; `@statewalker/webrun-files-sqlite` for the
`SqlDriver` port. No other runtime dependencies.

## What will surprise you

- **A batch may be replayed after a crash.** An input that was running when the process died keeps its lease
  until `leaseMs` (30 s by default) passes, then runs again. Side effects outside the database (files written,
  HTTP calls) must be idempotent per input key. If they are not, the symptom is a duplicated external write
  after a restart.
- **A dead-lettered input does not stop convergence.** `run()` resolves normally. Its result's `deadLettered`
  count and `deadLetters()` are the only signals. The failing input's previous outputs stay as they were.
- **Two inputs may emit the same output only with the same value.** A differing value fails the later input
  with `ConflictingEmission: <signal>/<key>: …`. Two engines sharing one database can race past this check
  when they emit the same key at the same moment. The check reads before the commit, because the driver cannot
  read inside a transaction.
- **`leaseMs` must exceed the time a batch takes.** A batch that runs longer than its lease can be claimed and
  run a second time by another engine on the same database.
- **A cell that never pulls its inputs does not spin.** `run()` stops claiming a cell whose batch pulled
  nothing, and resolves. The inputs are claimed again by the next `run()`.

## License

MIT
````

- [ ] **Step 4: Verify the README's commands and example**

Build the package, then run the README's "How to use" snippet with `cells.db` replaced by `:memory:`. Nothing is added to the repository.

```bash
cd packages/webrun-cells && node --input-type=module -e '
import { CellEngine } from "./dist/index.mjs";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { DatabaseSync } from "node:sqlite";
const split = { id: "split", inputs: ["docs"], outputs: ["chunks"], async *run(inputs) {
  for await (const input of inputs) for (const [n, word] of String(input.value).split(" ").entries())
    yield { signal: "chunks", key: `${input.key}#${n}`, value: word }; } };
const engine = new CellEngine({ db: new NodeSqlDriver(new DatabaseSync(":memory:")), cells: [split] });
await engine.put("docs", "a", "hello world");
console.log(JSON.stringify(await engine.run()), JSON.stringify(await engine.list("chunks")));'
```

Expected output: `{"committed":1,"failed":0,"deadLettered":0} [{"key":"a#0","value":"hello"},{"key":"a#1","value":"world"}]`

- [ ] **Step 5: Full verification, in order**

```bash
pnpm test                         # whole workspace; webrun-cells 29, consumer-install 29
pnpm typecheck
pnpm biome check --write --unsafe
git status --short                # biome may have reformatted; review the diff
pnpm test                         # again if biome changed anything
```

Expected: all green. The baseline before this branch was 472 passing and 1 skipped. The total is now 502 passing (+29 webrun-cells, +1 consumer-install) and 1 skipped.

- [ ] **Step 6: Commit**

```bash
git add packages/webrun-cells/README.md .changeset/webrun-cells.md tools/consumer-install/consumer-install.test.ts
git add -u
git commit -m "docs(webrun-cells): README, changeset and consumer-install entry"
```
