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
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(0), { a: undefined }]) {
      await expect(engine.put("docs", "k", bad as never)).rejects.toThrow(TypeError);
    }
    expect(await engine.list("docs")).toEqual([]);
  });
});
