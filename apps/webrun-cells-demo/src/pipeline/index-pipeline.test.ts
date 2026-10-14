import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS } from "./corpus.js";
import { createPipeline, type Pipeline } from "./pipeline.js";
import type { PipelineEvent } from "./types.js";

const SIGNALS = ["file-blocks", "block-summaries", "file-summaries", "fts-terms", "vectors"];

let pipeline: Pipeline;
let events: PipelineEvent[];
const started = (cell: string) =>
  events.filter((e) => e.type === "start" && e.cell === cell).map((e) => e.key);
const keys = async (signal: string) => (await pipeline.engine.list(signal)).map((r) => r.key);

beforeEach(async () => {
  events = [];
  pipeline = createPipeline({
    db: new NodeSqlDriver(new DatabaseSync(":memory:")),
    onEvent: (e) => events.push(e),
  });
  for (const [path, text] of Object.entries(CORPUS)) await pipeline.engine.put("files", path, text);
  await pipeline.engine.run();
});

describe("index pipeline", () => {
  it("indexes the seeded corpus: every block summarized, term-indexed and embedded", async () => {
    const blockCount = Object.values(CORPUS)
      .map((t) => t.split(/\n\s*\n/).filter((b) => b.trim()).length)
      .reduce((a, b) => a + b, 0);
    expect(await keys("file-summaries")).toHaveLength(Object.keys(CORPUS).length);
    expect(await keys("block-summaries")).toHaveLength(blockCount);
    expect(await keys("fts-terms")).toHaveLength(blockCount);
    expect(await keys("vectors")).toHaveLength(blockCount);
    const vector = (await pipeline.engine.get("vectors", "docs/install.md#0")) as {
      vector: number[];
    };
    expect(vector.vector).toHaveLength(256);
    expect(await pipeline.engine.deadLetters()).toEqual([]);
  });

  it("re-indexes only the edited block (early cut-off stops the unchanged ones)", async () => {
    events.length = 0;
    const text = CORPUS["docs/install.md"] as string;
    await pipeline.engine.put("files", "docs/install.md", text.replace("Node 22", "Node 24"));
    await pipeline.engine.run();
    expect(started("split")).toEqual(["docs/install.md"]);
    expect(started("summarize")).toEqual(["docs/install.md"]);
    expect(started("fts-index")).toEqual(["docs/install.md#1"]);
    expect(started("vector-index")).toEqual(["docs/install.md#1"]);
  });

  it("deleting a file removes its rows from every derived signal", async () => {
    await pipeline.engine.remove("files", "docs/faq.md");
    await pipeline.engine.run();
    for (const signal of SIGNALS) {
      expect((await keys(signal)).filter((k) => k.startsWith("docs/faq.md"))).toEqual([]);
    }
  });

  it("fewer blocks: removing a paragraph deletes the trailing block rows", async () => {
    const text = CORPUS["docs/install.md"] as string;
    const firstTwo = text
      .split(/\n\s*\n/)
      .slice(0, 2)
      .join("\n\n");
    await pipeline.engine.put("files", "docs/install.md", firstTwo);
    await pipeline.engine.run();
    for (const signal of ["block-summaries", "fts-terms", "vectors"]) {
      expect((await keys(signal)).filter((k) => k.startsWith("docs/install.md#"))).toEqual([
        "docs/install.md#0",
        "docs/install.md#1",
      ]);
    }
  });

  it("empty file: no blocks, an empty summary, nothing dead-lettered", async () => {
    await pipeline.engine.put("files", "docs/empty.md", "   \n\n  ");
    await pipeline.engine.run();
    expect(await pipeline.engine.get("file-blocks", "docs/empty.md")).toEqual([]);
    expect(await pipeline.engine.get("file-summaries", "docs/empty.md")).toBe("");
    expect((await keys("block-summaries")).filter((k) => k.startsWith("docs/empty.md"))).toEqual(
      [],
    );
    expect(await pipeline.engine.deadLetters()).toEqual([]);
  });

  it("delay: each cell waits the configured time per input", async () => {
    const slow = createPipeline({
      db: new NodeSqlDriver(new DatabaseSync(":memory:")),
      delay: () => 20,
    });
    await slow.engine.put("files", "a.md", "One sentence.");
    const t0 = Date.now();
    await slow.engine.run();
    // split, summarize, fts-index, vector-index: four inputs, 20 ms each
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });
});
