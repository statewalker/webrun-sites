/**
 * Benchmark: the same workload and edit scenarios over every prototype.
 *
 *   pnpm bench                 # N=1000
 *   pnpm bench -- 5000 a,b,c   # N and a subset of engines
 *
 * Per scenario it records task executions, KV I/O (gets, scans, rows scanned,
 * commits, rows written/deleted, bytes written) and wall time, from the first
 * source write to the end of the run that converges — fan-out done at write
 * time is charged to the scenario. Each engine's final state is checked
 * against the naive engine's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundle,
  compile,
  double,
  len,
  type Mod,
  rng,
  snapshot,
  split,
  stats,
  upper,
} from "../src/core/fixtures.js";
import { type KvMetrics, MemKV } from "../src/core/kv.js";
import type { CellDef, Engine, EngineFactory, Json } from "../src/core/types.js";
import { NaiveEngine } from "../src/prototypes/naive.js";
import { QueueEngine } from "../src/prototypes/queue.js";

const ENGINES: Record<string, { label: string; load: () => Promise<EngineFactory> }> = {
  p0: { label: "P0 naive", load: async () => (o) => new NaiveEngine(o) },
  a: {
    label: "A cursors",
    load: async () => {
      const m = await import("../src/prototypes/cursors.js");
      return (o) => new m.CursorEngine(o);
    },
  },
  b: { label: "B queue", load: async () => (o) => new QueueEngine(o) },
  r: {
    label: "R webrun-builder",
    load: async () => {
      const m = await import("@statewalker/webrun-builder");
      return (o) => new m.BuildEngine({ store: o.kv, cells: o.cells, maxAttempts: o.maxAttempts });
    },
  },
  c: {
    label: "C traces",
    load: async () => {
      const m = await import("../src/prototypes/traces.js");
      return (o) => new m.TraceEngine(o);
    },
  },
};

const CELLS: CellDef[] = [split, upper, len, double, stats, compile, bundle];
const SIGNALS = ["chunks", "upper", "len", "len2", "stats", "compiled", "bundle"];
const WORDS = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu".split(" ");

interface Workload {
  docs: Map<string, string>;
  mods: Map<string, Mod>;
}

function workload(n: number, seed = 42): Workload {
  const rand = rng(seed);
  const pick = () => WORDS[Math.floor(rand() * WORDS.length)] as string;
  const docs = new Map<string, string>();
  const mods = new Map<string, Mod>();
  const hubs = Math.max(1, Math.floor(n / 50));
  for (let i = 0; i < n; i++) {
    const key = `d${String(i).padStart(6, "0")}`;
    docs.set(key, Array.from({ length: 4 }, pick).join(" "));
    const m = `m${String(i).padStart(6, "0")}`;
    const imports = new Set<string>();
    // Every module imports one hub (shared, widely imported) and one random module.
    if (i >= hubs) imports.add(`m${String(Math.floor(rand() * hubs)).padStart(6, "0")}`);
    const other = `m${String(Math.floor(rand() * n)).padStart(6, "0")}`;
    if (other !== m) imports.add(other);
    mods.set(m, { code: `code${i}`, imports: [...imports] });
  }
  return { docs, mods };
}

type Op = (e: Engine) => Promise<void>;
interface Scenario {
  name: string;
  ops: Op;
}

function scenarios(w: Workload): Scenario[] {
  const docKeys = [...w.docs.keys()];
  const modKeys = [...w.mods.keys()];
  const d0 = docKeys[Math.floor(docKeys.length / 2)] as string;
  const pct = docKeys.filter((_, i) => i % 100 === 7);
  return [
    {
      name: "cold build",
      ops: async (e) => {
        for (const [k, v] of w.docs) await e.put("docs", k, v);
        for (const [k, v] of w.mods) await e.put("mods", k, v as unknown as Json);
      },
    },
    { name: "no-op rebuild", ops: async () => {} },
    {
      name: "edit 1 doc (1 word)",
      ops: async (e) => {
        const words = (w.docs.get(d0) as string).split(" ");
        words[3] = "omega";
        await e.put("docs", d0, words.join(" "));
      },
    },
    {
      name: "edit 1 doc (cut-off)",
      ops: async (e) => {
        // Same length: len/len2/stats are cut off; only chunk #0 changes.
        const words = (w.docs.get(docKeys[1] as string) as string).split(" ");
        words[0] = (words[0] as string).split("").reverse().join("");
        await e.put("docs", docKeys[1] as string, words.join(" "));
      },
    },
    {
      name: "edit 1% docs",
      ops: async (e) => {
        for (const k of pct) await e.put("docs", k, `changed ${k} text here`);
      },
    },
    {
      name: "delete 1 doc",
      ops: async (e) => {
        await e.remove("docs", docKeys[2] as string);
      },
    },
    {
      name: "edit leaf module",
      ops: async (e) => {
        const k = modKeys.at(-1) as string;
        await e.put("mods", k, { ...(w.mods.get(k) as Mod), code: "leaf2" } as unknown as Json);
      },
    },
    {
      name: "edit hub module",
      ops: async (e) => {
        const k = modKeys[0] as string;
        await e.put("mods", k, { ...(w.mods.get(k) as Mod), code: "hub2" } as unknown as Json);
      },
    },
  ];
}

interface Row extends KvMetrics {
  engine: string;
  scenario: string;
  executed: number;
  ms: number;
}

async function bench(name: string, factory: EngineFactory, w: Workload): Promise<Row[]> {
  const kv = new MemKV();
  const engine = factory({ kv, cells: CELLS });
  const rows: Row[] = [];
  for (const sc of scenarios(w)) {
    kv.resetMetrics();
    const t0 = performance.now();
    await sc.ops(engine);
    let executed = 0;
    for (;;) {
      const s = await engine.run();
      executed += s.executed;
      if (!s.pending) break;
    }
    const ms = performance.now() - t0;
    rows.push({ engine: name, scenario: sc.name, executed, ms, ...kv.metrics });
  }
  return rows;
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 1000);
  const which = (process.argv[3] ?? "p0,a,b,c,r").split(",");
  const w = workload(n);
  const all: Row[] = [];
  const sizes: Record<string, { rows: number; bytes: number }> = {};
  let reference: unknown;
  for (const id of which) {
    const spec = ENGINES[id];
    if (!spec) throw new Error(`unknown engine ${id}`);
    let factory: EngineFactory;
    try {
      factory = await spec.load();
    } catch (error) {
      console.error(`skip ${spec.label}: ${(error as Error).message}`);
      continue;
    }
    const rows = await bench(spec.label, factory, w);
    all.push(...rows);
    // Final-state check against P0 over a fresh run of the same scenarios.
    const kv = new MemKV();
    const e = factory({ kv, cells: CELLS });
    for (const sc of scenarios(w)) {
      await sc.ops(e);
      while ((await e.run()).pending) {}
    }
    const snap = JSON.stringify(await snapshot(e, SIGNALS));
    if (reference === undefined) reference = snap;
    else if (snap !== reference)
      console.error(`!! ${spec.label}: final state differs from reference`);
    sizes[spec.label] = {
      rows: kv.size,
      bytes: kv.dump().reduce((a, [k, v]) => a + k.length + v.length, 0),
    };
  }

  const cols: [string, (r: Row) => string][] = [
    ["engine", (r) => r.engine],
    ["exec", (r) => String(r.executed)],
    ["gets", (r) => String(r.gets)],
    ["scans", (r) => String(r.scans)],
    ["scanned", (r) => String(r.rowsScanned)],
    ["commits", (r) => String(r.commits)],
    ["written", (r) => String(r.rowsWritten + r.rowsDeleted)],
    ["KB written", (r) => (r.bytesWritten / 1024).toFixed(1)],
    ["ms", (r) => r.ms.toFixed(1)],
  ];
  const out: string[] = [`# Benchmark — N=${n} docs + ${n} modules`, ""];
  for (const sc of scenarios(w)) {
    out.push(`## ${sc.name}`, "", `| ${cols.map((c) => c[0]).join(" | ")} |`);
    out.push(`|${cols.map(() => "---").join("|")}|`);
    for (const r of all.filter((x) => x.scenario === sc.name)) {
      out.push(`| ${cols.map((c) => c[1](r)).join(" | ")} |`);
    }
    out.push("");
  }
  out.push("## Stored state after all scenarios", "", "| engine | rows | KB |", "|---|---|---|");
  for (const [label, s] of Object.entries(sizes)) {
    out.push(`| ${label} | ${s.rows} | ${(s.bytes / 1024).toFixed(1)} |`);
  }
  const text = out.join("\n");
  console.log(text);
  const dir = join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `bench-${n}.md`), `${text}\n`);
  writeFileSync(join(dir, `bench-${n}.json`), JSON.stringify({ n, rows: all, sizes }, null, 2));
}

await main();
