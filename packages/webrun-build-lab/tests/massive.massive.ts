/**
 * Massive tests: large random graphs, large volumes, crash storms and extreme
 * shapes. Run with `pnpm test:massive`; scale with `MASSIVE_SCALE=2` (or more).
 *
 * Every engine is checked against the full-recompute oracle, and all engines
 * are checked against each other: for the same edit they must execute exactly
 * the same number of tasks (all are minimal, so any difference is a bug).
 */
import { DatabaseSync } from "node:sqlite";
import { BuildEngine, FilesKV, SqlKV } from "@statewalker/webrun-builder";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { recorded, recorder, rng, snapshot } from "../src/core/fixtures.js";
import { CrashError, CrashingKV, type KV, MemKV } from "../src/core/kv.js";
import { hash, type RandomGraph, randomGraph } from "../src/core/random-graph.js";
import type { CellDef, Engine, EngineFactory, Json } from "../src/core/types.js";
import { CursorEngine } from "../src/prototypes/cursors.js";
import { NaiveEngine } from "../src/prototypes/naive.js";
import { QueueEngine } from "../src/prototypes/queue.js";
import { TraceEngine } from "../src/prototypes/traces.js";

const SCALE = Number(process.env.MASSIVE_SCALE ?? 1);
const n = (x: number) => Math.max(1, Math.round(x * SCALE));
const T = 30 * 60_000; // per-test timeout

const ENGINES: Record<string, EngineFactory> = {
  "A cursors": (o) => new CursorEngine(o),
  "B queue": (o) => new QueueEngine(o),
  "C traces": (o) => new TraceEngine(o),
  "R builder": (o) => new BuildEngine({ store: o.kv, cells: o.cells, concurrency: 4 }),
};

async function drain(engine: Engine): Promise<number> {
  let executed = 0;
  for (;;) {
    const s = await engine.run();
    executed += s.executed;
    if (!s.pending) return executed;
  }
}

type Edit = ReturnType<RandomGraph["edit"]>;

async function apply(engine: Engine, edits: Edit[]): Promise<void> {
  for (const e of edits) {
    if (e.op === "put") await engine.put(e.signal, e.key, e.value);
    else await engine.remove(e.signal, e.key);
  }
}

/**
 * Keep the last edit per row. Within one round, "remove k, then put k back
 * with its old value" is a net no-op that the eager queue still re-runs (and
 * cuts off) while the others may skip; with one edit per row, every engine's
 * minimal task count is the same and can be compared exactly. The net-no-op
 * case is covered (for correctness) by the crash-storm phases, which do not
 * dedupe.
 */
function oncePerKey(edits: Edit[]): Edit[] {
  const last = new Map<string, Edit>();
  for (const e of edits) last.set(`${e.signal}/${e.key}`, e);
  return [...last.values()];
}

function initialRows(g: RandomGraph, keys: number, seed: number): Edit[] {
  const rand = rng(seed);
  const out: Edit[] = [];
  for (const signal of g.sources) {
    for (let i = 0; i < keys; i++) {
      if (rand() < 0.7) out.push({ op: "put", signal, key: g.keyAt(i), value: `v${i % 97}` });
    }
  }
  return out;
}

describe("massive — random graphs", () => {
  const specs = [
    { seed: 11, sources: 3, cells: n(30), keys: n(600) },
    { seed: 12, sources: 5, cells: n(60), keys: n(300) },
  ];

  for (const spec of specs) {
    it(
      `${spec.cells} cells × ${spec.keys} keys × ${spec.sources} sources (seed ${spec.seed}): ` +
        "every engine equals the oracle and all execute the same tasks",
      async () => {
        const g = randomGraph(spec);
        const oracle = new NaiveEngine({ kv: new MemKV(), cells: g.cells });
        const engines = Object.entries(ENGINES).map(([name, f]) => ({
          name,
          engine: f({ kv: new MemKV(), cells: g.cells }),
        }));
        const rand = rng(spec.seed * 7);
        const rounds: Edit[][] = [initialRows(g, spec.keys, spec.seed)];
        for (const size of [1, 1, 5, 20, 1, 100, 3, 400, 1, 50]) {
          rounds.push(oncePerKey(Array.from({ length: n(size) }, () => g.edit(rand))));
        }
        let totalTasks = 0;
        for (const [i, edits] of rounds.entries()) {
          await apply(oracle, edits);
          await oracle.run();
          const counts: Record<string, number> = {};
          for (const { name, engine } of engines) {
            await apply(engine, edits);
            counts[name] = await drain(engine);
          }
          const values = Object.values(counts);
          expect(new Set(values).size, `round ${i}: ${JSON.stringify(counts)}`).toBe(1);
          totalTasks += values[0] ?? 0;
          if (i === 0 || i % 3 === 0 || i === rounds.length - 1) {
            const want = await snapshot(oracle, g.derived);
            for (const { name, engine } of engines) {
              expect(await snapshot(engine, g.derived), `${name} round ${i}`).toEqual(want);
            }
          }
        }
        expect(totalTasks).toBeGreaterThan(spec.keys); // the graph really did work
      },
      T,
    );
  }
});

