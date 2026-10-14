# webrun-cells demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React SPA at `apps/webrun-cells-demo` that runs the real `CellEngine` on in-browser SQLite and visualises file re-indexing and question answering stage by stage.

**Architecture:** `WasmSqlDriver` adapts sqlite-wasm to `SqlDriver`. `createPipeline` builds the index and question cells (with deterministic fakes for every AI step), wraps each cell to emit start/emit/done/fail events and to apply a per-input delay, and returns the engine. `DemoModel` is the framework-free state behind the views (files, run loop, pending counts, log, per-file and per-question inspection). React views render a `DemoModel` snapshot via `useSyncExternalStore`.

**Tech Stack:** TypeScript, React 19, Tailwind v4 (`@tailwindcss/cli`), shadcn/ui (radix-ui), Rolldown, Vitest, Biome, `@sqlite.org/sqlite-wasm`, `@statewalker/webrun-cells`.

**Spec:** `docs/superpowers/specs/2026-10-14-webrun-cells-demo-design.md`

## Global Constraints

- Package: `apps/webrun-cells-demo`, name `@statewalker/webrun-cells-demo`, `"private": true`, `"type": "module"`, version `0.0.0`.
- Strict red/green TDD for Tasks 1–4 and the layout function in Task 6: write the test, run it and **see it fail for the expected reason**, then implement, then see it pass. Reports must quote both runs (the failing line and the passing summary).
- Tests run in Node with Vitest; files are `src/**/*.test.ts`. No React component tests (agreed seam). Tests run against real code: real `CellEngine`, real SQLite (`node:sqlite` via `NodeSqlDriver`, or sqlite-wasm). No mocks of the code under test.
- All file names kebab-case.
- Fakes are deterministic: no `Math.random`, no time in pipeline cell outputs.
- Workspace deps: `@statewalker/webrun-cells` as `workspace:^`; `@statewalker/webrun-files-sqlite`, `typescript`, `vitest`, `@types/node`, `tailwindcss`, `rolldown` as `catalog:`. New third-party deps pinned to these versions: `@sqlite.org/sqlite-wasm` `3.53.4-build2` (exact), `react` / `react-dom` `^19.3.0`, `@types/react` / `@types/react-dom` `^19.3.0`, `@tailwindcss/cli` `^4.3.3`, `radix-ui` `^1.8.1`, `class-variance-authority` `^0.7.1`, `clsx` `^2.1.1`, `tailwind-merge` `^3.7.0`, `lucide-react` `^1.57.0`, `tw-animate-css` `^1.4.0`, `sirv-cli` `^3.0.1`.
- Before the first test run in a fresh checkout, build the app's workspace dependencies once: `pnpm --filter "@statewalker/webrun-cells-demo^..." run build` (the workspace packages resolve to `dist/`).
- Every task ends with: `pnpm --filter @statewalker/webrun-cells-demo test`, `pnpm --filter @statewalker/webrun-cells-demo typecheck`, `pnpm biome check --write --unsafe apps/webrun-cells-demo`, then a commit. Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AUoZheWYimevGAHVEB63uu
  ```

## Review Focus

1. A file edited while a run is in progress → the edit is not lost; the model runs again until the queue is empty (Task 4 test "edits during a run").
2. An empty or whitespace-only file → no blocks, an empty file summary, no failure, no dead letter (Task 2 test "empty file").
3. Removing a paragraph → the trailing block rows disappear from `block-summaries`, `fts-terms` and `vectors` (Task 2 test "fewer blocks").
4. A question nothing matches, or asked against an empty index → answer text `No indexed content matches this question.` with no citations (Task 3 test "no match").
5. A deleted file → a question asked afterwards never cites it (Task 3 test "deleted file").

---

### Task 1: App scaffold and `WasmSqlDriver`

**Files:**
- Create: `apps/webrun-cells-demo/package.json`, `apps/webrun-cells-demo/tsconfig.json`, `apps/webrun-cells-demo/vitest.config.ts`
- Create: `apps/webrun-cells-demo/src/engine/wasm-sql-driver.ts`
- Test: `apps/webrun-cells-demo/src/engine/wasm-sql-driver.test.ts`

**Interfaces:**
- Consumes: `SqlDriver`, `SqlStatement` from `@statewalker/webrun-files-sqlite`; `CellEngine`, `Cell` from `@statewalker/webrun-cells`.
- Produces: `class WasmSqlDriver implements SqlDriver` (constructor takes a `WasmDatabase`); `openMemoryDb(): Promise<WasmSqlDriver>`.

- [ ] **Step 1: Scaffold the package**

`package.json`:

```json
{
  "name": "@statewalker/webrun-cells-demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "React demo: the webrun-cells engine on in-browser SQLite, re-indexing fake files and answering questions stage by stage",
  "license": "MIT",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@sqlite.org/sqlite-wasm": "3.53.4-build2",
    "@statewalker/webrun-cells": "workspace:^",
    "@statewalker/webrun-files-sqlite": "catalog:"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`tsconfig.json`: copy `packages/webrun-cells/tsconfig.json` and change `"lib"` to `["ESNext", "DOM", "DOM.Iterable"]`, add `"jsx": "react-jsx"`, drop `declaration`, `declarationMap`, `sourceMap`.

`vitest.config.ts`: copy `packages/webrun-cells/vitest.config.ts` verbatim.

Run `pnpm install`, then `pnpm --filter "@statewalker/webrun-cells-demo^..." run build`.

- [ ] **Step 2: Write the failing test**

`src/engine/wasm-sql-driver.test.ts`:

```ts
import { type Cell, CellEngine } from "@statewalker/webrun-cells";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "./wasm-sql-driver.js";

const upper: Cell = {
  id: "upper",
  inputs: ["words"],
  outputs: ["upper"],
  async *run(inputs) {
    for await (const i of inputs) yield { signal: "upper", key: i.key, value: String(i.value).toUpperCase() };
  },
};
const lengths: Cell = {
  id: "lengths",
  inputs: ["upper"],
  outputs: ["lengths"],
  async *run(inputs) {
    for await (const i of inputs) yield { signal: "lengths", key: i.key, value: String(i.value).length };
  },
};

describe("WasmSqlDriver", () => {
  it("runs the engine: a chain converges and a remove retracts it", async () => {
    const engine = new CellEngine({ db: await openMemoryDb(), cells: [upper, lengths] });
    await engine.put("words", "a", "hello");
    await engine.run();
    expect(await engine.get("upper", "a")).toBe("HELLO");
    expect(await engine.get("lengths", "a")).toBe(5);
    await engine.remove("words", "a");
    await engine.run();
    expect(await engine.list("upper")).toEqual([]);
    expect(await engine.list("lengths")).toEqual([]);
  });

  it("returns a change count per statement", async () => {
    const db = await openMemoryDb();
    db.run("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
    const counts = db.transaction([
      { sql: "INSERT INTO t (a, b) VALUES (?, ?)", params: [1, "x"] },
      { sql: "UPDATE t SET b = 'y' WHERE a = ?", params: [2] },
    ]);
    expect(counts).toEqual([1, 0]);
    expect(db.all("SELECT a, b FROM t")).toEqual([{ a: 1, b: "x" }]);
  });

  it("rolls the whole transaction back when a statement fails", async () => {
    const db = await openMemoryDb();
    db.run("CREATE TABLE t (a INTEGER PRIMARY KEY)");
    expect(() =>
      db.transaction([{ sql: "INSERT INTO t VALUES (1)" }, { sql: "INSERT INTO t VALUES (1)" }]),
    ).toThrow();
    expect(db.all("SELECT * FROM t")).toEqual([]);
  });
});
```

Note: sqlite-wasm returns null-prototype row objects; `toEqual` compares own enumerable properties, so `{ a: 1, b: "x" }` matches.

- [ ] **Step 3: Run it and see it fail**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: FAIL — cannot resolve `./wasm-sql-driver.js`.

- [ ] **Step 4: Implement**

`src/engine/wasm-sql-driver.ts`:

```ts
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { SqlDriver, SqlStatement } from "@statewalker/webrun-files-sqlite";

/** The subset of sqlite-wasm's `oo1.DB` this driver uses. */
export interface WasmDatabase {
  exec(opts: { sql: string; bind?: unknown[] }): unknown;
  selectObjects(sql: string, bind?: unknown[]): Record<string, unknown>[];
  changes(): number;
}

const bind = (params: unknown[] | undefined) => (params && params.length > 0 ? params : undefined);

/** sqlite-wasm (`oo1.DB`): synchronous, so a transaction cannot interleave with other calls. */
export class WasmSqlDriver implements SqlDriver {
  readonly #db: WasmDatabase;

  constructor(db: WasmDatabase) {
    this.#db = db;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.#db.selectObjects(sql, bind(params)) as T[];
  }

  run(sql: string, ...params: unknown[]): void {
    this.#db.exec({ sql, bind: bind(params) });
  }

  transaction(statements: SqlStatement[]): number[] {
    this.#db.exec({ sql: "BEGIN" });
    try {
      const counts = statements.map((s) => {
        this.#db.exec({ sql: s.sql, bind: bind(s.params) });
        return this.#db.changes();
      });
      this.#db.exec({ sql: "COMMIT" });
      return counts;
    } catch (error) {
      this.#db.exec({ sql: "ROLLBACK" });
      throw error;
    }
  }
}

/** A fresh in-memory database. */
export async function openMemoryDb(): Promise<WasmSqlDriver> {
  const sqlite3 = await sqlite3InitModule();
  return new WasmSqlDriver(new sqlite3.oo1.DB(":memory:") as unknown as WasmDatabase);
}
```

If `exec` with `bind: undefined` is rejected by the library's types, build the options object without the `bind` key when there are no params; keep the behaviour.

- [ ] **Step 5: Run it and see it pass**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm --filter @statewalker/webrun-cells-demo typecheck
pnpm biome check --write --unsafe apps/webrun-cells-demo
git add apps/webrun-cells-demo pnpm-lock.yaml
git commit -m "feat(webrun-cells-demo): scaffold app and sqlite-wasm SqlDriver"
```

---

### Task 2: Index pipeline (fakes, corpus, index cells, `createPipeline`)

**Files:**
- Create: `apps/webrun-cells-demo/src/pipeline/fakes.ts`
- Create: `apps/webrun-cells-demo/src/pipeline/corpus.ts`
- Create: `apps/webrun-cells-demo/src/pipeline/types.ts`
- Create: `apps/webrun-cells-demo/src/pipeline/index-cells.ts`
- Create: `apps/webrun-cells-demo/src/pipeline/pipeline.ts`
- Test: `apps/webrun-cells-demo/src/pipeline/index-pipeline.test.ts`

**Interfaces:**
- Consumes: `CellEngine`, `Cell`, `CellInput` from `@statewalker/webrun-cells`; `SqlDriver`.
- Produces (later tasks rely on these exact names):

```ts
// types.ts
export type PipelineEvent =
  | { type: "start" | "emit" | "done"; cell: string; signal: string; key: string }
  | { type: "fail"; cell: string; signal: string; key: string; error: string };
export interface BlockSummary { path: string; n: number; text: string; summary: string }
export interface FtsDoc { path: string; terms: Record<string, number>; length: number }
export interface VectorDoc { path: string; vector: number[] }

// pipeline.ts
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
export function createPipeline(opts: PipelineOptions): Pipeline;

// corpus.ts
export const CORPUS: Readonly<Record<string, string>>;

// fakes.ts
export function splitBlocks(text: string): string[];
export function summarize(text: string): string;
export function fileSummary(summaries: string[]): string;
export function tokenize(text: string): string[];
export function termFreqs(text: string): Record<string, number>;
export const DIM = 256;
export function embed(text: string): number[];
export function cosine(a: number[], b: number[]): number;
export function bm25(query: string[], docs: { key: string; doc: FtsDoc }[]): { key: string; score: number }[];
```

Signals (from the spec): `files` (source, path → text) → `split` → `file-blocks` (path → string[]) → `summarize` → `block-summaries` (`path#n` → `BlockSummary`) and `file-summaries` (path → string) → `fts-index` → `fts-terms` (`path#n` → `FtsDoc`) and `vector-index` → `vectors` (`path#n` → `VectorDoc`, 256 dims).

- [ ] **Step 1: Write the failing test**

`src/pipeline/index-pipeline.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS } from "./corpus.js";
import { createPipeline, type Pipeline } from "./pipeline.js";
import type { PipelineEvent } from "./types.js";

const SIGNALS = ["file-blocks", "block-summaries", "file-summaries", "fts-terms", "vectors"];

let pipeline: Pipeline;
let events: PipelineEvent[];
const started = (cell: string) => events.filter((e) => e.type === "start" && e.cell === cell).map((e) => e.key);
const keys = async (signal: string) => (await pipeline.engine.list(signal)).map((r) => r.key);

beforeEach(async () => {
  events = [];
  pipeline = createPipeline({
    db: new NodeSqlDriver(new DatabaseSync(":memory:")),
    onEvent: (e) => events.push(e),
  });
  for (const [path, text] of Object.entries(CORPUS)) await pipeline.engine.put("files", path, text);
  await pipeline.engine.run();
});

describe("index pipeline", () => {
  it("indexes the seeded corpus: every block summarized, term-indexed and embedded", async () => {
    const blockCount = Object.values(CORPUS)
      .map((t) => t.split(/\n\s*\n/).filter((b) => b.trim()).length)
      .reduce((a, b) => a + b, 0);
    expect(await keys("file-summaries")).toHaveLength(Object.keys(CORPUS).length);
    expect(await keys("block-summaries")).toHaveLength(blockCount);
    expect(await keys("fts-terms")).toHaveLength(blockCount);
    expect(await keys("vectors")).toHaveLength(blockCount);
    const vector = (await pipeline.engine.get("vectors", "docs/install.md#0")) as { vector: number[] };
    expect(vector.vector).toHaveLength(256);
    expect(await pipeline.engine.deadLetters()).toEqual([]);
  });

  it("re-indexes only the edited block (early cut-off stops the unchanged ones)", async () => {
    events.length = 0;
    const text = CORPUS["docs/install.md"] as string;
    await pipeline.engine.put("files", "docs/install.md", text.replace("Node 22", "Node 24"));
    await pipeline.engine.run();
    expect(started("split")).toEqual(["docs/install.md"]);
    expect(started("summarize")).toEqual(["docs/install.md"]);
    expect(started("fts-index")).toEqual(["docs/install.md#1"]);
    expect(started("vector-index")).toEqual(["docs/install.md#1"]);
  });

  it("deleting a file removes its rows from every derived signal", async () => {
    await pipeline.engine.remove("files", "docs/faq.md");
    await pipeline.engine.run();
    for (const signal of SIGNALS) {
      expect((await keys(signal)).filter((k) => k.startsWith("docs/faq.md"))).toEqual([]);
    }
  });

  it("fewer blocks: removing a paragraph deletes the trailing block rows", async () => {
    const text = CORPUS["docs/install.md"] as string;
    const firstTwo = text.split(/\n\s*\n/).slice(0, 2).join("\n\n");
    await pipeline.engine.put("files", "docs/install.md", firstTwo);
    await pipeline.engine.run();
    for (const signal of ["block-summaries", "fts-terms", "vectors"]) {
      expect((await keys(signal)).filter((k) => k.startsWith("docs/install.md#"))).toEqual([
        "docs/install.md#0",
        "docs/install.md#1",
      ]);
    }
  });

  it("empty file: no blocks, an empty summary, nothing dead-lettered", async () => {
    await pipeline.engine.put("files", "docs/empty.md", "   \n\n  ");
    await pipeline.engine.run();
    expect(await pipeline.engine.get("file-blocks", "docs/empty.md")).toEqual([]);
    expect(await pipeline.engine.get("file-summaries", "docs/empty.md")).toBe("");
    expect((await keys("block-summaries")).filter((k) => k.startsWith("docs/empty.md"))).toEqual([]);
    expect(await pipeline.engine.deadLetters()).toEqual([]);
  });

  it("delay: each cell waits the configured time per input", async () => {
    const slow = createPipeline({ db: new NodeSqlDriver(new DatabaseSync(":memory:")), delay: () => 20 });
    await slow.engine.put("files", "a.md", "One sentence.");
    const t0 = Date.now();
    await slow.engine.run();
    // split, summarize, fts-index, vector-index: four inputs, 20 ms each
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });
});
```

Note: `engine.list()` returns rows ordered by key; if it does not, sort in `keys()` — check `packages/webrun-cells/src/engine.ts` `list`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: FAIL — cannot resolve `./corpus.js` / `./pipeline.js`.

- [ ] **Step 3: Implement**

`src/pipeline/corpus.ts` — exact text (paragraphs separated by one blank line, no headings):

```ts
export const CORPUS: Readonly<Record<string, string>> = {
  "docs/install.md": [
    "Install the package with pnpm. Run pnpm add @statewalker/webrun-cells in your project folder.",
    "The package needs Node 22 or newer. Older Node releases lack the built-in sqlite module.",
    "A browser build needs SQLite compiled to WebAssembly. Serve the wasm file next to your bundle.",
  ].join("\n\n"),
  "docs/config.md": [
    "Configure the engine through constructor options. The lease time defaults to thirty seconds.",
    "Set maxAttempts to change how often a failing input is retried. After the last attempt the input moves to the dead letter table.",
    "The batch size limits how many inputs one cell claims at once. Smaller batches release work sooner.",
  ].join("\n\n"),
  "docs/retraction.md": [
    "Removing a source row retracts everything derived from it. The engine follows provenance and deletes outputs without running cells.",
    "An output produced by two inputs survives until both producers are removed.",
  ].join("\n\n"),
  "docs/cutoff.md": [
    "When a cell emits a value equal to the stored row, the cascade stops. Downstream cells are not queued again.",
    "Early cut-off keeps a small edit cheap. Only the changed block reaches the index cells.",
  ].join("\n\n"),
  "docs/faq.md": [
    "Why SQLite? The queue is a table, so a crash replays at most one uncommitted input.",
    "Can two engines share a database? Yes, leases stop them from running the same input twice.",
  ].join("\n\n"),
};
```

`src/pipeline/fakes.ts`:

```ts
import type { FtsDoc } from "./types.js";

const STOP = new Set(
  "the and for with how does what why can you your are its this that from into not was were has have will yes".split(" "),
);

/** Paragraphs: split on blank lines, trimmed, empty ones dropped. */
export const splitBlocks = (text: string): string[] =>
  text.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b.length > 0);

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);

/** Extractive: the first sentence. */
export const summarize = (text: string): string => sentences(text)[0] ?? "";

/** Extractive: the first three block summaries. */
export const fileSummary = (summaries: string[]): string => summaries.slice(0, 3).join(" ");

/** Lower-case words of three or more letters, stop words removed. */
export const tokenize = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));

export function termFreqs(text: string): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const t of tokenize(text)) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/** 256 buckets: with 64, unrelated words collide often enough that a nonsense query still gets vector hits. */
export const DIM = 256;

function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Hashed bag of words, L2-normalised, rounded so equal text gives an equal row. */
export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const t of tokenize(text)) v[hash(t) % DIM] = (v[hash(t) % DIM] ?? 0) + 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => round(x / norm));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return round(dot);
}

/** Okapi BM25 (k1 = 1.2, b = 0.75), descending, zero scores dropped. */
export function bm25(query: string[], docs: { key: string; doc: FtsDoc }[]): { key: string; score: number }[] {
  const n = docs.length;
  if (n === 0) return [];
  const avg = docs.reduce((s, d) => s + d.doc.length, 0) / n || 1;
  const df = (t: string) => docs.filter((d) => (d.doc.terms[t] ?? 0) > 0).length;
  return docs
    .map(({ key, doc }) => {
      let score = 0;
      for (const t of query) {
        const tf = doc.terms[t] ?? 0;
        if (tf === 0) continue;
        const idf = Math.log(1 + (n - df(t) + 0.5) / (df(t) + 0.5));
        score += (idf * tf * 2.2) / (tf + 1.2 * (1 - 0.75 + (0.75 * doc.length) / avg));
      }
      return { key, score: round(score) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
```

`src/pipeline/types.ts` — exactly the types listed under Interfaces.

`src/pipeline/index-cells.ts`:

```ts
import type { Cell } from "@statewalker/webrun-cells";
import { embed, fileSummary, splitBlocks, summarize, termFreqs, tokenize } from "./fakes.js";
import type { BlockSummary } from "./types.js";

export const split: Cell = {
  id: "split",
  inputs: ["files"],
  outputs: ["file-blocks"],
  async *run(inputs) {
    for await (const i of inputs) yield { signal: "file-blocks", key: i.key, value: splitBlocks(String(i.value)) };
  },
};

export const summarizeCell: Cell = {
  id: "summarize",
  inputs: ["file-blocks"],
  outputs: ["block-summaries", "file-summaries"],
  async *run(inputs) {
    for await (const i of inputs) {
      const rows: BlockSummary[] = (i.value as string[]).map((text, n) => ({
        path: i.key, n, text, summary: summarize(text),
      }));
      for (const row of rows) yield { signal: "block-summaries", key: `${i.key}#${row.n}`, value: { ...row } };
      yield { signal: "file-summaries", key: i.key, value: fileSummary(rows.map((r) => r.summary)) };
    }
  },
};

