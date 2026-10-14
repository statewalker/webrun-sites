import { describe, expect, it } from "vitest";
import { INDEX_CELLS } from "../pipeline/index-cells.js";
import { layoutCells } from "./graph-layout.js";

describe("layoutCells", () => {
  it("layers the index pipeline and marks fts-index and vector-index as independent", () => {
    const layers = layoutCells(INDEX_CELLS);
    expect(layers.map((l) => l.map((c) => c.id))).toEqual([
      ["split"],
      ["summarize"],
      ["fts-index", "vector-index"],
    ]);
    const fts = layers[2]?.find((c) => c.id === "fts-index");
    expect(fts?.independentOf).toEqual(["vector-index"]);
    expect(layers[0]?.[0]?.independentOf).toEqual([]);
  });

  it("puts a cell after the deepest of its producers", () => {
    const layers = layoutCells([
      { id: "a", inputs: ["src"], outputs: ["x"] },
      { id: "b", inputs: ["x"], outputs: ["y"] },
      { id: "c", inputs: ["x", "y"], outputs: ["z"] },
    ]);
    expect(layers.map((l) => l.map((c) => c.id))).toEqual([["a"], ["b"], ["c"]]);
  });
});