describe("massive — crash storms", () => {
  const spec = { seed: 21, sources: 3, cells: n(25), keys: n(400) };

  for (const [name, factory] of [
    [
      "R builder (batch 16)",
      (kv: KV, cells: CellDef[]) => new BuildEngine({ store: kv, cells, batchSize: 16 }),
    ],
    ["B queue", (kv: KV, cells: CellDef[]) => new QueueEngine({ kv, cells })],
    ["A cursors", (kv: KV, cells: CellDef[]) => new CursorEngine({ kv, cells })],
    ["C traces", (kv: KV, cells: CellDef[]) => new TraceEngine({ kv, cells })],
  ] as const) {
    it(
      `${name}: repeated crashes at random commits during cold and incremental builds converge to the oracle`,
      async () => {
        const g = randomGraph(spec);
        const rand = rng(99);
        const oracle = new NaiveEngine({ kv: new MemKV(), cells: g.cells });
        const kv = new MemKV();
        let crashes = 0;
        let executed = 0;
        const phases: Edit[][] = [
          initialRows(g, spec.keys, 5),
          Array.from({ length: n(200) }, () => g.edit(rand)),
          Array.from({ length: n(20) }, () => g.edit(rand)),
        ];
        for (const edits of phases) {
          await apply(oracle, edits);
          await oracle.run();
          await apply(factory(kv, g.cells), edits);
          // Crash again and again until one process finishes the build.
          for (;;) {
            const rec = recorder();
            const crashing = factory(
              new CrashingKV(kv, 1 + Math.floor(rand() * 40)),
              recorded(rec, g.cells),
            );
            try {
              executed += await drain(crashing);
              break;
            } catch (error) {
              expect(error).toBeInstanceOf(CrashError);
              crashes++;
            }
          }
          expect(await snapshot(factory(kv, g.cells), g.derived)).toEqual(
            await snapshot(oracle, g.derived),
          );
          // A finished store has nothing left to do.
          expect(await drain(factory(kv, g.cells))).toBe(0);
        }
        expect(crashes).toBeGreaterThan(5);
        expect(executed).toBeGreaterThan(0);
      },
      T,
    );
  }
});

