import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  BuildEngine,
  type BuilderDef,
  MemKV,
  type RunProgress,
  SOURCES_COLLECTION,
  scanSources,
} from "../src/index.js";

const echo: BuilderDef = {
  id: "echo",
  inputs: [SOURCES_COLLECTION],
  outputs: ["out"],
  run(ctx) {
    if (ctx.key === "bad.txt") throw new Error("bad");
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

describe("run({ onProgress })", () => {
  it("reports each committed batch: builder, tasks and outcomes", async () => {
    const engine = new BuildEngine({
      store: new MemKV(),
      builders: [echo, count],
      batchSize: 2,
      maxAttempts: 1,
    });
    for (const k of ["a.txt", "b.txt", "bad.txt"]) await engine.put(SOURCES_COLLECTION, k, 1);
    const events: RunProgress[] = [];
    await engine.run({ onProgress: (p) => events.push(p) });
    expect(events.map((e) => e.builder)).toEqual(["echo", "echo", "count"]);
    expect(events.reduce((a, e) => a + e.tasks, 0)).toBe(4);
    expect(events.reduce((a, e) => a + e.executed, 0)).toBe(3);
    expect(events.reduce((a, e) => a + e.deadLettered, 0)).toBe(1);
    expect(events.at(-1)).toMatchObject({
      builder: "count",
      tasks: 1,
      executed: 1,
      failed: 0,
      released: 0,
    });
  });
});

describe("scanSources({ limit, after })", () => {
  const scan = (engine: BuildEngine, files: MemFilesApi, after?: string) =>
    scanSources(engine, { files, root: "p", limit: 2, after });

  it("writes at most `limit` changed files, applies removals always, and resumes after `cursor`", async () => {
    const files = new MemFilesApi();
    for (const k of ["a", "b", "c", "d", "e"]) await writeText(files, `p/${k}.txt`, k);
    const engine = new BuildEngine({ store: new MemKV(), builders: [echo] });
    const r1 = await scan(engine, files);
    expect(r1).toEqual({ seen: 5, changed: 2, removed: 0, more: true, cursor: "b.txt" });
    expect(await engine.keys(SOURCES_COLLECTION)).toEqual(["a.txt", "b.txt"]);
    await files.remove("p/a.txt");
    const r2 = await scan(engine, files, r1.cursor);
    expect(r2).toMatchObject({ changed: 2, removed: 1, more: true, cursor: "d.txt" });
    const r3 = await scan(engine, files, r2.cursor);
    expect(r3).toMatchObject({ changed: 1, more: false });
    expect(await engine.keys(SOURCES_COLLECTION)).toEqual(["b.txt", "c.txt", "d.txt", "e.txt"]);
  });

  it("a file that changes on every scan cannot starve the others (the cursor rotates)", async () => {
    const files = new MemFilesApi();
    for (const k of ["a", "b", "c", "d"]) await writeText(files, `p/${k}.txt`, k);
    const engine = new BuildEngine({ store: new MemKV(), builders: [echo] });
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      await writeText(files, "p/a.txt", `a${i}`); // touched before every scan
      await new Promise((r) => setTimeout(r, 2));
      const r = await scanSources(engine, { files, root: "p", limit: 1, after: cursor });
      cursor = r.cursor;
    }
    expect(await engine.keys(SOURCES_COLLECTION)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
  });

  it("stops looking at the first deferred file (no full-corpus fingerprinting per scan)", async () => {
    const files = new MemFilesApi();
    for (let i = 0; i < 50; i++)
      await writeText(files, `p/f${String(i).padStart(2, "0")}.txt`, "x");
    const engine = new BuildEngine({ store: new MemKV(), builders: [] });
    let calls = 0;
    const fingerprint = (_: unknown, uri: string) => {
      calls++;
      return uri;
    };
    await scanSources(engine, { files, root: "p", limit: 5, fingerprint });
    expect(calls).toBe(6);
  });

  it("rejects a limit that is not a positive integer", async () => {
    const engine = new BuildEngine({ store: new MemKV(), builders: [] });
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(
        scanSources(engine, { files: new MemFilesApi(), root: "p", limit }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe("onProgress robustness", () => {
  it("a throwing or rejecting callback is logged and does not break the run", async () => {
    const warnings: unknown[] = [];
    const logger = {
      info() {},
      debug() {},
      error() {},
      warn: (...a: unknown[]) => warnings.push(a),
    };
    const engine = new BuildEngine({ store: new MemKV(), builders: [echo], logger, batchSize: 1 });
    for (const k of ["a.txt", "b.txt"]) await engine.put(SOURCES_COLLECTION, k, 1);
    let n = 0;
    const stats = await engine.run({
      onProgress: (() => {
        n++;
        if (n === 1) throw new Error("sync boom");
        return Promise.reject(new Error("async boom"));
      }) as unknown as (p: RunProgress) => void,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(stats.executed).toBe(2);
    expect(warnings.length).toBe(2);
  });
});
