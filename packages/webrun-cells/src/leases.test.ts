import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const copyCell = () =>
  mapCell("copy", ["docs"], ["out"], (i) => [{ signal: "out", key: i.key, value: i.value }]);

describe("leases", () => {
  it("reclaims work from an engine that never commits, only after leaseMs", async () => {
    const sqlite = new DatabaseSync(":memory:");
    let now = 1_000;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hang: Cell = {
      id: "copy",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const i of inputs) {
          entered();
          await new Promise(() => {}); // a process that died mid-batch
          yield { signal: "out", key: i.key, value: i.value };
        }
      },
    };
    const opts = { leaseMs: 100, now: () => now };
    const a = new CellEngine({ db: new NodeSqlDriver(sqlite), cells: [hang], owner: "A", ...opts });
    const b = new CellEngine({
      db: new NodeSqlDriver(sqlite),
      cells: [copyCell()],
      owner: "B",
      ...opts,
    });
    await a.put("docs", "k", "v");
    void a.run();
    await started;

    now += 99;
    expect(await b.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
    now += 1;
    expect(await b.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await b.get("out", "k")).toBe("v");
  });

  it("commits each input once when two runs of one engine overlap", async () => {
    const c = copyCell();
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    for (const key of ["a", "b", "c"]) await engine.put("docs", key, key);
    const [r1, r2] = await Promise.all([engine.run(), engine.run()]);
    expect(r1.committed + r2.committed).toBe(3);
    expect(c.seen.sort()).toEqual(["docs/a", "docs/b", "docs/c"]);
  });
});
