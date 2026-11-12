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
    expect(events.at(-1)).toMatchObject({ builder: "count", tasks: 1, executed: 1, failed: 0 });
  });
});

describe("scanSources({ limit })", () => {
  it("writes at most `limit` changed files per scan, removals always, and reports the rest", async () => {
    const files = new MemFilesApi();
    for (const k of ["a", "b", "c", "d", "e"]) await writeText(files, `p/${k}.txt`, k);
    const engine = new BuildEngine({ store: new MemKV(), builders: [echo] });
    expect(await scanSources(engine, { files, root: "p", limit: 2 })).toEqual({
      seen: 5,
      changed: 2,
      removed: 0,
      deferred: 3,
    });
    expect(await engine.keys(SOURCES_COLLECTION)).toEqual(["a.txt", "b.txt"]);
    await files.remove("p/a.txt");
    expect(await scanSources(engine, { files, root: "p", limit: 2 })).toEqual({
      seen: 4,
      changed: 2,
      removed: 1,
      deferred: 1,
    });
    expect(await scanSources(engine, { files, root: "p", limit: 2 })).toMatchObject({
      changed: 1,
      deferred: 0,
    });
    expect(await engine.keys(SOURCES_COLLECTION)).toEqual(["b.txt", "c.txt", "d.txt", "e.txt"]);
  });
});
