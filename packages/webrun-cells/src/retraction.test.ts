import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";

const split = () =>
  mapCell("split", ["docs"], ["chunks"], (i) =>
    String(i.value)
      .split(" ")
      .map((word, n) => ({ signal: "chunks", key: `${i.key}#${n}`, value: word })),
  );
const upper = () =>
  mapCell("upper", ["chunks"], ["upper"], (i) => [
    { signal: "upper", key: i.key, value: String(i.value).toUpperCase() },
  ]);

describe("retraction", () => {
  it("deletes outputs a re-run no longer emits, and cascades without invoking cells", async () => {
    const u = upper();
    const engine = new CellEngine({ db: memDb(), cells: [split(), u] });
    await engine.put("docs", "a", "x y z");
    await engine.run();
    await engine.put("docs", "a", "x y");
    await engine.run();
    expect((await engine.list("chunks")).map((r) => r.key)).toEqual(["a#0", "a#1"]);
    expect((await engine.list("upper")).map((r) => r.key)).toEqual(["a#0", "a#1"]);
    expect(u.seen).toEqual(["chunks/a#0", "chunks/a#1", "chunks/a#2"]);
  });

  it("retracts everything derived from a removed source", async () => {
    const s = split();
    const engine = new CellEngine({ db: memDb(), cells: [s, upper()] });
    await engine.put("docs", "a", "x y");
    await engine.put("docs", "b", "w");
    await engine.run();
    await engine.remove("docs", "a");
    await engine.run();
    expect(await engine.list("chunks")).toEqual([{ key: "b#0", value: "w" }]);
    expect(await engine.list("upper")).toEqual([{ key: "b#0", value: "W" }]);
    expect(s.seen).toEqual(["docs/a", "docs/b"]);
  });

  it("keeps an output another input still produces", async () => {
    const words = mapCell("words", ["docs"], ["words"], (i) =>
      String(i.value)
        .split(" ")
        .map((w) => ({ signal: "words", key: w, value: w })),
    );
    const engine = new CellEngine({ db: memDb(), cells: [words] });
    await engine.put("docs", "a", "x y");
    await engine.put("docs", "b", "y z");
    await engine.run();
    expect((await engine.list("words")).map((r) => r.key)).toEqual(["x", "y", "z"]);
    await engine.remove("docs", "a");
    await engine.run();
    expect((await engine.list("words")).map((r) => r.key)).toEqual(["y", "z"]);
    await engine.remove("docs", "b");
    await engine.run();
    expect(await engine.list("words")).toEqual([]);
  });
});