export const ftsIndex: Cell = {
  id: "fts-index",
  inputs: ["block-summaries"],
  outputs: ["fts-terms"],
  async *run(inputs) {
    for await (const i of inputs) {
      const { path, text } = i.value as unknown as BlockSummary;
      yield { signal: "fts-terms", key: i.key, value: { path, terms: termFreqs(text), length: tokenize(text).length } };
    }
  },
};

export const vectorIndex: Cell = {
  id: "vector-index",
  inputs: ["block-summaries"],
  outputs: ["vectors"],
  async *run(inputs) {
    for await (const i of inputs) {
      const { path, text } = i.value as unknown as BlockSummary;
      yield { signal: "vectors", key: i.key, value: { path, vector: embed(text) } };
    }
  },
};

export const INDEX_CELLS: readonly Cell[] = [split, summarizeCell, ftsIndex, vectorIndex];
```

`src/pipeline/pipeline.ts`:

```ts
import { type Cell, CellEngine, type CellInput } from "@statewalker/webrun-cells";
import type { SqlDriver } from "@statewalker/webrun-files-sqlite";
import { INDEX_CELLS } from "./index-cells.js";
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
        if (current) onEvent({ type: "done", cell: cell.id, signal: current.signal, key: current.key });
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
          onEvent({ type: "fail", cell: cell.id, signal: current.signal, key: current.key, error: String(error) });
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
  const cells = [...INDEX_CELLS];
  const engine = new CellEngine({ db: opts.db, cells: cells.map((c) => observe(c, onEvent, delay)) });
  return { engine, cells };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: PASS (all Task 1 and Task 2 tests). If "re-indexes only the edited block" fails, the cause is a non-deterministic value in a row — fix the fake, never the test.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @statewalker/webrun-cells-demo typecheck
