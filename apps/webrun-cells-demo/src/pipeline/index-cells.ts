import type { Cell } from "@statewalker/webrun-cells";
import { embed, fileSummary, splitBlocks, summarize, termFreqs, tokenize } from "./fakes.js";
import type { BlockSummary } from "./types.js";

export const split: Cell = {
  id: "split",
  inputs: ["files"],
  outputs: ["file-blocks"],
  async *run(inputs) {
    for await (const i of inputs)
      yield { signal: "file-blocks", key: i.key, value: splitBlocks(String(i.value)) };
  },
};

export const summarizeCell: Cell = {
  id: "summarize",
  inputs: ["file-blocks"],
  outputs: ["block-summaries", "file-summaries"],
  async *run(inputs) {
    for await (const i of inputs) {
      const rows: BlockSummary[] = (i.value as string[]).map((text, n) => ({
        path: i.key,
        n,
        text,
        summary: summarize(text),
      }));
      for (const row of rows)
        yield { signal: "block-summaries", key: `${i.key}#${row.n}`, value: { ...row } };
      yield {
        signal: "file-summaries",
        key: i.key,
        value: fileSummary(rows.map((r) => r.summary)),
      };
    }
  },
};

export const ftsIndex: Cell = {
  id: "fts-index",
  inputs: ["block-summaries"],
  outputs: ["fts-terms"],
  async *run(inputs) {
    for await (const i of inputs) {
      const { path, text } = i.value as unknown as BlockSummary;
      yield {
        signal: "fts-terms",
        key: i.key,
        value: { path, terms: termFreqs(text), length: tokenize(text).length },
      };
    }
  },
};

export const vectorIndex: Cell = {
  id: "vector-index",
  inputs: ["block-summaries"],
  outputs: ["vectors"],
  async *run(inputs) {
    for await (const i of inputs) {
      const { path, text } = i.value as unknown as BlockSummary;
      yield { signal: "vectors", key: i.key, value: { path, vector: embed(text) } };
    }
  },
};

export const INDEX_CELLS: readonly Cell[] = [split, summarizeCell, ftsIndex, vectorIndex];
