/**
 * The conformance suite every prototype must pass. `defineConformance(name,
 * factory)` registers it for one engine. Expected states come from the naive
 * full-recompute engine (P0), which is the reference semantics.
 */
import { describe, expect, it } from "vitest";
import {
  bundle,
  compile,
  double,
  join,
  left,
  len,
  type Mod,
  recorded,
  recorder,
  right,
  rng,
  snapshot,
  split,
  stats,
  upper,
} from "../src/core/fixtures.js";
import { CrashError, CrashingKV, type KV, MemKV } from "../src/core/kv.js";
import type { BuilderDef, Engine, EngineFactory, Json } from "../src/core/types.js";
import { NaiveEngine } from "../src/prototypes/naive.js";

const ALL_BUILDERS = [split, upper, len, double, stats, left, right, join, compile, bundle];
const ALL_COLLECTIONS = [
  "chunks",
  "upper",
  "len",
  "len2",
  "stats",
  "l",
  "r",
  "j",
  "compiled",
  "bundle",
];

type Sources = Map<string, Map<string, Json>>;

async function apply(engine: Engine, sources: Sources): Promise<void> {
  for (const [collection, rows] of sources) {
    for (const [key, value] of rows) await engine.put(collection, key, value);
  }
}

/** The reference state for `sources` under `builders`. */
async function expected(builders: BuilderDef[], sources: Sources, collections = ALL_COLLECTIONS) {
  const ref = new NaiveEngine({ kv: new MemKV(), builders });
  await apply(ref, sources);
  await ref.run();
  return snapshot(ref, collections);
}

async function drain(engine: Engine): Promise<number> {
  let executed = 0;
  for (let i = 0; i < 1000; i++) {
    const s = await engine.run();
    executed += s.executed;
    if (!s.pending) return executed;
  }
  throw new Error("engine did not converge");
}

const mod = (code: string, imports: string[] = []): Json => ({ code, imports });

