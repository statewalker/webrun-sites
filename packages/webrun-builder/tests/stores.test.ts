import { DatabaseSync } from "node:sqlite";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { BuildEngine, type BuilderDef, FilesKV, type KV, MemKV, SqlKV } from "../src/index.js";

const stores: [string, () => Promise<KV>][] = [
  ["MemKV", async () => new MemKV()],
  ["SqlKV", async () => new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:")), "kv", 2)],
  ["FilesKV", async () => FilesKV.open(new MemFilesApi(), "state", { compactEvery: 3 })],
];

async function collect(kv: KV, prefix: string, opts?: { after?: string; limit?: number }) {
  const out: string[] = [];
  for await (const [key, value] of kv.scan(prefix, opts)) out.push(`${key}=${value}`);
  return out;
}

describe.each(stores)("%s — the KV port", (_name, open) => {
  it("gets, scans by prefix in key order, pages with after/limit, commits atomically", async () => {
    const kv = await open();
    await kv.commit([
      { key: "a\u0001b", value: "1" },
      { key: "a\u0001a", value: "2" },
      { key: "a\u0001c", value: "3" },
      { key: "ab", value: "x" },
      { key: "b", value: "y" },
    ]);
    expect(await kv.get("a\u0001b")).toBe("1");
    expect(await kv.get("nope")).toBeUndefined();
    expect(await collect(kv, "a\u0001")).toEqual(["a\u0001a=2", "a\u0001b=1", "a\u0001c=3"]);
    expect(await collect(kv, "a\u0001", { after: "a\u0001a", limit: 1 })).toEqual(["a\u0001b=1"]);
    await kv.commit([{ key: "a\u0001b" }, { key: "a\u0001c", value: "4" }]);
    expect(await collect(kv, "a\u0001")).toEqual(["a\u0001a=2", "a\u0001c=4"]);
  });

  it("tolerates commits while a scan is iterating", async () => {
    const kv = await open();
    await kv.commit(["p\u00011", "p\u00012", "p\u00013"].map((key) => ({ key, value: "v" })));
    const seen: string[] = [];
    for await (const [key] of kv.scan("p\u0001")) {
      seen.push(key);
      await kv.commit([{ key }]);
    }
    expect(seen).toEqual(["p\u00011", "p\u00012", "p\u00013"]);
  });
});

describe("FilesKV — persistence", () => {
  it("replays the snapshot and the log after a reopen, across compactions", async () => {
    const files = new MemFilesApi();
    const kv = await FilesKV.open(files, "s", { compactEvery: 2 });
    for (let i = 0; i < 5; i++) await kv.commit([{ key: `k${i}`, value: String(i) }]);
    await kv.commit([{ key: "k0" }]);
    const again = await FilesKV.open(files, "s", { compactEvery: 2 });
    expect(await collect(again, "k")).toEqual(["k1=1", "k2=2", "k3=3", "k4=4"]);
    const names: string[] = [];
    for await (const info of files.list("s/log")) names.push(info.name);
    expect(names.length).toBeLessThan(2); // folded into snapshot.json
  });

  it("an engine over FilesKV resumes where the previous process stopped", async () => {
    const files = new MemFilesApi();
    const log: string[] = [];
    const builder: BuilderDef = {
      id: "up",
      inputs: ["docs"],
      outputs: ["up"],
      async run(ctx) {
        log.push(ctx.key);
        ctx.emit("up", ctx.key, String(await ctx.get("docs", ctx.key)).toUpperCase());
      },
    };
    const e1 = new BuildEngine({
      store: await FilesKV.open(files, ".state"),
      builders: [builder],
      batchSize: 1,
    });
    for (const key of ["a", "b", "c"]) await e1.put("docs", key, key);
    await e1.run({ maxTasks: 2 }); // "killed" after two tasks
    const e2 = new BuildEngine({ store: await FilesKV.open(files, ".state"), builders: [builder] });
    await e2.run();
    expect(log).toEqual(["a", "b", "c"]);
    expect(await e2.list("up")).toEqual([
      { key: "a", value: "A" },
      { key: "b", value: "B" },
      { key: "c", value: "C" },
    ]);
  });
});

describe("MemKV — ordering under many inserts and deletes", () => {
  it("matches a sorted reference across block splits and merges", async () => {
    const kv = new MemKV();
    const ref = new Map<string, string>();
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 20; round++) {
      const writes = Array.from({ length: 300 }, () => {
        const key = `k${Math.floor(rand() * 2000)}`;
        return rand() < 0.3 ? { key } : { key, value: String(round) };
      });
      await kv.commit(writes);
      for (const w of writes) {
        if (w.value === undefined) ref.delete(w.key);
        else ref.set(w.key, w.value);
      }
    }
    const want = [...ref.keys()].sort();
    expect((await collect(kv, "")).map((r) => r.split("=")[0])).toEqual(want);
    expect((await collect(kv, "k1")).length).toBe(want.filter((x) => x.startsWith("k1")).length);
    const mid = want[Math.floor(want.length / 2)] as string;
    expect((await collect(kv, "", { after: mid, limit: 3 })).map((r) => r.split("=")[0])).toEqual(
      want.slice(want.indexOf(mid) + 1, want.indexOf(mid) + 4),
    );
  });
});
