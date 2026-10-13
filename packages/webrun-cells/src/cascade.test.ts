import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const split = () =>
  mapCell("split", ["docs"], ["chunks"], (i) =>
    String(i.value)
      .split(" ")
      .map((word, n) => ({ signal: "chunks", key: `${i.key}#${n}`, value: word })),
  );
const upper = () =>
  mapCell("upper", ["chunks"], ["upper"], (i) => [
    { signal: "upper", key: i.key, value: String(i.value).toUpperCase() },
  ]);

describe("cascade", () => {
  it("converges a chain in one run, whatever order the cells are given in", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [upper(), split()] });
    await engine.put("docs", "a", "hello world");
    expect(await engine.run()).toEqual({ committed: 3, failed: 0, deadLettered: 0 });
    expect(await engine.list("upper")).toEqual([
      { key: "a#0", value: "HELLO" },
      { key: "a#1", value: "WORLD" },
    ]);
    expect(await engine.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
  });

  it("queues consumers once for an unchanged value and stops at unchanged outputs", async () => {
    const s = split();
    const u = upper();
    const engine = new CellEngine({ db: memDb(), cells: [s, u] });
    await engine.put("docs", "a", "x y");
    await engine.run();
    await engine.put("docs", "a", "x y");
    await engine.run();
    expect(s.seen).toEqual(["docs/a"]);

    await engine.put("docs", "a", "x z");
    await engine.run();
    expect(s.seen).toEqual(["docs/a", "docs/a"]);
    // a#0 is still "x": early cut-off, upper does not see it again
    expect(u.seen).toEqual(["chunks/a#0", "chunks/a#1", "chunks/a#1"]);
    expect(await engine.get("upper", "a#1")).toBe("Z");
  });

  it("does not count object key order as a change", async () => {
    const c = mapCell("c", ["docs"], ["out"], () => []);
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", { a: 1, b: 2 });
    await engine.run();
    await engine.put("docs", "a", { b: 2, a: 1 });
    await engine.run();
    expect(c.seen).toEqual(["docs/a"]);
  });

  it("treats null as a value, not a deletion", async () => {
    const c = mapCell("c", ["docs"], ["out"], (i) => [{ signal: "out", key: i.key, value: i.value }]);
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", null);
    await engine.run();
    expect(c.seen).toEqual(["docs/a"]);
    expect(await engine.list("out")).toEqual([{ key: "a", value: null }]);
  });

  it("runs both producers of a diamond before the shared consumer", async () => {
    const log: string[] = [];
    const left = mapCell("left", ["docs"], ["l"], (i) => {
      log.push("left");
      return [{ signal: "l", key: i.key, value: 1 }];
    });
    const right = mapCell("right", ["docs"], ["r"], (i) => {
      log.push("right");
      return [{ signal: "r", key: i.key, value: 2 }];
    });
    const join = mapCell("join", ["l", "r"], ["j"], (i) => {
      log.push(`join:${i.signal}`);
      return [{ signal: "j", key: `${i.signal}:${i.key}`, value: i.value }];
    });
    const engine = new CellEngine({ db: memDb(), cells: [join, right, left] });
    await engine.put("docs", "a", "x");
    await engine.run();
    expect(log.slice(0, 2).sort()).toEqual(["left", "right"]);
    expect(log.slice(2).sort()).toEqual(["join:l", "join:r"]);
  });

  it("keeps a change that arrives while its cell runs queued", async () => {
    const values: unknown[] = [];
    let engine: CellEngine;
    const copy: Cell = {
      id: "copy",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const input of inputs) {
          values.push(input.value);
          if (values.length === 1) await engine.put("docs", "a", "v2");
          yield { signal: "out", key: input.key, value: input.value };
        }
      },
    };
    engine = new CellEngine({ db: memDb(), cells: [copy] });
    await engine.put("docs", "a", "v1");
    expect(await engine.run()).toEqual({ committed: 2, failed: 0, deadLettered: 0 });
    expect(values).toEqual(["v1", "v2"]);
    expect(await engine.get("out", "a")).toBe("v2");
  });
});