export function defineConformance(
  name: string,
  factory: EngineFactory,
  newKv: () => KV & { metrics: { commits: number } } = () => new MemKV(),
): void {
  const make = (builders: BuilderDef[], kv: KV = newKv(), maxAttempts?: number) =>
    factory({ kv, builders, maxAttempts });

  describe(`${name} — conformance`, () => {
    describe("cascade", () => {
      it("converges a chain in one run, then a second run executes nothing", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [upper, split]));
        await engine.put("docs", "a", "hello world");
        const s1 = await engine.run();
        expect(s1.pending).toBe(false);
        expect(await engine.list("upper")).toEqual([
          { key: "a#0", value: "HELLO" },
          { key: "a#1", value: "WORLD" },
        ]);
        expect(rec.log.sort()).toEqual(["split/a", "upper/a#0", "upper/a#1"]);
        rec.reset();
        const s2 = await engine.run();
        expect(s2.executed).toBe(0);
        expect(rec.log).toEqual([]);
      });

      it("ignores a put of an unchanged value (object key order included)", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [len]));
        await engine.put("docs", "a", "xyz");
        await engine.run();
        rec.reset();
        await engine.put("docs", "a", "xyz");
        await engine.run();
        expect(rec.log).toEqual([]);

        const engine2 = make(recorded(rec, [len]));
        await engine2.put("docs", "o", { a: 1, b: 2 } as unknown as Json);
        await engine2.run();
        rec.reset();
        await engine2.put("docs", "o", { b: 2, a: 1 } as unknown as Json);
        await engine2.run();
        expect(rec.log).toEqual([]);
      });

      it("re-executes only the tasks whose reads changed", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [split, upper]));
        await engine.put("docs", "a", "x y");
        await engine.put("docs", "b", "p q");
        await engine.run();
        rec.reset();
        await engine.put("docs", "a", "x z");
        await engine.run();
        // a#0 is still "x": upper/a#0 is cut off; docs/b is untouched.
        expect(rec.log.sort()).toEqual(["split/a", "upper/a#1"]);
        expect(await engine.get("upper", "a#1")).toBe("Z");
      });

      it("stops the cascade at an unchanged output (early cut-off)", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [len, double, stats]));
        await engine.put("docs", "a", "abc");
        await engine.put("docs", "b", "hello");
        await engine.run();
        rec.reset();
        await engine.put("docs", "a", "xyz"); // same length
        await engine.run();
        expect(rec.log).toEqual(["len/a"]);
        await engine.put("docs", "a", "wxyz");
        rec.reset();
        await engine.run();
        expect(rec.log.sort()).toEqual(["double/a", "len/a", "stats/*"]);
        expect(await engine.get("stats", "total")).toEqual({ count: 2, sum: 9 });
      });

      it("treats null as a value, not a deletion", async () => {
        const echo: BuilderDef = {
          id: "echo",
          inputs: ["docs"],
          outputs: ["out"],
          async run(ctx) {
            ctx.emit("out", ctx.key, (await ctx.get("docs", ctx.key)) as Json);
          },
        };
        const engine = make([echo]);
        await engine.put("docs", "a", null);
        await engine.run();
        expect(await engine.list("out")).toEqual([{ key: "a", value: null }]);
      });
    });

    describe("retraction", () => {
      it("removing a source retracts everything derived from it, transitively", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [split, upper, len, stats]));
        await engine.put("docs", "a", "hello world");
        await engine.put("docs", "b", "bye");
        await engine.run();
        rec.reset();
        await engine.remove("docs", "a");
        await engine.run();
        expect(await engine.list("chunks")).toEqual([{ key: "b#0", value: "bye" }]);
        expect(await engine.list("upper")).toEqual([{ key: "b#0", value: "BYE" }]);
        expect(await engine.list("len")).toEqual([{ key: "b", value: 3 }]);
        expect(await engine.get("stats", "total")).toEqual({ count: 1, sum: 3 });
        // Dead map tasks are retracted without calling the builder.
        expect(rec.log).toEqual(["stats/*"]);
      });

      it("retracts outputs a task no longer emits, and cascades the retraction", async () => {
        const engine = make([split, upper]);
        await engine.put("docs", "a", "one two three");
        await engine.run();
        await engine.put("docs", "a", "one");
        await engine.run();
        expect(await engine.list("chunks")).toEqual([{ key: "a#0", value: "one" }]);
        expect(await engine.list("upper")).toEqual([{ key: "a#0", value: "ONE" }]);
      });

      it("re-creating a removed source rebuilds its outputs", async () => {
        const engine = make([split, upper]);
        await engine.put("docs", "a", "x");
        await engine.run();
        await engine.remove("docs", "a");
        await engine.run();
        await engine.put("docs", "a", "x");
        await engine.run();
        expect(await engine.list("upper")).toEqual([{ key: "a#0", value: "X" }]);
      });

      it("rejects writes to derived collections", async () => {
        const engine = make([split]);
        await expect(engine.put("chunks", "a", 1)).rejects.toThrow(/not a source collection/);
        await expect(engine.remove("chunks", "a")).rejects.toThrow(/not a source collection/);
      });
    });

    describe("scheduling", () => {
      it("runs both sides of a diamond before the join, which runs once per key", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [join, right, left]));
        await engine.put("docs", "a", "x");
        await engine.run();
        expect(rec.log.slice(0, 2).sort()).toEqual(["left/a", "right/a"]);
        expect(rec.log.slice(2)).toEqual(["join/a"]);
        rec.reset();
        await engine.put("docs", "a", "y");
        await engine.run();
        expect(rec.count("join", "a")).toBe(1);
        expect(await engine.get("j", "a")).toBe("L(y)+R(y)");
      });

      it("a reduce builder runs once per run, after all its producers", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [stats, len]));
        for (const key of ["a", "b", "c", "d"]) await engine.put("docs", key, key.repeat(2));
        await engine.run();
        expect(rec.count("stats")).toBe(1);
        expect(rec.log.at(-1)).toBe("stats/*");
        expect(await engine.get("stats", "total")).toEqual({ count: 4, sum: 8 });
      });

      it("keeps a change that lands while its task runs, and converges to it", async () => {
        const seen: Json[] = [];
        let engine: Engine;
        const copy: BuilderDef = {
          id: "copy",
          inputs: ["docs"],
          outputs: ["out"],
          async run(ctx) {
            const v = (await ctx.get("docs", ctx.key)) as Json;
            seen.push(v);
            if (seen.length === 1) await engine.put("docs", "a", "v2");
            ctx.emit("out", ctx.key, v);
          },
        };
        engine = make([copy]);
        await engine.put("docs", "a", "v1");
        await drain(engine);
        expect(seen).toEqual(["v1", "v2"]);
        expect(await engine.get("out", "a")).toBe("v2");
      });

      it("can be interrupted after any task and resumed (maxTasks)", async () => {
        const builders = [split, upper, len, double, stats, left, right, join];
        const engine = make(builders);
        const sources: Sources = new Map([
          [
            "docs",
            new Map<string, Json>([
              ["a", "one two"],
              ["b", "three"],
              ["c", "four five six"],
            ]),
          ],
        ]);
        await apply(engine, sources);
        let runs = 0;
        for (;;) {
          runs++;
          const s = await engine.run({ maxTasks: 1 });
          expect(s.executed).toBeLessThanOrEqual(1);
          if (!s.pending) break;
          if (runs > 200) throw new Error("did not converge");
        }
        expect(runs).toBeGreaterThan(3);
        expect(await snapshot(engine, ALL_COLLECTIONS)).toEqual(await expected(builders, sources));
      });
    });

    describe("dynamic dependencies", () => {
      it("re-executes a task when a row it read dynamically changes, and only then", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [compile]));
        await engine.put("mods", "main", mod("M", ["util"]));
        await engine.put("mods", "util", mod("U1"));
        await engine.put("mods", "other", mod("O"));
        await engine.run();
        expect(await engine.get("compiled", "main")).toBe("M|util:U1");
        rec.reset();
        await engine.put("mods", "util", mod("U2"));
        await engine.run();
        expect(rec.log.sort()).toEqual(["compile/main", "compile/util"]);
        expect(await engine.get("compiled", "main")).toBe("M|util:U2");
        rec.reset();
        await engine.put("mods", "other", mod("O2"));
        await engine.run();
        expect(rec.log).toEqual(["compile/other"]);
      });

      it("follows a changed dependency set (drops old reads, adds new ones)", async () => {
        const rec = recorder();
        const engine = make(recorded(rec, [compile]));
        await engine.put("mods", "main", mod("M", ["a"]));
        await engine.put("mods", "a", mod("A"));
        await engine.put("mods", "b", mod("B"));
        await engine.run();
        await engine.put("mods", "main", mod("M", ["b"]));
        await engine.run();
        rec.reset();
        await engine.put("mods", "a", mod("A2"));
        await engine.run();
        expect(rec.log).toEqual(["compile/a"]);
        await engine.put("mods", "b", mod("B2"));
        rec.reset();
        await engine.run();
        expect(rec.log.sort()).toEqual(["compile/b", "compile/main"]);
        expect(await engine.get("compiled", "main")).toBe("M|b:B2");
      });

      it("tracks reads of rows that do not exist yet", async () => {
        const engine = make([compile]);
        await engine.put("mods", "main", mod("M", ["later"]));
        await engine.run();
        expect(await engine.get("compiled", "main")).toBe("M|later:missing");
        await engine.put("mods", "later", mod("L"));
        await engine.run();
        expect(await engine.get("compiled", "main")).toBe("M|later:L");
        await engine.remove("mods", "later");
        await engine.run();
        expect(await engine.get("compiled", "main")).toBe("M|later:missing");
      });

      it("orders a dynamic reader after the producers of what it reads", async () => {
        const engine = make([bundle, compile]);
        await engine.put("mods", "main", mod("M", ["util"]));
        await engine.put("mods", "util", mod("U"));
        await engine.run();
        expect(await engine.get("bundle", "main")).toBe("M|util:U ; U");
        await engine.put("mods", "util", mod("U2"));
        await engine.run();
        expect(await engine.get("bundle", "main")).toBe("M|util:U2 ; U2");
      });
    });

    describe("failures", () => {
      const flaky = (fail: (key: string, value: Json) => boolean): BuilderDef => ({
        id: "copy",
        inputs: ["docs"],
        outputs: ["out"],
        async run(ctx) {
          const v = (await ctx.get("docs", ctx.key)) as Json;
          if (fail(ctx.key, v)) throw new Error("boom");
          ctx.emit("out", ctx.key, v);
        },
      });

      it("retries a failing task, dead-letters it, and converges the rest", async () => {
        let calls = 0;
        const engine = make(
          [
            flaky((key) => {
              if (key !== "bad") return false;
              calls++;
              return true;
            }),
          ],
          newKv(),
          3,
        );
        await engine.put("docs", "good", 1);
        await engine.put("docs", "bad", 2);
        const s = await engine.run();
        expect(s).toMatchObject({ failed: 3, deadLettered: 1 });
        expect(calls).toBe(3);
        expect(await engine.list("out")).toEqual([{ key: "good", value: 1 }]);
        expect(await engine.deadLetters()).toEqual([
          { builder: "copy", key: "bad", attempts: 3, error: "Error: boom" },
        ]);
        const again = await engine.run();
        expect(again).toMatchObject({ executed: 0, failed: 0 });
      });

      it("keeps the previous outputs of a failing task; a new input value retries it", async () => {
        let broken = false;
        const engine = make([flaky(() => broken)], newKv(), 1);
        await engine.put("docs", "a", "v1");
        await engine.run();
        broken = true;
        await engine.put("docs", "a", "v2");
        await engine.run();
        expect(await engine.get("out", "a")).toBe("v1");
        expect(await engine.deadLetters()).toHaveLength(1);
        broken = false;
        await engine.put("docs", "a", "v3");
        await engine.run();
        expect(await engine.get("out", "a")).toBe("v3");
        expect(await engine.deadLetters()).toEqual([]);
      });

      it("fails a task that emits a row another task owns", async () => {
        const a: BuilderDef = {
          id: "a",
          inputs: ["docs"],
          outputs: ["out"],
          run: (ctx) => ctx.emit("out", "shared", ctx.key),
        };
        const engine = make([a], newKv(), 1);
        await engine.put("docs", "x", 1);
        await engine.put("docs", "y", 2);
        const s = await engine.run();
        expect(s.deadLettered).toBe(1);
        const [d] = await engine.deadLetters();
        expect(d?.error).toMatch(/ConflictingEmission/);
        expect(await engine.list("out")).toHaveLength(1);
      });

      it("rejects undeclared reads and emissions", async () => {
        const bad: BuilderDef = {
          id: "bad",
          inputs: ["docs"],
          outputs: ["out"],
          async run(ctx) {
            await ctx.get("secret", "x");
          },
        };
        const engine = make([bad], newKv(), 1);
        await engine.put("docs", "a", 1);
        await engine.run();
        expect((await engine.deadLetters())[0]?.error).toMatch(/undeclared/);
      });
    });

    describe("durability", () => {
      const builders = [split, upper, len, double, stats, left, right, join, compile, bundle];
      const sources: Sources = new Map<string, Map<string, Json>>([
        [
          "docs",
          new Map<string, Json>([
            ["a", "one two"],
            ["b", "three four"],
            ["c", "five"],
          ]),
        ],
        [
          "mods",
          new Map<string, Json>([
            ["main", mod("M", ["util", "lib"])],
            ["util", mod("U", ["lib"])],
            ["lib", mod("L")],
          ]),
        ],
      ]);

      it("state survives a new engine instance over the same store", async () => {
        const kv = newKv();
        const rec = recorder();
        const e1 = make(recorded(rec, builders), kv);
        await apply(e1, sources);
        await e1.run();
        rec.reset();
        const e2 = make(recorded(rec, builders), kv);
        expect((await e2.run()).executed).toBe(0);
        expect(rec.log).toEqual([]);
        await e2.put("docs", "c", "six");
        await e2.run();
        expect(rec.log.sort()).toEqual(
          [
            "double/c",
            "join/c",
            "left/c",
            "len/c",
            "right/c",
            "split/c",
            "stats/*",
            "upper/c#0",
          ].sort(),
        );
      });

      it("resumes after a crash at any commit and converges to the reference state", async () => {
        const want = await expected(builders, sources);
        // Count commits of a clean run to know the crash points.
        const probeKv = newKv();
        const probe = make(builders, probeKv);
        await apply(probe, sources);
        const before = probeKv.metrics.commits;
        const clean = await drain(probe);
        const total = probeKv.metrics.commits - before;
        expect(total).toBeGreaterThan(0);

        for (let failAt = 1; failAt <= total; failAt++) {
          const kv = newKv();
          await apply(make(builders, kv), sources);
          const crashing = make(builders, new CrashingKV(kv, failAt));
          await expect(drain(crashing)).rejects.toBeInstanceOf(CrashError);
          const rec = recorder();
          const resumed = make(recorded(rec, builders), kv);
          await drain(resumed);
          expect(await snapshot(resumed, ALL_COLLECTIONS), `crash at ${failAt}`).toEqual(want);
          // Committed work is not redone: the resumed run does at most a clean run's work.
          expect(rec.log.length, `rework after crash at ${failAt}`).toBeLessThanOrEqual(clean);
        }
      });
    });

    describe("model check", () => {
      it("matches full recompute over random edit sequences", async () => {
        const builders = ALL_BUILDERS;
        for (const seed of [1, 2, 3, 4, 5]) {
          const rand = rng(seed);
          const engine = make(builders);
          const sources: Sources = new Map([
            ["docs", new Map()],
            ["mods", new Map()],
          ]);
          const words = ["a", "bb", "ccc", "dd", "e"];
          const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
          const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
          for (let step = 0; step < 12; step++) {
            const ops = 1 + Math.floor(rand() * 4);
            for (let o = 0; o < ops; o++) {
              const key = pick(keys);
              const r = rand();
              if (r < 0.2) {
                await engine.remove("docs", key);
                sources.get("docs")?.delete(key);
              } else if (r < 0.35) {
                await engine.remove("mods", key);
                sources.get("mods")?.delete(key);
              } else if (r < 0.7) {
                const text = Array.from({ length: 1 + Math.floor(rand() * 3) }, () =>
                  pick(words),
                ).join(" ");
                await engine.put("docs", key, text);
                sources.get("docs")?.set(key, text);
              } else {
                const imports = keys.filter((x) => x !== key && rand() < 0.3);
                const value = mod(pick(words), imports);
                await engine.put("mods", key, value);
                sources.get("mods")?.set(key, value);
              }
            }
            // Interrupt now and then.
            if (rand() < 0.3) await engine.run({ maxTasks: 1 + Math.floor(rand() * 3) });
            await drain(engine);
            expect(await snapshot(engine, ALL_COLLECTIONS), `seed ${seed} step ${step}`).toEqual(
              await expected(builders, sources),
            );
          }
        }
      });
    });
  });
}

export type { Mod };
