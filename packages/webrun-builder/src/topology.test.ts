import { describe, expect, it } from "vitest";
import { Topology } from "./topology.js";
import type { CellDef } from "./types.js";

const cell = (id: string, inputs: string[], outputs: string[], reads?: string[]): CellDef => ({
  id,
  inputs,
  outputs,
  reads,
  run() {},
});

describe("Topology (self-contained, no webrun-dataflow)", () => {
  it("orders cells upstream first, counting extra reads as dependencies", () => {
    const t = new Topology([
      cell("join", ["l", "r"], ["j"]),
      cell("right", ["src"], ["r"]),
      cell("left", ["src"], ["l"]),
      cell("late", ["src"], ["z"], ["j"]),
    ]);
    const pos = (id: string) => t.order.indexOf(id);
    expect(pos("left")).toBeLessThan(pos("join"));
    expect(pos("right")).toBeLessThan(pos("join"));
    expect(pos("join")).toBeLessThan(pos("late"));
    expect(t.rank.get("late")).toBe(pos("late"));
  });

  it("is deterministic: declaration order breaks ties", () => {
    const cells = [cell("b", ["s"], ["x"]), cell("a", ["s"], ["y"]), cell("c", ["x", "y"], ["z"])];
    expect(new Topology(cells).order).toEqual(["b", "a", "c"]);
  });

  it("indexes readers and derived signals", () => {
    const t = new Topology([cell("a", ["s"], ["x"]), cell("b", ["x"], ["y"], ["s"])]);
    expect(t.readersOf("s").sort()).toEqual(["a", "b"]);
    expect([...t.derived].sort()).toEqual(["x", "y"]);
    expect(() => t.assertSource("x")).toThrow(/not a source signal/);
    expect(() => t.assertSource("s")).not.toThrow();
  });

  it("rejects cycles, naming only the cells on the cycle", () => {
    expect(
      () =>
        new Topology([
          cell("a", ["z"], ["x"]),
          cell("b", ["x"], ["y"]),
          cell("c", ["y"], ["z"]),
          cell("d", ["z"], ["w"]),
        ]),
    ).toThrow("Cycle detected among cells: a, b, c");
  });

  it("rejects duplicate ids, self-consumption, and map cells without inputs", () => {
    expect(() => new Topology([cell("a", ["s"], ["x"]), cell("a", ["s"], ["y"])])).toThrow(
      "Duplicate cell id: a",
    );
    expect(() => new Topology([cell("a", ["x"], ["x"])])).toThrow(/consumes its own output "x"/);
    expect(() => new Topology([cell("a", [], ["x"])])).toThrow(/needs at least one input/);
  });
});

describe("package consolidation", () => {
  it("webrun-builder is self-contained: no webrun-dataflow dependency", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@statewalker/webrun-dataflow");
    const src = await readFile(new URL("./topology.ts", import.meta.url), "utf8");
    expect(src).not.toContain("webrun-dataflow");
  });
});