pnpm biome check --write --unsafe apps/webrun-cells-demo
git add apps/webrun-cells-demo
git commit -m "feat(webrun-cells-demo): index pipeline with deterministic fakes"
```

---

### Task 3: Question pipeline

**Files:**
- Create: `apps/webrun-cells-demo/src/pipeline/question-cells.ts`
- Modify: `apps/webrun-cells-demo/src/pipeline/types.ts` (add question types)
- Modify: `apps/webrun-cells-demo/src/pipeline/pipeline.ts` (add question cells)
- Test: `apps/webrun-cells-demo/src/pipeline/question-pipeline.test.ts`

**Interfaces:**
- Consumes: `createPipeline`, `CORPUS`, `bm25`, `cosine`, `embed`, `tokenize`, `summarize`, `FtsDoc`, `VectorDoc`, `BlockSummary` from Task 2.
- Produces:

```ts
// types.ts additions
export interface Question { text: string; askedAt: number }
export interface Queries { text: string; subqueries: string[] }
export interface Hit { key: string; path: string; score: number; text: string }
export interface Candidates { fts: Hit[]; vector: Hit[] }
export interface ContextItem { key: string; path: string; summary: string }
export interface Answer { text: string; citations: string[] }
export const NO_MATCH = "No indexed content matches this question.";  // put in question-cells.ts, exported

