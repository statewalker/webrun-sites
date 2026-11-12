import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { BuildEngine, type CellDef, MemKV, SOURCES_SIGNAL, scanSources } from "./index.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("scanSources", () => {
  it("mirrors a tree into the source signal: changes, removals, ignores", async () => {
    const files = new MemFilesApi();
    await writeText(files, "proj/a.txt", "a");
    await writeText(files, "proj/sub/b.txt", "b");
    await writeText(files, "proj/.git/HEAD", "x");
    await writeText(files, "proj/app.log", "x");
    await writeText(files, "proj/.projectignore", "*.log\n");
    const log: string[] = [];
    const echo: CellDef = {
      id: "echo",
      inputs: [SOURCES_SIGNAL],
      outputs: ["out"],
      run(ctx) {
        log.push(ctx.key);
        ctx.emit("out", ctx.key, true);
      },
    };
    const engine = new BuildEngine({ store: new MemKV(), cells: [echo] });
    const scan = () => scanSources(engine, { files, root: "proj" });

    expect(await scan()).toEqual({ seen: 2, changed: 2, removed: 0 });
    await engine.run();
    expect(await engine.keys("out")).toEqual(["a.txt", "sub/b.txt"]);

    expect(await scan()).toEqual({ seen: 2, changed: 0, removed: 0 });
    await tick();
    await writeText(files, "proj/a.txt", "a2");
    await files.remove("proj/sub/b.txt");
    expect(await scan()).toEqual({ seen: 1, changed: 1, removed: 1 });
    log.length = 0;
    await engine.run();
    expect(log).toEqual(["a.txt"]);
    expect(await engine.keys("out")).toEqual(["a.txt"]);

    // A newly ignored file is pruned like a deleted one.
    expect(
      await scanSources(engine, { files, root: "proj", ignore: (u) => u === "a.txt" }),
    ).toEqual({ seen: 0, changed: 0, removed: 1 });
  });

  it("a content fingerprint ignores touches", async () => {
    const files = new MemFilesApi();
    await writeText(files, "p/x.ts", "same");
    const engine = new BuildEngine({ store: new MemKV(), cells: [] });
    const fingerprint = async () => "content-hash";
    await scanSources(engine, { files, root: "p", fingerprint });
    await tick();
    await writeText(files, "p/x.ts", "same");
    expect(await scanSources(engine, { files, root: "p", fingerprint })).toMatchObject({
      changed: 0,
    });
  });
});
