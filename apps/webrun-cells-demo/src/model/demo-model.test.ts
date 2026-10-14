import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { CORPUS } from "../pipeline/corpus.js";
import { DemoModel } from "./demo-model.js";

const open = (seed = CORPUS) =>
  DemoModel.create({ db: new NodeSqlDriver(new DatabaseSync(":memory:")), seed });

describe("DemoModel", () => {
  it("seeds the corpus and settles with an empty queue", async () => {
    const model = await open();
    await model.settled();
    const snap = model.getSnapshot();
    expect(snap.files.map((f) => f.path)).toEqual(Object.keys(CORPUS).sort());
    expect(Object.values(snap.pending).every((n) => n === 0)).toBe(true);
    expect(snap.busy).toBe(false);
    expect(snap.running).toBeNull();
    expect(snap.log.some((e) => e.type === "start" && e.cell === "split")).toBe(true);
  });

  it("notifies subscribers and replaces the snapshot object on change", async () => {
    const model = await open();
    await model.settled();
    const before = model.getSnapshot();
    let calls = 0;
    const off = model.subscribe(() => calls++);
    await model.editFile("docs/faq.md", "Rewritten. Entirely.");
    await model.settled();
    off();
    expect(calls).toBeGreaterThan(0);
    expect(model.getSnapshot()).not.toBe(before);
    expect((await model.inspectFile("docs/faq.md")).blocks).toEqual(["Rewritten. Entirely."]);
  });

  it("edits during a run are not lost", async () => {
    const model = await open();
    void model.editFile("docs/faq.md", "First version.");
    void model.editFile("docs/faq.md", "Second version.");
    await model.settled();
    const stages = await model.inspectFile("docs/faq.md");
    expect(stages.text).toBe("Second version.");
    expect(stages.blockSummaries.map((b) => b.text)).toEqual(["Second version."]);
  });

  it("deleteFile removes the file and all its stages", async () => {
    const model = await open();
    await model.deleteFile("docs/faq.md");
    await model.settled();
    expect(model.getSnapshot().files.map((f) => f.path)).not.toContain("docs/faq.md");
    const stages = await model.inspectFile("docs/faq.md");
    expect(stages).toEqual({ blocks: [], blockSummaries: [], ftsTerms: [], vectors: [] });
  });

  it("ask returns an id whose stages end in a cited answer", async () => {
    const model = await open();
    const id = await model.ask("How do I install the package with pnpm?");
    await model.settled();
    expect(id).toBe("q1");
    const stages = await model.inspectQuestion(id);
    expect(stages.queries?.subqueries.length).toBeGreaterThan(0);
    expect(stages.candidates?.fts.length).toBeGreaterThan(0);
    expect(stages.answer?.citations[0]).toBe("docs/install.md");
    expect(model.getSnapshot().questions).toEqual([
      { id: "q1", text: "How do I install the package with pnpm?" },
    ]);
  });

  it("randomEdit changes exactly one sentence", async () => {
    const model = await open();
    await model.settled();
    const before = CORPUS["docs/config.md"] as string;
    await model.randomEdit("docs/config.md", () => 0);
    await model.settled();
    const after = (await model.inspectFile("docs/config.md")).text as string;
    expect(after).not.toBe(before);
    expect(after.replace(" (rev 1).", ".")).toBe(before);
  });
});
