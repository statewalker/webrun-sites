/**
 * Static-pipeline benchmark on node:sqlite (in memory) vs MemKV: prototype B
 * and the real engine (`@statewalker/webrun-builder`), so wall times on a real
 * database are comparable. (The removed `webrun-builders` engine was measured here
 * before it was deleted; see README.)
 *
 *   pnpm tsx bench/static.ts 2000
 */
import { DatabaseSync } from "node:sqlite";
import { BuildEngine, SqlKV as RealSqlKV } from "@statewalker/webrun-builder";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { double, len, rng, split, upper } from "../src/core/fixtures.js";
import { MemKV } from "../src/core/kv.js";
import { SqlKV } from "../src/core/sql-kv.js";
import type { BuilderDef } from "../src/core/types.js";
import { QueueEngine } from "../src/prototypes/queue.js";

const BUILDERS: BuilderDef[] = [split, upper, len, double];
const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu".split(" ");

interface Target {
  label: string;
  put(k: string, v: string): Promise<unknown>;
  remove(k: string): Promise<unknown>;
  run(): Promise<number>;
}

function targets(): Target[] {
  const sqlite = () => new NodeSqlDriver(new DatabaseSync(":memory:"));
  const bSql = new QueueEngine({ kv: new SqlKV(sqlite()), builders: BUILDERS });
  const bMem = new QueueEngine({ kv: new MemKV(), builders: BUILDERS });
  const rSql = new BuildEngine({ store: new RealSqlKV(sqlite()), builders: BUILDERS });
  return [
    {
      label: "webrun-builder (SQLite)",
      put: (k, v) => rSql.put("docs", k, v),
      remove: (k) => rSql.remove("docs", k),
      run: async () => (await rSql.run()).executed,
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
  const scenarios: [string, (t: Target) => Promise<unknown>][] = [
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
