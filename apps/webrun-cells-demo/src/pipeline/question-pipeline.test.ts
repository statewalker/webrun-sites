import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS } from "./corpus.js";
import { createPipeline, type Pipeline } from "./pipeline.js";
import { NO_MATCH } from "./question-cells.js";
import type { Answer, PipelineEvent, Queries } from "./types.js";

let pipeline: Pipeline;
let events: PipelineEvent[];

async function seed() {
  for (const [path, text] of Object.entries(CORPUS)) await pipeline.engine.put("files", path, text);
  await pipeline.engine.run();
}
async function ask(id: string, text: string, askedAt = 1): Promise<Answer> {
  await pipeline.engine.put("questions", id, { text, askedAt });
  await pipeline.engine.run();
  return (await pipeline.engine.get("answers", id)) as unknown as Answer;
}

beforeEach(() => {
  events = [];
  pipeline = createPipeline({
    db: new NodeSqlDriver(new DatabaseSync(":memory:")),
    onEvent: (e) => events.push(e),
  });
});

describe("question pipeline", () => {
  it("answers a seeded-topic question citing the right file first", async () => {
    await seed();
    const answer = await ask("q1", "How do I install the package with pnpm?");
    expect(answer.citations[0]).toBe("docs/install.md");
    expect(answer.text).not.toBe(NO_MATCH);
    expect(await pipeline.engine.deadLetters()).toEqual([]);
  });

  it("splits a two-part question and cites both topics", async () => {
    await seed();
    const answer = await ask(
      "q1",
      "How do I install the package with pnpm and how do I configure the lease time?",
    );
    const queries = (await pipeline.engine.get("queries", "q1")) as unknown as Queries;
    expect(queries.subqueries).toHaveLength(2);
    expect(answer.citations).toContain("docs/install.md");
    expect(answer.citations).toContain("docs/config.md");
  });

  it("asking again with a new askedAt re-runs the question; the same value does not", async () => {
    await seed();
    await ask("q1", "How do I install the package?", 1);
    events.length = 0;
    await ask("q1", "How do I install the package?", 1);
    expect(events.filter((e) => e.type === "start" && e.cell === "plan")).toEqual([]);
    await ask("q1", "How do I install the package?", 2);
    expect(events.filter((e) => e.type === "start" && e.cell === "plan").map((e) => e.key)).toEqual(
      ["q1"],
    );
  });

  it("no match: an empty index, or no matching terms, answers NO_MATCH without citations", async () => {
    expect(await ask("q1", "How do I install the package?")).toEqual({
      text: NO_MATCH,
      citations: [],
    });
    await seed();
    expect(await ask("q2", "zebra quantum pancake?")).toEqual({ text: NO_MATCH, citations: [] });
  });

  it("deleted file: a later question never cites it", async () => {
    await seed();
    await pipeline.engine.remove("files", "docs/install.md");
    await pipeline.engine.run();
    const answer = await ask("q1", "How do I install the package with pnpm?");
    expect(answer.citations).not.toContain("docs/install.md");
  });
});
