import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell } from "./test-helpers.js";

const dir = mkdtempSync(join(tmpdir(), "webrun-cells-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const split = () =>
  mapCell("split", ["docs"], ["chunks"], (i) => {
    if (i.key === "bad") throw new Error("boom");
    return String(i.value)
      .split(" ")
      .map((word, n) => ({ signal: "chunks", key: `${i.key}#${n}`, value: word }));
  });

/** Open the file database, run `fn` against a fresh engine, close it. */
async function session<T>(file: string, fn: (engine: CellEngine) => Promise<T>): Promise<T> {
  const sqlite = new DatabaseSync(file);
  try {
    return await fn(new CellEngine({ db: new NodeSqlDriver(sqlite), cells: [split()], maxAttempts: 1 }));
  } finally {
    sqlite.close();
  }
}

describe("persistence", () => {
  it("keeps queue, rows, provenance and dead letters across reopening", async () => {
    const file = join(dir, "cells.db");
    await session(file, async (e) => {
      await e.put("docs", "a", "x y");
      await e.put("docs", "bad", "z");
    });
    await session(file, async (e) => {
      expect(await e.run()).toEqual({ committed: 1, failed: 1, deadLettered: 1 }); // the queue survived
    });
    await session(file, async (e) => {
      expect((await e.list("chunks")).map((r) => r.key)).toEqual(["a#0", "a#1"]);
      expect((await e.deadLetters()).map((d) => d.key)).toEqual(["bad"]);
      await e.remove("docs", "a");
    });
    await session(file, async (e) => {
      await e.run();
      expect(await e.list("chunks")).toEqual([]); // provenance survived
    });
  });
});
