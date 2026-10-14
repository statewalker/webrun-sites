import { type Cell, CellEngine } from "@statewalker/webrun-cells";
import { describe, expect, it } from "vitest";
import { openMemoryDb } from "./wasm-sql-driver.js";

const upper: Cell = {
  id: "upper",
  inputs: ["words"],
  outputs: ["upper"],
  async *run(inputs) {
    for await (const i of inputs)
      yield { signal: "upper", key: i.key, value: String(i.value).toUpperCase() };
  },
};
const lengths: Cell = {
  id: "lengths",
  inputs: ["upper"],
  outputs: ["lengths"],
  async *run(inputs) {
    for await (const i of inputs)
      yield { signal: "lengths", key: i.key, value: String(i.value).length };
  },
};

describe("WasmSqlDriver", () => {
  it("runs the engine: a chain converges and a remove retracts it", async () => {
    const engine = new CellEngine({ db: await openMemoryDb(), cells: [upper, lengths] });
    await engine.put("words", "a", "hello");
    await engine.run();
    expect(await engine.get("upper", "a")).toBe("HELLO");
    expect(await engine.get("lengths", "a")).toBe(5);
    await engine.remove("words", "a");
    await engine.run();
    expect(await engine.list("upper")).toEqual([]);
    expect(await engine.list("lengths")).toEqual([]);
  });

  it("returns a change count per statement", async () => {
    const db = await openMemoryDb();
    db.run("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)");
    const counts = db.transaction([
      { sql: "INSERT INTO t (a, b) VALUES (?, ?)", params: [1, "x"] },
      { sql: "UPDATE t SET b = 'y' WHERE a = ?", params: [2] },
    ]);
    expect(counts).toEqual([1, 0]);
    expect(db.all("SELECT a, b FROM t")).toEqual([{ a: 1, b: "x" }]);
  });

  it("rolls the whole transaction back when a statement fails", async () => {
    const db = await openMemoryDb();
    db.run("CREATE TABLE t (a INTEGER PRIMARY KEY)");
    expect(() =>
      db.transaction([{ sql: "INSERT INTO t VALUES (1)" }, { sql: "INSERT INTO t VALUES (1)" }]),
    ).toThrow();
    expect(db.all("SELECT * FROM t")).toEqual([]);
  });
});