// question-cells.ts
export type ListRows = (signal: string) => Promise<{ key: string; value: unknown }[]>;
export function questionCells(list: ListRows): Cell[];  // plan, search, rerank, condense, answer
```

Signals: `questions` (source, id → `Question`) → `plan` → `queries` → `search` → `candidates` → `rerank` → `ranked` (id → `Hit[]`) → `condense` → `context` (id → `ContextItem[]`) → `answer` → `answers` (id → `Answer`).

- [ ] **Step 1: Write the failing test**

`src/pipeline/question-pipeline.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS } from "./corpus.js";
import { createPipeline, type Pipeline } from "./pipeline.js";
import { NO_MATCH } from "./question-cells.js";
import type { Answer, PipelineEvent, Queries } from "./types.js";

let pipeline: Pipeline;
let events: PipelineEvent[];

async function seed() {
  for (const [path, text] of Object.entries(CORPUS)) await pipeline.engine.put("files", path, text);
  await pipeline.engine.run();
}
async function ask(id: string, text: string, askedAt = 1): Promise<Answer> {
  await pipeline.engine.put("questions", id, { text, askedAt });
  await pipeline.engine.run();
  return (await pipeline.engine.get("answers", id)) as unknown as Answer;
}

beforeEach(() => {
  events = [];
  pipeline = createPipeline({
    db: new NodeSqlDriver(new DatabaseSync(":memory:")),
    onEvent: (e) => events.push(e),
  });
});

