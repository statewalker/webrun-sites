import type { SqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";

const upper = () =>
  mapCell("upper", ["docs"], ["upper"], (i) => [
    { signal: "upper", key: i.key, value: String(i.value).toUpperCase() },
  ]);

describe("source rows", () => {
  it("stores, reads and lists rows in key order", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [] });
    await engine.put("docs", "b", { n: 2 });
    await engine.put("docs", "a", "x");
    expect(await engine.get("docs", "a")).toBe("x");
    expect(await engine.get("docs", "missing")).toBeUndefined();
    expect(await engine.list("docs")).toEqual([
      { key: "a", value: "x" },
      { key: "b", value: { n: 2 } },
    ]);
  });

  it("removes a row; removing a missing row is a no-op", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [] });
    await engine.put("docs", "a", 1);
    await engine.remove("docs", "a");
    await engine.remove("docs", "a");
    expect(await engine.list("docs")).toEqual([]);
  });

  it("rejects writes to a derived signal", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [upper()] });
    await expect(engine.put("upper", "k", "v")).rejects.toThrow(/not a source signal/);
    await expect(engine.remove("upper", "k")).rejects.toThrow(/not a source signal/);
  });

  it("rejects values JSON cannot represent exactly", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [] });
    for (const bad of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      { a: undefined },
    ]) {
      await expect(engine.put("docs", "k", bad as never)).rejects.toThrow(TypeError);
    }
    expect(await engine.list("docs")).toEqual([]);
  });

  it("retries schema init after a transient failure", async () => {
    const real = memDb();
    let failures = 1;
    const flaky: SqlDriver = {
      all: (sql, ...params) => real.all(sql, ...params),
      run: (sql, ...params) => real.run(sql, ...params),
      transaction: async (statements) => {
        if (failures-- > 0) throw new Error("SQLITE_BUSY");
        return real.transaction(statements);
      },
    };
    const engine = new CellEngine({ db: flaky, cells: [] });
    await expect(engine.put("docs", "a", 1)).rejects.toThrow(/SQLITE_BUSY/);
    await engine.put("docs", "a", 1);
    expect(await engine.get("docs", "a")).toBe(1);
  });
});