describe("massive — volumes on real stores", () => {
  it(
    "R over SQLite and over FilesKV equals R over MemKV on a large graph; reopening resumes with no work",
    async () => {
      const g = randomGraph({ seed: 31, sources: 4, cells: n(40), keys: n(1500) });
      const rand = rng(3);
      const edits = [
        initialRows(g, n(1500), 31),
        ...Array.from({ length: 4 }, () => Array.from({ length: n(300) }, () => g.edit(rand))),
      ];
      const files = new MemFilesApi();
      const stores: [string, () => Promise<KV>][] = [
        ["mem", async () => new MemKV()],
        ["sql", async () => new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:")))],
        ["files", () => FilesKV.open(files, "state", { compactEvery: 64 })],
      ];
      const snaps: Record<string, unknown> = {};
      for (const [name, open] of stores) {
        const engine = new BuildEngine({ store: await open(), cells: g.cells, batchSize: 128 });
        for (const round of edits) {
          await apply(engine, round);
          await drain(engine);
        }
        snaps[name] = await snapshot(engine, g.derived);
      }
      expect(snaps.sql).toEqual(snaps.mem);
      expect(snaps.files).toEqual(snaps.mem);
      // A new process over the persisted files: same state, nothing to do.
      const reopened = new BuildEngine({
        store: await FilesKV.open(files, "state"),
        cells: g.cells,
      });
      expect(await drain(reopened)).toBe(0);
      expect(await snapshot(reopened, g.derived)).toEqual(snaps.mem);
    },
    T,
  );
});

describe("massive — extreme shapes (R builder)", () => {
  const make = (cells: CellDef[]) => new BuildEngine({ store: new MemKV(), cells, batchSize: 256 });

  it(
    "a deep chain: one edit at the source runs exactly one task per stage",
    async () => {
      const depth = n(150);
      const keys = n(500);
      const cells: CellDef[] = Array.from({ length: depth }, (_, i) => {
        const input = i === 0 ? "src" : `s${i - 1}`;
        const out = `s${i}`;
        return {
          id: `c${i}`,
          inputs: [input],
          outputs: [out],
          async run(ctx) {
            // A fresh hash per stage: every stage really changes (no cut-off).
            ctx.emit(out, ctx.key, `${i}:${hash(String(await ctx.get(input, ctx.key)))}`);
          },
        };
      });
      const rec = recorder();
      const engine = make(recorded(rec, cells));
      for (let k = 0; k < keys; k++) await engine.put("src", `k${k}`, `v${k}`);
      expect(await drain(engine)).toBe(depth * keys);
      rec.reset();
      await engine.put("src", "k7", "changed");
      expect(await drain(engine)).toBe(depth);
      expect(new Set(rec.log.map((e) => e.split("/")[1]))).toEqual(new Set(["k7"]));
      let want = "changed";
      for (let i = 0; i < depth; i++) want = `${i}:${hash(want)}`;
      expect(await engine.get(`s${depth - 1}`, "k7")).toBe(want);
    },
    T,
  );

  it(
    "a wide fan-out/fan-in: hundreds of cells over one source, one reduce over all of them",
    async () => {
      const width = n(300);
      const keys = n(200);
      const branches: CellDef[] = Array.from({ length: width }, (_, i) => ({
        id: `b${i}`,
        inputs: ["src"],
        outputs: [`w${i}`],
        async run(ctx) {
          ctx.emit(`w${i}`, ctx.key, `${i}:${await ctx.get("src", ctx.key)}`);
        },
      }));
      const total: CellDef = {
        id: "total",
        kind: "reduce",
        inputs: branches.map((_, i) => `w${i}`),
        outputs: ["total"],
        async run(ctx) {
          let count = 0;
          for (const s of ctx.key === "*" ? branches.map((_, i) => `w${i}`) : []) {
            count += (await ctx.list(s)).length;
          }
          ctx.emit("total", "count", count);
        },
      };
      const rec = recorder();
      const engine = make(recorded(rec, [total, ...branches]));
      for (let k = 0; k < keys; k++) await engine.put("src", `k${k}`, k);
      await drain(engine);
      expect(await engine.get("total", "count")).toBe(width * keys);
      expect(rec.count("total")).toBe(1); // glitch-free: once, after every branch
      rec.reset();
      await engine.remove("src", "k0");
      await drain(engine);
      expect(await engine.get("total", "count")).toBe(width * (keys - 1));
      expect(rec.log).toEqual(["total/*"]); // dead branch tasks retract without running
    },
    T,
  );

  it(
    "a huge fan-out from one key, then a shrink: retraction cascades through tens of thousands of rows",
    async () => {
      const size = n(20000);
      const explode: CellDef = {
        id: "explode",
        inputs: ["src"],
        outputs: ["parts"],
        async run(ctx) {
          const count = Number(await ctx.get("src", ctx.key));
          for (let i = 0; i < count; i++)
            ctx.emit("parts", `${ctx.key}#${String(i).padStart(6, "0")}`, i);
        },
      };
      const square: CellDef = {
        id: "square",
        inputs: ["parts"],
        outputs: ["squares"],
        async run(ctx) {
          const v = Number(await ctx.get("parts", ctx.key));
          ctx.emit("squares", ctx.key, v * v);
        },
      };
      const engine = make([explode, square]);
      await engine.put("src", "big", size);
      expect(await drain(engine)).toBe(1 + size);
      expect((await engine.keys("squares")).length).toBe(size);
      await engine.put("src", "big", 10);
      // explode once + (size - 10) dead square tasks retracted.
      expect(await drain(engine)).toBe(1 + size - 10);
      expect((await engine.keys("squares")).length).toBe(10);
      expect(await engine.status()).toEqual({ queued: {}, deadLetters: 0 });
    },
    T,
  );

  it(
    "many independent sources × many keys: a 1% edit touches only the edited keys' tasks",
    async () => {
      const sources = n(20);
      const keys = n(1000);
      const cells: CellDef[] = Array.from({ length: sources }, (_, i) => ({
        id: `m${i}`,
        inputs: [`src${i}`],
        outputs: [`out${i}`],
        async run(ctx) {
          ctx.emit(`out${i}`, ctx.key, String(await ctx.get(`src${i}`, ctx.key)).length);
        },
      }));
      const engine = make(cells);
      for (let s = 0; s < sources; s++) {
        for (let k = 0; k < keys; k++) await engine.put(`src${s}`, `k${k}`, "x".repeat(k % 7));
      }
      expect(await drain(engine)).toBe(sources * keys);
      const edits = Math.ceil((sources * keys) / 100);
      for (let e = 0; e < edits; e++) {
        await engine.put(`src${e % sources}`, `k${(e * 37) % keys}`, `edited-${e}`);
      }
      const ran = await drain(engine);
      expect(ran).toBeLessThanOrEqual(edits);
      expect(ran).toBeGreaterThan(edits * 0.9);
    },
    T,
  );
});

export type { Json };
