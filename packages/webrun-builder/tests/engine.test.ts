import { describe, expect, it } from "vitest";
import { BuildEngine, type BuilderDef, MemKV } from "../src/index.js";

const upper: BuilderDef = {
  id: "upper",
  inputs: ["docs"],
  outputs: ["up"],
  async run(ctx) {
    ctx.emit("up", ctx.key, String(await ctx.get("docs", ctx.key)).toUpperCase());
  },
};

const counted = (builder: BuilderDef, log: string[]): BuilderDef => ({
  ...builder,
  run(ctx) {
    log.push(`${builder.id}/${ctx.key}`);
    return builder.run(ctx);
  },
});

describe("BuildEngine", () => {
  it("commits a cold build in batches (group commit)", async () => {
    const store = new MemKV();
    const engine = new BuildEngine({ store, builders: [upper], batchSize: 50 });
    for (let i = 0; i < 200; i++) await engine.put("docs", `k${String(i).padStart(3, "0")}`, "x");
    store.resetMetrics();
    const stats = await engine.run();
    expect(stats.executed).toBe(200);
    expect(store.metrics.commits).toBe(4);
    expect(await engine.list("up")).toHaveLength(200);
  });

  it("calls dispose for a dead map task, with its last outputs, before retracting", async () => {
    const disposed: unknown[] = [];
    let engine: BuildEngine;
    const builder: BuilderDef = {
      ...upper,
      async dispose(key, outputs) {
        // The rows are still there: the retraction commits after dispose.
        disposed.push({ key, outputs, before: await engine.get("up", key) });
      },
    };
    engine = new BuildEngine({ store: new MemKV(), builders: [builder] });
    await engine.put("docs", "a", "x");
    await engine.run();
    await engine.remove("docs", "a");
    await engine.run();
    expect(disposed).toEqual([
      { key: "a", outputs: [{ collection: "up", key: "a" }], before: "X" },
    ]);
    expect(await engine.list("up")).toEqual([]);
  });

  it("retries a failing dispose and keeps the outputs until it succeeds", async () => {
    let fail = true;
    const builder: BuilderDef = {
      ...upper,
      dispose() {
        if (fail) throw new Error("locked");
      },
    };
    const engine = new BuildEngine({ store: new MemKV(), builders: [builder], maxAttempts: 1 });
    await engine.put("docs", "a", "x");
    await engine.run();
    await engine.remove("docs", "a");
    expect((await engine.run()).deadLettered).toBe(1);
    expect(await engine.get("up", "a")).toBe("X");
    fail = false;
    await engine.requeue("upper", "a");
    await engine.run();
    expect(await engine.get("up", "a")).toBeUndefined();
    expect(await engine.deadLetters()).toEqual([]);
  });

  it("invalidate re-runs every task of a builder; downstream only where outputs change", async () => {
    const log: string[] = [];
    let suffix = "";
    const a: BuilderDef = {
      id: "a",
      inputs: ["docs"],
      outputs: ["a"],
      async run(ctx) {
        ctx.emit(
          "a",
          ctx.key,
          `${await ctx.get("docs", ctx.key)}${ctx.key === "k1" ? suffix : ""}`,
        );
      },
    };
    const b: BuilderDef = {
      id: "b",
      inputs: ["a"],
      outputs: ["b"],
      async run(ctx) {
        ctx.emit("b", ctx.key, (await ctx.get("a", ctx.key)) ?? null);
      },
    };
    const engine = new BuildEngine({
      store: new MemKV(),
      builders: [counted(a, log), counted(b, log)],
    });
    await engine.put("docs", "k1", "1");
    await engine.put("docs", "k2", "2");
    await engine.run();
    log.length = 0;
    suffix = "!"; // the builder's code "changed" for k1 only
    await engine.invalidate("a");
    await engine.run();
    expect(log.sort()).toEqual(["a/k1", "a/k2", "b/k1"]);
    expect(await engine.get("b", "k1")).toBe("1!");
  });

  it("reports queued work per builder and stops on abort", async () => {
    const engine = new BuildEngine({ store: new MemKV(), builders: [upper], batchSize: 2 });
    for (const key of ["a", "b", "c", "d"]) await engine.put("docs", key, key);
    expect(await engine.status()).toEqual({ queued: { upper: 4 }, deadLetters: 0 });
    const ac = new AbortController();
    ac.abort();
    expect(await engine.run({ signal: ac.signal })).toMatchObject({ executed: 0, pending: true });
    expect(await engine.run({ maxTasks: 3 })).toMatchObject({ executed: 3, pending: true });
    expect(await engine.status()).toEqual({ queued: { upper: 1 }, deadLetters: 0 });
    expect(await engine.run()).toMatchObject({ executed: 1, pending: false });
  });

  it("refuses overlapping runs and reserved characters in names", async () => {
    const slow: BuilderDef = { ...upper, run: () => new Promise((r) => setTimeout(r, 10)) };
    const engine = new BuildEngine({ store: new MemKV(), builders: [slow] });
    await engine.put("docs", "a", 1);
    const first = engine.run();
    await expect(engine.run()).rejects.toThrow(/already in progress/);
    await first;
    expect(
      () => new BuildEngine({ store: new MemKV(), builders: [{ ...upper, id: "a\u0001b" }] }),
    ).toThrow(/reserved control character/);
  });

  it("put/remove report whether anything changed", async () => {
    const engine = new BuildEngine({ store: new MemKV(), builders: [upper] });
    expect(await engine.put("docs", "a", { x: 1, y: 2 })).toBe(true);
    expect(await engine.put("docs", "a", { y: 2, x: 1 })).toBe(false);
    expect(await engine.remove("docs", "a")).toBe(true);
    expect(await engine.remove("docs", "a")).toBe(false);
  });
});
