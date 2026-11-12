import { DatabaseSync } from "node:sqlite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import {
  type CellDef,
  createBuildEngine,
  MemKV,
  openStore,
  type PersistenceConfig,
} from "./index.js";

const upper: CellDef = {
  id: "upper",
  inputs: ["docs"],
  outputs: ["up"],
  async run(ctx) {
    ctx.emit("up", ctx.key, String(await ctx.get("docs", ctx.key)).toUpperCase());
  },
};

describe("configurable persistence", () => {
  it("defaults to memory", async () => {
    const engine = await createBuildEngine({ cells: [upper] });
    await engine.put("docs", "a", "x");
    await engine.run();
    expect(await engine.get("up", "a")).toBe("X");
  });

  const durable: [string, () => PersistenceConfig][] = [];
  const files = new MemFilesApi();
  durable.push(["files", () => ({ kind: "files", files, path: ".state", compactEvery: 4 })]);
  const db = new DatabaseSync(":memory:");
  durable.push(["sql", () => ({ kind: "sql", driver: new NodeSqlDriver(db), table: "build" })]);
  const custom = new MemKV();
  durable.push(["custom", () => ({ kind: "custom", store: custom })]);

  it.each(durable)(
    "%s: state survives a new engine over the same configuration",
    async (_, cfg) => {
      const e1 = await createBuildEngine({ cells: [upper], persistence: cfg() });
      for (const k of ["a", "b", "c"]) await e1.put("docs", k, k);
      await e1.run({ maxTasks: 2 });
      const log: string[] = [];
      const e2 = await createBuildEngine({
        cells: [
          {
            ...upper,
            run: (ctx) => {
              log.push(ctx.key);
              return upper.run(ctx);
            },
          },
        ],
        persistence: cfg(),
      });
      await e2.run();
      expect(log).toEqual(["c"]);
      expect(await e2.list("up")).toEqual([
        { key: "a", value: "A" },
        { key: "b", value: "B" },
        { key: "c", value: "C" },
      ]);
    },
  );

  it("openStore builds each kind and rejects unknown ones", async () => {
    expect(await openStore({ kind: "memory" })).toBeInstanceOf(MemKV);
    await expect(openStore({ kind: "nope" } as unknown as PersistenceConfig)).rejects.toThrow(
      /Unknown persistence kind "nope"/,
    );
  });
});