describe("question pipeline", () => {
  it("answers a seeded-topic question citing the right file first", async () => {
    await seed();
    const answer = await ask("q1", "How do I install the package with pnpm?");
    expect(answer.citations[0]).toBe("docs/install.md");
    expect(answer.text).not.toBe(NO_MATCH);
    expect(await pipeline.engine.deadLetters()).toEqual([]);
  });

  it("splits a two-part question and cites both topics", async () => {
    await seed();
    const answer = await ask("q1", "How do I install the package with pnpm and how do I configure the lease time?");
    const queries = (await pipeline.engine.get("queries", "q1")) as unknown as Queries;
    expect(queries.subqueries).toHaveLength(2);
    expect(answer.citations).toContain("docs/install.md");
    expect(answer.citations).toContain("docs/config.md");
  });

  it("asking again with a new askedAt re-runs the question; the same value does not", async () => {
    await seed();
    await ask("q1", "How do I install the package?", 1);
    events.length = 0;
    await ask("q1", "How do I install the package?", 1);
    expect(events.filter((e) => e.type === "start" && e.cell === "plan")).toEqual([]);
    await ask("q1", "How do I install the package?", 2);
    expect(events.filter((e) => e.type === "start" && e.cell === "plan").map((e) => e.key)).toEqual(["q1"]);
  });

  it("no match: an empty index, or no matching terms, answers NO_MATCH without citations", async () => {
    expect(await ask("q1", "How do I install the package?")).toEqual({ text: NO_MATCH, citations: [] });
    await seed();
    expect(await ask("q2", "zebra quantum pancake?")).toEqual({ text: NO_MATCH, citations: [] });
  });

  it("deleted file: a later question never cites it", async () => {
    await seed();
    await pipeline.engine.remove("files", "docs/install.md");
    await pipeline.engine.run();
    const answer = await ask("q1", "How do I install the package with pnpm?");
    expect(answer.citations).not.toContain("docs/install.md");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: FAIL — cannot resolve `./question-cells.js`.

- [ ] **Step 3: Implement**

`src/pipeline/question-cells.ts`:

```ts
import type { Cell } from "@statewalker/webrun-cells";
import { bm25, cosine, embed, summarize, tokenize } from "./fakes.js";
import type {
  Answer, BlockSummary, Candidates, ContextItem, FtsDoc, Hit, Queries, Question, VectorDoc,
} from "./types.js";

export const NO_MATCH = "No indexed content matches this question.";

export type ListRows = (signal: string) => Promise<{ key: string; value: unknown }[]>;

const TOP = 5;
const CONTEXT = 3;
const RRF_K = 60;
/** Below this cosine a vector hit is hash-collision noise, not similarity. */
const MIN_SIMILARITY = 0.3;

/** Split on "?", ";" and the word "and"; keep parts that still have search terms. */
export function subqueries(text: string): string[] {
  const parts = text.split(/\?|;|\band\b/i).map((p) => p.trim()).filter((p) => tokenize(p).length > 0);
  return parts.length > 0 ? parts : [text.trim()];
}

/** Best score per key over several ranked lists, descending. */
function mergeMax(lists: { key: string; score: number }[][]): { key: string; score: number }[] {
  const best = new Map<string, number>();
  for (const list of lists) for (const r of list) best.set(r.key, Math.max(best.get(r.key) ?? 0, r.score));
  return [...best].map(([key, score]) => ({ key, score })).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export function questionCells(list: ListRows): Cell[] {
  const plan: Cell = {
    id: "plan",
    inputs: ["questions"],
    outputs: ["queries"],
    async *run(inputs) {
      for await (const i of inputs) {
        const { text } = i.value as unknown as Question;
        const value: Queries = { text, subqueries: subqueries(text) };
        yield { signal: "queries", key: i.key, value: { ...value } };
      }
    },
  };

  const search: Cell = {
    id: "search",
    inputs: ["queries"],
    outputs: ["candidates"],
    async *run(inputs) {
      for await (const i of inputs) {
        const { subqueries: parts } = i.value as unknown as Queries;
        const blocks = new Map((await list("block-summaries")).map((r) => [r.key, r.value as BlockSummary]));
        const fts = (await list("fts-terms")).map((r) => ({ key: r.key, doc: r.value as FtsDoc }));
        const vectors = (await list("vectors")).map((r) => ({ key: r.key, doc: r.value as VectorDoc }));
        // Independent of each other: the FTS and the vector lookups.
        const ftsRanked = mergeMax(parts.map((q) => bm25(tokenize(q), fts)));
        const vecRanked = mergeMax(
          parts.map((q) => {
            const qv = embed(q);
            return vectors.map((v) => ({ key: v.key, score: cosine(qv, v.doc.vector) })).filter((r) => r.score >= MIN_SIMILARITY);
          }),
        );
        const toHit = (r: { key: string; score: number }): Hit[] => {
          const b = blocks.get(r.key);
          return b ? [{ key: r.key, path: b.path, score: r.score, text: b.text }] : [];
        };
        const value: Candidates = { fts: ftsRanked.slice(0, TOP).flatMap(toHit), vector: vecRanked.slice(0, TOP).flatMap(toHit) };
        yield { signal: "candidates", key: i.key, value: JSON.parse(JSON.stringify(value)) };
      }
    },
  };

  const rerank: Cell = {
    id: "rerank",
    inputs: ["candidates"],
    outputs: ["ranked"],
    async *run(inputs) {
      for await (const i of inputs) {
        const { fts, vector } = i.value as unknown as Candidates;
        const fused = new Map<string, Hit>();
        for (const list of [fts, vector]) {
          list.forEach((hit, rank) => {
            const prev = fused.get(hit.key);
            const score = (prev?.score ?? 0) + 1 / (RRF_K + rank + 1);
            fused.set(hit.key, { ...hit, score: Math.round(score * 1e6) / 1e6 });
          });
        }
        const ranked = [...fused.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, TOP);
        yield { signal: "ranked", key: i.key, value: ranked.map((h) => ({ ...h })) };
      }
    },
  };

  const condense: Cell = {
    id: "condense",
    inputs: ["ranked"],
    outputs: ["context"],
    async *run(inputs) {
      for await (const i of inputs) {
        const items: ContextItem[] = (i.value as unknown as Hit[])
          .slice(0, CONTEXT)
          .map((h) => ({ key: h.key, path: h.path, summary: summarize(h.text) }));
        yield { signal: "context", key: i.key, value: items.map((c) => ({ ...c })) };
      }
    },
  };

  const answer: Cell = {
    id: "answer",
    inputs: ["context"],
    outputs: ["answers"],
    async *run(inputs) {
      for await (const i of inputs) {
        const items = i.value as unknown as ContextItem[];
        const value: Answer =
          items.length === 0
            ? { text: NO_MATCH, citations: [] }
            : { text: items.map((c) => c.summary).join(" "), citations: [...new Set(items.map((c) => c.path))] };
        yield { signal: "answers", key: i.key, value: { ...value } };
      }
    },
  };

  return [plan, search, rerank, condense, answer];
}
```

Type note: the engine's `Json` type does not accept interfaces directly; spread/`JSON.parse(JSON.stringify(...))` above is one way to satisfy it. Prefer declaring the row types as `type` aliases that are assignable to `Json` if that compiles cleanly — keep whichever is simpler, but be consistent across files.

`pipeline.ts` change — build the question cells with a reader over the engine created in the same function:

```ts
export function createPipeline(opts: PipelineOptions): Pipeline {
  const onEvent = opts.onEvent ?? (() => {});
  const delay = opts.delay ?? (() => 0);
  let engine: CellEngine | undefined;
  const list: ListRows = (signal) => (engine as CellEngine).list(signal);
  const cells = [...INDEX_CELLS, ...questionCells(list)];
  engine = new CellEngine({ db: opts.db, cells: cells.map((c) => observe(c, onEvent, delay)) });
  return { engine, cells };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: PASS. If a ranking assertion fails, inspect `candidates`/`ranked` rows for the question and fix the fake (tokenizer, stop words, split) — never loosen the assertion to `toContain` on the first citation.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @statewalker/webrun-cells-demo typecheck
pnpm biome check --write --unsafe apps/webrun-cells-demo
git add apps/webrun-cells-demo
git commit -m "feat(webrun-cells-demo): question pipeline: plan, search, rerank, condense, answer"
```

---

### Task 4: `DemoModel` — framework-free state behind the views

**Files:**
- Create: `apps/webrun-cells-demo/src/model/demo-model.ts`
- Test: `apps/webrun-cells-demo/src/model/demo-model.test.ts`

**Interfaces:**
- Consumes: `createPipeline`, `PipelineEvent`, `CORPUS`, row types from Tasks 2–3.
- Produces:

```ts
export interface LogEntry { id: number; type: PipelineEvent["type"]; cell: string; signal: string; key: string; error?: string }
export interface DemoSnapshot {
  files: { path: string; text: string }[];          // sorted by path
  questions: { id: string; text: string }[];        // in ask order
  running: { cell: string; key: string } | null;    // the input currently being handled
  pending: Record<string, number>;                  // cell id → queued inputs (cells_pending)
  log: LogEntry[];                                  // newest last, at most 200
  busy: boolean;                                    // a run is in progress
}
export interface FileStages {
  text?: string; blocks: string[]; blockSummaries: BlockSummary[]; fileSummary?: string;
  ftsTerms: { key: string; terms: Record<string, number> }[]; vectors: { key: string; vector: number[] }[];
}
export interface QuestionStages {
  question?: Question; queries?: Queries; candidates?: Candidates; ranked?: Hit[]; context?: ContextItem[]; answer?: Answer;
}
export class DemoModel {
  static create(opts: { db: SqlDriver; seed?: Readonly<Record<string, string>>; delayMs?: number }): Promise<DemoModel>;
  readonly cells: readonly Cell[];
  getSnapshot(): DemoSnapshot;              // same object until something changes (useSyncExternalStore)
  subscribe(listener: () => void): () => void;
  setDelay(ms: number): void;
  editFile(path: string, text: string): Promise<void>;
  randomEdit(path: string, random?: () => number): Promise<void>;
  deleteFile(path: string): Promise<void>;
  ask(text: string): Promise<string>;       // returns the new question id: "q1", "q2", …
  reask(id: string): Promise<void>;         // same text, new askedAt
  inspectFile(path: string): Promise<FileStages>;
  inspectQuestion(id: string): Promise<QuestionStages>;
  settled(): Promise<void>;                 // resolves once no run is in progress and nothing is queued
}
```

Behaviour:
- Every mutation writes through the engine (`put`/`remove`) and then kicks the run loop. The run loop calls `engine.run()` repeatedly until a pass commits nothing and no mutation arrived during it, so edits made during a run are never lost. `settled()` awaits that loop.
- Pipeline events update `running` (set on `start`, cleared on `done`/`fail`) and append to `log`; after each event, `pending` is refreshed from `SELECT cell, COUNT(*) AS n FROM cells_pending GROUP BY cell`. A new snapshot object is created on every change and listeners are notified.
- `files` is refreshed from `engine.list("files")` after each mutation.
- `randomEdit(path, random = Math.random)` picks one sentence of the file (index `Math.floor(random() * count)`), replaces its final punctuation with ` (rev N).` where N is a model-wide counter starting at 1, and calls `editFile`.
- `ask` puts `{ text, askedAt: Date.now() }` under a new id; `reask` puts the same text with `askedAt: Date.now()` (if `Date.now()` equals the stored value, add 1).

- [ ] **Step 1: Write the failing test**

`src/model/demo-model.test.ts`:

```ts
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { CORPUS } from "../pipeline/corpus.js";
import { DemoModel } from "./demo-model.js";

const open = (seed = CORPUS) => DemoModel.create({ db: new NodeSqlDriver(new DatabaseSync(":memory:")), seed });

describe("DemoModel", () => {
  it("seeds the corpus and settles with an empty queue", async () => {
    const model = await open();
    await model.settled();
    const snap = model.getSnapshot();
    expect(snap.files.map((f) => f.path)).toEqual(Object.keys(CORPUS).sort());
    expect(Object.values(snap.pending).every((n) => n === 0)).toBe(true);
    expect(snap.busy).toBe(false);
    expect(snap.running).toBeNull();
    expect(snap.log.some((e) => e.type === "start" && e.cell === "split")).toBe(true);
  });

  it("notifies subscribers and replaces the snapshot object on change", async () => {
    const model = await open();
    await model.settled();
    const before = model.getSnapshot();
    let calls = 0;
    const off = model.subscribe(() => calls++);
    await model.editFile("docs/faq.md", "Rewritten. Entirely.");
    await model.settled();
    off();
    expect(calls).toBeGreaterThan(0);
    expect(model.getSnapshot()).not.toBe(before);
    expect((await model.inspectFile("docs/faq.md")).blocks).toEqual(["Rewritten. Entirely."]);
  });

  it("edits during a run are not lost", async () => {
    const model = await open();
    void model.editFile("docs/faq.md", "First version.");
    void model.editFile("docs/faq.md", "Second version.");
    await model.settled();
    const stages = await model.inspectFile("docs/faq.md");
    expect(stages.text).toBe("Second version.");
    expect(stages.blockSummaries.map((b) => b.text)).toEqual(["Second version."]);
  });

  it("deleteFile removes the file and all its stages", async () => {
    const model = await open();
    await model.deleteFile("docs/faq.md");
    await model.settled();
    expect(model.getSnapshot().files.map((f) => f.path)).not.toContain("docs/faq.md");
    const stages = await model.inspectFile("docs/faq.md");
    expect(stages).toEqual({ blocks: [], blockSummaries: [], ftsTerms: [], vectors: [] });
  });

  it("ask returns an id whose stages end in a cited answer", async () => {
    const model = await open();
    const id = await model.ask("How do I install the package with pnpm?");
    await model.settled();
    expect(id).toBe("q1");
    const stages = await model.inspectQuestion(id);
    expect(stages.queries?.subqueries.length).toBeGreaterThan(0);
    expect(stages.candidates?.fts.length).toBeGreaterThan(0);
    expect(stages.answer?.citations[0]).toBe("docs/install.md");
    expect(model.getSnapshot().questions).toEqual([{ id: "q1", text: "How do I install the package with pnpm?" }]);
  });

  it("randomEdit changes exactly one sentence", async () => {
    const model = await open();
    await model.settled();
    const before = CORPUS["docs/config.md"] as string;
    await model.randomEdit("docs/config.md", () => 0);
    await model.settled();
    const after = (await model.inspectFile("docs/config.md")).text as string;
    expect(after).not.toBe(before);
    expect(after.replace(" (rev 1).", ".")).toBe(before);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: FAIL — cannot resolve `./demo-model.js`.

- [ ] **Step 3: Implement `src/model/demo-model.ts`**

Implement exactly the interface and behaviour above. Constraints:
- The run loop is a single promise chain held by the model; a mutation sets a `dirty` flag and starts the loop only if it is not already running. Loop: `do { dirty = false; await engine.run(); } while (dirty)`. `busy` is true for the duration.
- `create` builds the pipeline with `delay: () => this.delayMs`, seeds `seed` (if given) with `put`, refreshes files and kicks the loop; it does not await settling.
- `inspectFile` reads `files`, `file-blocks`, `file-summaries` by `get`, and filters `block-summaries`, `fts-terms`, `vectors` from `list` by key prefix `${path}#`, sorted by block number; absent values are omitted (the deleted-file test expects exactly `{ blocks: [], blockSummaries: [], ftsTerms: [], vectors: [] }`).
- `inspectQuestion` reads `questions`, `queries`, `candidates`, `ranked`, `context`, `answers` by `get`; absent ones are omitted.
- Keep the log capped at 200 entries.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm --filter @statewalker/webrun-cells-demo test`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm --filter @statewalker/webrun-cells-demo typecheck
pnpm biome check --write --unsafe apps/webrun-cells-demo
git add apps/webrun-cells-demo
git commit -m "feat(webrun-cells-demo): DemoModel: run loop, snapshot, inspection"
```

---

### Task 5: Build pipeline, shadcn primitives, app shell with the Files panel

**Files:**
- Create: `apps/webrun-cells-demo/rolldown.config.js`, `apps/webrun-cells-demo/scripts/copy-assets.js`, `apps/webrun-cells-demo/scripts/dev.js`
- Create: `apps/webrun-cells-demo/public/index.html`, `apps/webrun-cells-demo/src/styles.css`, `apps/webrun-cells-demo/src/main.tsx`
- Create: `apps/webrun-cells-demo/src/lib/utils.ts`, `apps/webrun-cells-demo/src/components/ui/{button,card,dialog,textarea,input,badge,scroll-area,slider}.tsx`
- Create: `apps/webrun-cells-demo/src/views/use-demo.ts`, `apps/webrun-cells-demo/src/views/app.tsx`, `apps/webrun-cells-demo/src/views/files-panel.tsx`
- Modify: `apps/webrun-cells-demo/package.json` (scripts, deps)

**Interfaces:**
- Consumes: `DemoModel`, `DemoSnapshot` (Task 4); `openMemoryDb` (Task 1); `CORPUS`.
- Produces: `useDemo(model: DemoModel): DemoSnapshot` (via `useSyncExternalStore`); `App({ model }: { model: DemoModel })` with three columns `Files | Graph | Inspector` and a bottom Ask bar slot; `FilesPanel`; Graph/Inspector/Ask slots are placeholders filled by Task 6.

This task has no new unit test (agreed seam: no component tests). Its success criterion is: `pnpm --filter @statewalker/webrun-cells-demo build` produces `dist/index.html`, `dist/main.js`, `dist/styles.css`, `dist/sqlite3.wasm`; typecheck passes; and serving `dist/` shows the seeded files, and editing one in the dialog updates the list.

- [ ] **Step 1: Dependencies and scripts**

Add to `dependencies`: `react`, `react-dom`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react` (versions from Global Constraints). Add to `devDependencies`: `@types/react`, `@types/react-dom`, `rolldown` (`catalog:`), `tailwindcss` (`catalog:`), `@tailwindcss/cli`, `tw-animate-css`, `sirv-cli`.

Scripts:

```json
"build": "rolldown -c && tailwindcss -i src/styles.css -o dist/styles.css --minify && node scripts/copy-assets.js",
"dev": "node scripts/dev.js",
"preview": "sirv dist --port 5180"
```

- [ ] **Step 2: Rolldown config**

`rolldown.config.js`: input `src/main.tsx`, `platform: "browser"`, output `dir: "dist"`, `format: "esm"`, `entryFileNames: "main.js"`, minify in build. Replace `process.env.NODE_ENV` with `"production"` (React needs it). JSX: automatic runtime. Check the installed Rolldown's `RolldownOptions` type (`node_modules/rolldown/dist/*.d.mts`) for where `define` and `jsx` live in this version (`transform.define` / `transform.jsx` in 1.x) and use that.

`scripts/copy-assets.js`: copy `public/index.html` → `dist/index.html` and `node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm` → `dist/sqlite3.wasm` (resolve the package path with `import.meta.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm")`). sqlite-wasm locates the wasm with `new URL("sqlite3.wasm", import.meta.url)`, which after bundling is `dist/main.js`'s directory — that is why the file is copied next to it. If the bundled code looks the file up elsewhere, pass `locateFile` to `sqlite3InitModule` in `openMemoryDb` instead.

`scripts/dev.js`: run `copy-assets`, then spawn `rolldown -c --watch`, `tailwindcss -i src/styles.css -o dist/styles.css --watch` and `sirv dist --dev --port 5180` with `stdio: "inherit"`; kill all children on SIGINT.

`public/index.html`: `<div id="root">`, `<link rel="stylesheet" href="./styles.css">`, `<script type="module" src="./main.js">`, title "webrun-cells demo".

- [ ] **Step 3: Styles and shadcn primitives**

`src/styles.css`: `@import "tailwindcss"; @import "tw-animate-css"; @source "./";` plus the standard shadcn/ui Tailwind v4 neutral theme (`:root` and `.dark` CSS variables, `@theme inline` mapping, `@layer base` border/background rules).

`src/lib/utils.ts`: `cn(...inputs)` = `twMerge(clsx(inputs))`.

`src/components/ui/*.tsx`: the shadcn/ui (new-york, Tailwind v4) source for button, card, dialog, textarea, input, badge, scroll-area, slider, importing primitives from `radix-ui` (e.g. `import { Dialog as DialogPrimitive } from "radix-ui"`). Only the exports the views use.

- [ ] **Step 4: Entry, hook, shell, Files panel**

`src/views/use-demo.ts`: `export const useDemo = (model: DemoModel) => useSyncExternalStore(model.subscribe, model.getSnapshot)` — bind the methods if they are not arrow properties.

`src/main.tsx`: `const model = await DemoModel.create({ db: await openMemoryDb(), seed: CORPUS, delayMs: 300 })`; render `<App model={model} />` into `#root`.

`src/views/app.tsx`: full-height grid `grid-cols-[16rem_1fr_24rem]`, header with title, a speed `Slider` (0–1000 ms, calls `model.setDelay`), a busy indicator; columns: `FilesPanel`, graph slot, inspector slot; bottom row: ask-bar slot. App holds selection state `{ kind: "file", path } | { kind: "question", id } | null`.

`src/views/files-panel.tsx`: list of files (click selects; pencil button opens an edit `Dialog` with a `Textarea`, Save calls `model.editFile`); per-file "random edit" (`model.randomEdit`) and delete (`model.deleteFile`) buttons; "New file" opens the dialog with an `Input` for the path.

- [ ] **Step 5: Verify**

```bash
pnpm install
pnpm --filter @statewalker/webrun-cells-demo build
ls apps/webrun-cells-demo/dist   # index.html main.js styles.css sqlite3.wasm
pnpm --filter @statewalker/webrun-cells-demo test
pnpm --filter @statewalker/webrun-cells-demo typecheck
pnpm biome check --write --unsafe apps/webrun-cells-demo
```

Add `dist` to the app's `.gitignore` if the root `.gitignore` does not already ignore it.

- [ ] **Step 6: Commit**

```bash
git add apps/webrun-cells-demo pnpm-lock.yaml
git commit -m "feat(webrun-cells-demo): rolldown + tailwind build, shadcn primitives, files panel"
```

---

### Task 6: Graph, log, inspector and ask bar

**Files:**
- Create: `apps/webrun-cells-demo/src/views/graph-layout.ts`
- Test: `apps/webrun-cells-demo/src/views/graph-layout.test.ts`
- Create: `apps/webrun-cells-demo/src/views/graph-panel.tsx`, `apps/webrun-cells-demo/src/views/log-panel.tsx`, `apps/webrun-cells-demo/src/views/inspector-panel.tsx`, `apps/webrun-cells-demo/src/views/ask-bar.tsx`
- Modify: `apps/webrun-cells-demo/src/views/app.tsx` (fill the slots)

**Interfaces:**
- Consumes: `DemoModel`, `DemoSnapshot`, `FileStages`, `QuestionStages`, `useDemo`, shadcn primitives.
- Produces:

```ts
// graph-layout.ts
export interface CellNode { id: string; inputs: readonly string[]; outputs: readonly string[]; layer: number; independentOf: string[] }
/** Layer = longest path from a source signal (0 for cells fed only by sources). independentOf = other cells with exactly the same inputs. */
export function layoutCells(cells: readonly { id: string; inputs: readonly string[]; outputs: readonly string[] }[]): CellNode[][];
```

- [ ] **Step 1: Write the failing test** (`src/views/graph-layout.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { INDEX_CELLS } from "../pipeline/index-cells.js";
import { layoutCells } from "./graph-layout.js";

describe("layoutCells", () => {
  it("layers the index pipeline and marks fts-index and vector-index as independent", () => {
    const layers = layoutCells(INDEX_CELLS);
    expect(layers.map((l) => l.map((c) => c.id))).toEqual([["split"], ["summarize"], ["fts-index", "vector-index"]]);
    const fts = layers[2]?.find((c) => c.id === "fts-index");
    expect(fts?.independentOf).toEqual(["vector-index"]);
    expect(layers[0]?.[0]?.independentOf).toEqual([]);
  });

  it("puts a cell after the deepest of its producers", () => {
    const layers = layoutCells([
      { id: "a", inputs: ["src"], outputs: ["x"] },
      { id: "b", inputs: ["x"], outputs: ["y"] },
      { id: "c", inputs: ["x", "y"], outputs: ["z"] },
    ]);
    expect(layers.map((l) => l.map((c) => c.id))).toEqual([["a"], ["b"], ["c"]]);
  });
});
```

- [ ] **Step 2: Run it and see it fail** — `pnpm --filter @statewalker/webrun-cells-demo test`; expected FAIL: cannot resolve `./graph-layout.js`.

- [ ] **Step 3: Implement `layoutCells`** — producer map signal → cell; layer(cell) = 0 if no input has a producer, else 1 + max(layer(producer)); group by layer preserving input order; `independentOf` = ids of other cells whose sorted inputs equal this cell's, in input order.

- [ ] **Step 4: Run it and see it pass.**

- [ ] **Step 5: Views**

- `graph-panel.tsx`: two sections, "Indexing" (cells whose layer-0 ancestor reads `files`) and "Questions" (the rest), each drawn as `layoutCells` columns of `Card`s left → right with "→" separators. A card shows id, `inputs → outputs`, a pending `Badge` from `snapshot.pending[id] ?? 0`, a ring + pulse when `snapshot.running?.cell === id` (with the running key underneath), and an "independent of X" note from `independentOf`. Under the Indexing section, one muted line: "fts-index and vector-index are independent: they could run in parallel; this engine runs one input at a time."
- `log-panel.tsx`: `ScrollArea` with the last 200 `snapshot.log` entries, newest at the bottom, auto-scrolling; one line each: type badge (start/done/fail coloured), cell, key, error text for fails.
- `inspector-panel.tsx`: for a file selection, loads `model.inspectFile(path)` whenever the snapshot changes (debounced to the end of a run, i.e. when `busy` turns false, plus once on selection) and renders sections: Text, Blocks (numbered), Block summaries, File summary, FTS terms (top 8 terms per block as badges), Vectors (a 16×16 heat grid per block). For a question: Question, Sub-queries, Candidates (two side-by-side lists titled "Full-text" and "Vector", labelled independent), Reranked, Context, Answer with citation badges that select the cited file on click, and a "Ask again" button calling `model.reask(id)`.
- `ask-bar.tsx`: `Input` + submit `Button`; submit calls `model.ask(text)` and selects the returned question id; a row of previous questions (`snapshot.questions`) as clickable badges.
- `app.tsx`: put the graph panel above the log panel in the middle column; inspector on the right; ask bar at the bottom.

- [ ] **Step 6: Verify and commit**

```bash
pnpm --filter @statewalker/webrun-cells-demo test
pnpm --filter @statewalker/webrun-cells-demo build
pnpm --filter @statewalker/webrun-cells-demo typecheck
pnpm biome check --write --unsafe apps/webrun-cells-demo
git add apps/webrun-cells-demo
git commit -m "feat(webrun-cells-demo): graph, log, inspector and ask bar"
```

---

### Task 7: README and whole-repo gates

**Files:**
- Create: `apps/webrun-cells-demo/README.md`

- [ ] **Step 1: README** — operating-manual shape (the user's README rules): What it is; Layout (src/engine, src/pipeline, src/model, src/views); How to run it (`pnpm install`, `pnpm --filter "@statewalker/webrun-cells-demo^..." run build`, `pnpm --filter @statewalker/webrun-cells-demo dev`, open `http://localhost:5180`); Why it is the way it is (real engine not a simulation; fakes are deterministic so early cut-off is observable; the coarse summarize cell and the shared search cell exist because the engine has no aggregation or joins yet; one engine, no parallelism); What will surprise you (answers are a snapshot at ask time — use "Ask again"; inserting a paragraph shifts block numbers so every later block re-indexes; the queue counts read `cells_pending` directly; a page reload resets the database; if `sqlite3.wasm` is missing from `dist/` the page stays blank and the console shows the wasm fetch 404); Reference (scripts, signals and cells table). Headings are claims, not labels. No references to notes, plans, specs or history. Run every command in it before committing.

- [ ] **Step 2: Whole-repo gates**

```bash
pnpm -r run build
pnpm test
pnpm typecheck
pnpm biome check .
```

Expected: all pass; the root test count grows by this app's tests only.

- [ ] **Step 3: Commit**

```bash
git add apps/webrun-cells-demo/README.md
git commit -m "docs(webrun-cells-demo): README"
```
