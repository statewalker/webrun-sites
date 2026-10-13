import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver, type SqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const copyCell = () =>
  mapCell("copy", ["docs"], ["out"], (i) => [{ signal: "out", key: i.key, value: i.value }]);

describe("leases", () => {
  it("reclaims work from an engine that never commits, only after leaseMs", async () => {
    const sqlite = new DatabaseSync(":memory:");
    let now = 1_000;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hang: Cell = {
      id: "copy",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const i of inputs) {
          entered();
          await new Promise(() => {}); // a process that died mid-batch
          yield { signal: "out", key: i.key, value: i.value };
        }
      },
    };
    const opts = { leaseMs: 100, now: () => now };
    const a = new CellEngine({ db: new NodeSqlDriver(sqlite), cells: [hang], owner: "A", ...opts });
    const b = new CellEngine({
      db: new NodeSqlDriver(sqlite),
      cells: [copyCell()],
      owner: "B",
      ...opts,
    });
    await a.put("docs", "k", "v");
    void a.run();
    await started;

    now += 99;
    expect(await b.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
    now += 1;
    expect(await b.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await b.get("out", "k")).toBe("v");
  });

  it("commits each input once when two runs of one engine overlap", async () => {
    const c = copyCell();
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    for (const key of ["a", "b", "c"]) await engine.put("docs", key, key);
    const [r1, r2] = await Promise.all([engine.run(), engine.run()]);
    expect(r1.committed + r2.committed).toBe(3);
    expect(c.seen.sort()).toEqual(["docs/a", "docs/b", "docs/c"]);
  });

  it("claims again in the same run when every selected row was taken", async () => {
    const real = memDb();
    let raced = false;
    const db: SqlDriver = {
      all: async <T>(sql: string, ...params: unknown[]) => {
        const rows = await real.all<T>(sql, ...params);
        if (!raced && sql.includes("FROM cells_pending WHERE cell") && rows.length > 0) {
          raced = true; // a change lands between the claim's SELECT and UPDATE
          await real.run("UPDATE cells_pending SET seq = seq + 100");
        }
        return rows;
      },
      run: (sql, ...params) => real.run(sql, ...params),
      transaction: (statements) => real.transaction(statements),
    };
    const engine = new CellEngine({ db, cells: [copyCell()] });
    await engine.put("docs", "a", 1);
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "a")).toBe(1);
  });

  it("releases its own leases when a commit fails, so the next run() does the work", async () => {
    const real = memDb();
    let failNext = false;
    const db: SqlDriver = {
      all: (sql, ...params) => real.all(sql, ...params),
      run: (sql, ...params) => real.run(sql, ...params),
      transaction: async (statements) => {
        if (failNext && statements[0]?.sql.startsWith("DELETE FROM cells_provenance")) {
          failNext = false;
          throw new Error("SQLITE_BUSY");
        }
        return real.transaction(statements);
      },
    };
    const engine = new CellEngine({ db, cells: [copyCell()] });
    await engine.put("docs", "a", 1);
    failNext = true;
    await expect(engine.run()).rejects.toThrow(/SQLITE_BUSY/);
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "a")).toBe(1);

    // The same for a removal, which commits without running the cell.
    await engine.remove("docs", "a");
    failNext = true;
    await expect(engine.run()).rejects.toThrow(/SQLITE_BUSY/);
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.list("out")).toEqual([]);
  });
});
