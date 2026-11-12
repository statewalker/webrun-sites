/**
 * Static-pipeline benchmark against the existing `@statewalker/webrun-cells`
 * engine (which has no dynamic reads or reduce cells), all on node:sqlite
 * in memory, so wall times are comparable.
 *
 *   pnpm tsx bench/static.ts 2000
 */
import { DatabaseSync } from "node:sqlite";
import { type Cell, CellEngine } from "@statewalker/webrun-cells";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { double, len, rng, split, upper } from "../src/core/fixtures.js";
import { MemKV } from "../src/core/kv.js";
import { SqlKV } from "../src/core/sql-kv.js";
import type { CellDef, Json } from "../src/core/types.js";
import { QueueEngine } from "../src/prototypes/queue.js";

const CELLS: CellDef[] = [split, upper, len, double];
const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu".split(" ");

/** Adapt a lab map cell (single input, reads only its own key) to webrun-cells. */
function toCellsCell(c: CellDef): Cell {
  return {
    id: c.id,
    inputs: c.inputs,
    outputs: c.outputs,
    async *run(inputs) {
      for await (const input of inputs) {
        const out: { signal: string; key: string; value: Json }[] = [];
        await c.run({
          key: input.key,
          get: async (s, k) => (s === input.signal && k === input.key ? input.value : undefined),
          list: async () => {
            throw new Error("unsupported");
          },
          emit: (signal, key, value) => out.push({ signal, key, value }),
        });
        yield* out;
      }
    },
  };
}

interface Target {
  label: string;
  put(k: string, v: string): Promise<void>;
  remove(k: string): Promise<void>;
  run(): Promise<number>;
}

function targets(): Target[] {
  const sqlite = () => new NodeSqlDriver(new DatabaseSync(":memory:"));
  const cells = new CellEngine({ db: sqlite(), cells: CELLS.map(toCellsCell), batchSize: 64 });
  const bSql = new QueueEngine({ kv: new SqlKV(sqlite()), cells: CELLS });
  const bMem = new QueueEngine({ kv: new MemKV(), cells: CELLS });
  return [
    {
      label: "webrun-cells (SQLite)",
      put: (k, v) => cells.put("docs", k, v),
      remove: (k) => cells.remove("docs", k),
      run: async () => (await cells.run()).committed,
    },
    {
      label: "B queue (SQLite)",
      put: (k, v) => bSql.put("docs", k, v),
      remove: (k) => bSql.remove("docs", k),
      run: async () => (await bSql.run()).executed,
    },
    {
      label: "B queue (MemKV)",
      put: (k, v) => bMem.put("docs", k, v),
      remove: (k) => bMem.remove("docs", k),
      run: async () => (await bMem.run()).executed,
    },
  ];
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 2000);
  const rand = rng(7);
  const docs = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    docs.set(
      `d${String(i).padStart(6, "0")}`,
      Array.from({ length: 4 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(" "),
    );
  }
  const keys = [...docs.keys()];
  const scenarios: [string, (t: Target) => Promise<void>][] = [
    [
      "cold build",
      async (t) => {
        for (const [k, v] of docs) await t.put(k, v);
      },
    ],
    ["no-op rebuild", async () => {}],
    ["edit 1 doc", async (t) => t.put(keys[5] as string, "one two three omega")],
    [
      "edit 1% docs",
      async (t) => {
        for (const k of keys.filter((_, i) => i % 100 === 3)) await t.put(k, `x ${k}`);
      },
    ],
    ["delete 1 doc", async (t) => t.remove(keys[9] as string)],
  ];
  const lines = [`# Static pipeline (split → upper, len → double), N=${n}`, ""];
  lines.push("| scenario | engine | committed tasks | ms |", "|---|---|---|---|");
  const ts = targets();
  for (const [name, op] of scenarios) {
    for (const t of ts) {
      const t0 = performance.now();
      await op(t);
      const done = await t.run();
      lines.push(`| ${name} | ${t.label} | ${done} | ${(performance.now() - t0).toFixed(1)} |`);
    }
  }
  console.log(lines.join("\n"));
}

await main();
