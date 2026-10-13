import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";

const cell = (id: string, inputs: string[], outputs: string[]) =>
  mapCell(id, inputs, outputs, () => []);

describe("graph validation", () => {
  it("rejects a cycle between cells", () => {
    expect(
      () =>
        new CellEngine({ db: memDb(), cells: [cell("a", ["x"], ["y"]), cell("b", ["y"], ["x"])] }),
    ).toThrow(/Cycle detected/);
  });

  it("rejects a cell that consumes its own output", () => {
    expect(() => new CellEngine({ db: memDb(), cells: [cell("a", ["x"], ["x"])] })).toThrow(
      /consumes its own output/,
    );
  });

  it("rejects duplicate cell ids", () => {
    expect(
      () =>
        new CellEngine({ db: memDb(), cells: [cell("a", ["x"], ["y"]), cell("a", ["x"], ["z"])] }),
    ).toThrow(/Duplicate cell id/);
  });
});
