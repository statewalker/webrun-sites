import { describe, expect, it } from "vitest";
import { Topology } from "../src/topology.js";
import type { BuilderDef } from "../src/types.js";

const builder = (
  id: string,
  inputs: string[],
  outputs: string[],
  reads?: string[],
): BuilderDef => ({
  id,
  inputs,
  outputs,
  reads,
  run() {},
});

describe("Topology (self-contained, no webrun-dataflow)", () => {
  it("orders builders upstream first, counting extra reads as dependencies", () => {
    const t = new Topology([
      builder("join", ["l", "r"], ["j"]),
      builder("right", ["src"], ["r"]),
      builder("left", ["src"], ["l"]),
      builder("late", ["src"], ["z"], ["j"]),
    ]);
    const pos = (id: string) => t.order.indexOf(id);
    expect(pos("left")).toBeLessThan(pos("join"));
    expect(pos("right")).toBeLessThan(pos("join"));
    expect(pos("join")).toBeLessThan(pos("late"));
    expect(t.rank.get("late")).toBe(pos("late"));
  });

  it("is deterministic: declaration order breaks ties", () => {
    const builders = [
      builder("b", ["s"], ["x"]),
      builder("a", ["s"], ["y"]),
      builder("c", ["x", "y"], ["z"]),
    ];
    expect(new Topology(builders).order).toEqual(["b", "a", "c"]);
  });

  it("indexes readers and derived collections", () => {
    const t = new Topology([builder("a", ["s"], ["x"]), builder("b", ["x"], ["y"], ["s"])]);
    expect(t.readersOf("s").sort()).toEqual(["a", "b"]);
    expect([...t.derived].sort()).toEqual(["x", "y"]);
    expect(() => t.assertSource("x")).toThrow(/not a source collection/);
    expect(() => t.assertSource("s")).not.toThrow();
  });

  it("rejects cycles, naming only the builders on the cycle", () => {
    expect(
      () =>
        new Topology([
          builder("a", ["z"], ["x"]),
          builder("b", ["x"], ["y"]),
          builder("c", ["y"], ["z"]),
          builder("d", ["z"], ["w"]),
        ]),
    ).toThrow("Cycle detected among builders: a, b, c");
  });

  it("rejects duplicate ids, self-consumption, and map builders without inputs", () => {
    expect(() => new Topology([builder("a", ["s"], ["x"]), builder("a", ["s"], ["y"])])).toThrow(
      "Duplicate builder id: a",
    );
    expect(() => new Topology([builder("a", ["x"], ["x"])])).toThrow(/consumes its own output "x"/);
    expect(() => new Topology([builder("a", [], ["x"])])).toThrow(/needs at least one input/);
  });
});

describe("package consolidation", () => {
  it("webrun-builder is self-contained: no webrun-dataflow dependency", async () => {
    const { readFile } = await import("node:fs/promises");
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@statewalker/webrun-dataflow");
    const src = await readFile(new URL("../src/topology.ts", import.meta.url), "utf8");
    expect(src).not.toContain("webrun-dataflow");
  });
});
