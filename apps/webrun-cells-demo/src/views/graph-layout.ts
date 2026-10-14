export interface CellNode {
  id: string;
  inputs: readonly string[];
  outputs: readonly string[];
  layer: number;
  independentOf: string[];
}

type CellShape = { id: string; inputs: readonly string[]; outputs: readonly string[] };

/** Layer = longest path from a source signal (0 for cells fed only by sources). independentOf = other cells with exactly the same inputs. */
export function layoutCells(cells: readonly CellShape[]): CellNode[][] {
  const producer = new Map<string, CellShape>();
  for (const c of cells) for (const s of c.outputs) producer.set(s, c);

  const layers = new Map<string, number>();
  const layerOf = (c: CellShape): number => {
    let layer = layers.get(c.id);
    if (layer !== undefined) return layer;
    layer = 0;
    for (const s of c.inputs) {
      const p = producer.get(s);
      if (p) layer = Math.max(layer, layerOf(p) + 1);
    }
    layers.set(c.id, layer);
    return layer;
  };

  const sameInputs = (a: CellShape, b: CellShape) =>
    [...a.inputs].sort().join("\n") === [...b.inputs].sort().join("\n");

  const result: CellNode[][] = [];
  for (const c of cells) {
    const layer = layerOf(c);
    const independentOf = cells.filter((o) => o !== c && sameInputs(o, c)).map((o) => o.id);
    const node: CellNode = { id: c.id, inputs: c.inputs, outputs: c.outputs, layer, independentOf };
    const row = result[layer];
    if (row) row.push(node);
    else result[layer] = [node];
  }
  return result;
}
