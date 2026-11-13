import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  BuildEngine,
  type BuilderDef,
  FilesKV,
  type KV,
  MemKV,
  type RunProgress,
  SOURCES_COLLECTION,
} from "../src/index.js";

const executed: string[] = [];
const echo: BuilderDef = {
  id: "echo",
  inputs: [SOURCES_COLLECTION],
  outputs: ["out"],
  run(ctx) {
    executed.push(ctx.key);
    ctx.emit("out", ctx.key, true);
  },
};
const count: BuilderDef = {
  id: "count",
  kind: "reduce",
  inputs: ["out"],
  outputs: ["total"],
  async run(ctx) {
    ctx.emit("total", "n", (await ctx.list("out")).length);
  },
};

async function engineWith(n: number, store: KV = new MemKV()) {
  const engine = new BuildEngine({ store, builders: [echo, count], batchSize: 2 });
  for (let i = 0; i < n; i++) await engine.put(SOURCES_COLLECTION, `f${i}`, i);
  return engine;
}

describe("engine.steps()", () => {
  it("yields one progress per committed batch and returns the run's stats", async () => {
    executed.length = 0;
    const engine = await engineWith(5);
    const steps = engine.steps();
    const seen: RunProgress[] = [];
    let next = await steps.next();
    while (!next.done) {
      seen.push(next.value);
      next = await steps.next();
    }
    expect(seen.map((p) => p.builder)).toEqual(["echo", "echo", "echo", "count"]);
    expect(seen.map((p) => p.tasks)).toEqual([2, 2, 1, 1]);
    expect(next.value).toMatchObject({ executed: 6, pending: false });
    expect(await engine.get("total", "n")).toBe(5);
  });

  it("waits at each yield: the caller can pause between batches", async () => {
    executed.length = 0;
    const engine = await engineWith(6);
    for await (const _ of engine.steps()) {
      const before = executed.length;
      await new Promise((r) => setTimeout(r, 5));
      expect(executed.length).toBe(before); // nothing ran while we slept
    }
    expect(executed).toHaveLength(6);
  });

  it("break stops cleanly; the next run continues from the queue without redoing work", async () => {
    executed.length = 0;
    const store = new MemKV();
    const engine = await engineWith(6, store);
    let batches = 0;
    for await (const _ of engine.steps()) {
      if (++batches === 2) break;
    }
    expect(executed).toHaveLength(4);
    expect((await engine.status()).queued).toEqual({ echo: 2, count: 1 });

    const rest = await engine.run(); // not refused: break released the engine
    expect(executed).toHaveLength(6);
    expect(rest).toMatchObject({ pending: false });
    expect(await engine.get("total", "n")).toBe(6);
  });

  it("an exception in the loop body releases the engine too", async () => {
    const engine = await engineWith(4);
    await expect(
      (async () => {
        for await (const _ of engine.steps()) throw new Error("caller failed");
      })(),
    ).rejects.toThrow("caller failed");
    await expect(engine.run()).resolves.toMatchObject({ pending: false });
  });

  it("only one run at a time: a suspended generator holds the engine", async () => {
    const engine = await engineWith(4);
    const steps = engine.steps();
    await steps.next(); // suspended after the first batch
    await expect(engine.run()).rejects.toThrow(/already in progress/);
    await expect(engine.steps().next()).rejects.toThrow(/already in progress/);
    await steps.return({ executed: 0, skipped: 0, failed: 0, deadLettered: 0, pending: true });
    await expect(engine.run()).resolves.toMatchObject({ pending: false });
  });

  it("onProgress still fires, and maxTasks / signal apply as in run()", async () => {
    const engine = await engineWith(6);
    const reported: string[] = [];
    const yielded: string[] = [];
    const steps = engine.steps({ maxTasks: 3, onProgress: (p) => reported.push(p.builder) });
    let next = await steps.next();
    while (!next.done) {
      yielded.push(next.value.builder);
      next = await steps.next();
    }
    expect(yielded).toEqual(reported);
    expect(next.value.pending).toBe(true);

    const ac = new AbortController();
    let n = 0;
    for await (const _ of engine.steps({ signal: ac.signal })) {
      n++;
      ac.abort(); // stops before the next batch
    }
    expect(n).toBe(1);
  });

  it("a paused run over a file store is resumable from a new engine", async () => {
    executed.length = 0;
    const files = new MemFilesApi();
    const first = await engineWith(6, await FilesKV.open(files, "/state"));
    let batches = 0;
    for await (const _ of first.steps()) if (++batches === 1) break;
    expect(executed).toHaveLength(2);

    const second = new BuildEngine({
      store: await FilesKV.open(files, "/state"),
      builders: [echo, count],
      batchSize: 2,
    });
    await second.run();
    expect(executed).toHaveLength(6);
    expect(await second.get("total", "n")).toBe(6);
  });
});
