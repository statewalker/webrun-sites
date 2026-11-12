/**
 * Regression tests for the findings of the independent review of PR #28
 * (each scenario failed before its fix).
 */
import { DatabaseSync } from "node:sqlite";
import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import { BuildEngine, type CellDef, FilesKV, MemKV, SqlKV } from "./index.js";

describe("review: verify, reset and incremental reduce", () => {
  it("B1: map task that list()s a signal is skipped by verify-before-execute when that signal changes", async () => {
    const cell: CellDef = {
      id: "m",
      inputs: ["docs"],
      reads: ["cfg"],
      outputs: ["out"],
      async run(ctx) {
        const cfg = await ctx.list("cfg");
        ctx.emit(
          "out",
          ctx.key,
          `${await ctx.get("docs", ctx.key)}:${cfg.map((r) => r.value).join(",")}`,
        );
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [cell] });
    await e.put("docs", "a", "x");
    await e.put("cfg", "c1", "v1");
    await e.run();
    expect(await e.get("out", "a")).toBe("x:v1");
    await e.put("cfg", "c1", "v2");
    await e.run();
    expect(await e.get("out", "a")).toBe("x:v2");
  });

  it("B2: incremental reduce loses a change landing while it runs (record not refreshed)", async () => {
    let gate: (() => void) | undefined;
    let hold: Promise<void> | undefined;
    const sum: CellDef = {
      id: "sum",
      kind: "reduce",
      incremental: true,
      inputs: ["n"],
      outputs: ["total"],
      async run(ctx) {
        let s = ctx.state as Record<string, number> | undefined;
        if (s === undefined) {
          s = {};
          for (const r of await ctx.list("n")) s[r.key] = r.value as number;
        } else {
          s = { ...s };
          for (const c of await ctx.changes("n")) {
            if (c.value === undefined) delete s[c.key];
            else s[c.key] = c.value as number;
          }
        }
        if (hold) await hold;
        ctx.setState(s);
        ctx.emit(
          "total",
          "t",
          Object.values(s).reduce((a, b) => a + b, 0),
        );
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [sum] });
    await e.put("n", "a", 1);
    await e.run();
    expect(await e.get("total", "t")).toBe(1);
    await e.put("n", "a", 2); // creates change record c/sum/n/a
    hold = new Promise((r) => {
      gate = r;
    });
    const running = e.run();
    await new Promise((r) => setTimeout(r, 20)); // reducer has read changes() => a=2, now waits
    await e.put("n", "a", 5); // record exists -> not rewritten; queue re-armed
    hold = undefined;
    gate?.();
    await running;
    expect(await e.get("n", "a")).toBe(5);
    expect(await e.get("total", "t")).toBe(5);
  });

  it("B3: invalidate(reducer) state reset (z) is lost when a put re-queues it before the run", async () => {
    let version = 1;
    const sum: CellDef = {
      id: "sum",
      kind: "reduce",
      incremental: true,
      inputs: ["n"],
      outputs: ["total"],
      async run(ctx) {
        let s = ctx.state as number | undefined;
        if (s === undefined) {
          s = 0;
          for (const r of await ctx.list("n")) s += (r.value as number) * version;
        } else {
          for (const c of await ctx.changes("n"))
            s += (((c.value as number) ?? 0) - ((c.previous as number) ?? 0)) * version;
        }
        ctx.setState(s);
        ctx.emit("total", "t", s);
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [sum] });
    await e.put("n", "a", 1);
    await e.put("n", "b", 1);
    await e.run();
    expect(await e.get("total", "t")).toBe(2);
    version = 10; // code changed: multiply by 10
    await e.invalidate("sum");
    await e.put("n", "c", 1); // overwrites q/sum/* without z
    await e.run();
    expect(await e.get("total", "t")).toBe(30);
  });

  it("B3b: invalidate(map) then change+undo of input skips the new code", async () => {
    let version = 1;
    const cell: CellDef = {
      id: "m",
      inputs: ["docs"],
      outputs: ["out"],
      async run(ctx) {
        ctx.emit("out", ctx.key, `${await ctx.get("docs", ctx.key)}@${version}`);
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [cell] });
    await e.put("docs", "a", "x");
    await e.run();
    version = 2;
    await e.invalidate("m");
    await e.put("docs", "a", "y");
    await e.put("docs", "a", "x");
    await e.run();
    expect(await e.get("out", "a")).toBe("x@2");
  });
});

describe("review: races, requeue, shared engines, removed cells", () => {
  it("B2b: incremental reduce double-counts a change landing between the change snapshot and ctx.list (recompute path)", async () => {
    let hold: Promise<void> | undefined;
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    const total: CellDef = {
      id: "total",
      kind: "reduce",
      incremental: true,
      inputs: ["len"],
      outputs: ["total"],
      async run(ctx) {
        let s = ctx.state as { sum: number } | undefined;
        if (hold) {
          started();
          await hold;
        }
        if (!s) s = { sum: (await ctx.list("len")).reduce((a, r) => a + Number(r.value), 0) };
        else
          for (const c of await ctx.changes("len"))
            s.sum += Number(c.value ?? 0) - Number(c.previous ?? 0);
        ctx.setState(s);
        ctx.emit("total", "sum", s.sum);
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [total] });
    await e.put("len", "a", 1);
    let release!: () => void;
    hold = new Promise((r) => {
      release = r;
    });
    const p = e.run(); // first run: state undefined -> recompute via list
    await startedP;
    await e.put("len", "b", 10); // new c record created after the snapshot
    hold = undefined;
    release();
    await p;
    expect(await e.get("total", "sum")).toBe(11);
  });

  it("B6: requeue of a dead letter after invalidate is skipped by verify (z dropped)", async () => {
    let version = 1;
    const cell: CellDef = {
      id: "m",
      inputs: ["docs"],
      outputs: ["out"],
      async run(ctx) {
        if (version === 2) throw new Error("bug in v2");
        ctx.emit("out", ctx.key, `${await ctx.get("docs", ctx.key)}@${version}`);
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [cell] });
    await e.put("docs", "a", "x");
    await e.run();
    version = 2;
    await e.invalidate("m");
    const s1 = await e.run();
    expect(s1.deadLettered).toBe(1);
    version = 3; // fixed
    await e.requeue("m", "a");
    await e.run();
    expect(await e.get("out", "a")).toBe("x@3");
  });

  it("B7: skipped task keeps a stale dead letter", async () => {
    const cell: CellDef = {
      id: "m",
      inputs: ["docs"],
      outputs: ["out"],
      async run(ctx) {
        const v = await ctx.get("docs", ctx.key);
        if (v === "bad") throw new Error("bad");
        ctx.emit("out", ctx.key, String(v));
      },
    };
    const e = new BuildEngine({ store: new MemKV(), cells: [cell] });
    await e.put("docs", "a", "x");
    await e.run();
    await e.put("docs", "a", "bad");
    await e.run();
    expect((await e.status()).deadLetters).toBe(1);
    await e.put("docs", "a", "x");
    await e.run();
    expect((await e.status()).deadLetters).toBe(0);
  });

  it("B4: shared engines - a put drops the lease, second engine runs the same task, slow stale result overwrites", async () => {
    const store = new MemKV();
    let gate!: () => void;
    const hold = new Promise<void>((r) => {
      gate = r;
    });
    const mk = (slow: boolean): CellDef => ({
      id: "m",
      inputs: ["docs"],
      outputs: ["out"],
      async run(ctx) {
        const v = await ctx.get("docs", ctx.key);
        if (slow) await hold;
        ctx.emit("out", ctx.key, `${v}`);
      },
    });
    const A = new BuildEngine({ store, cells: [mk(true)], shared: true, owner: "A" });
    const B = new BuildEngine({ store, cells: [mk(false)], shared: true, owner: "B" });
    await A.put("docs", "a", "v1");
    const ra = A.run();
    await new Promise((r) => setTimeout(r, 10)); // A leased and is executing (read v1)
    await B.put("docs", "a", "v2"); // rewrites queue row, dropping A's lease
    await B.run();
    gate();
    await ra;
    expect(await A.get("docs", "a")).toBe("v2");
    expect((await A.status()).queued).toEqual({});
    expect(await A.get("out", "a")).toBe("v2");
  });

  it("B4b: lease expiry - slow engine commits stale outputs after another engine re-ran the task", async () => {
    const store = new MemKV();
    let t = 0;
    let gate!: () => void;
    const hold = new Promise<void>((r) => {
      gate = r;
    });
    let slow = true;
    const cell: CellDef = {
      id: "m",
      inputs: ["docs"],
      outputs: ["out"],
      async run(ctx) {
        const v = await ctx.get("docs", ctx.key);
        if (slow) {
          slow = false;
          await hold;
        }
        ctx.emit("out", ctx.key, `${v}`);
      },
    };
    const A = new BuildEngine({
      store,
      cells: [cell],
      shared: true,
      owner: "A",
      leaseMs: 100,
      now: () => t,
    });
    const B = new BuildEngine({
      store,
      cells: [cell],
      shared: true,
      owner: "B",
      leaseMs: 100,
      now: () => t,
    });
    await A.put("docs", "a", "v1");
    const ra = A.run();
    await new Promise((r) => setTimeout(r, 10));
    t = 1000; // lease expired
    await B.put("docs", "a", "v2"); // this alone also drops lease; but even without put, B claims
    await B.run();
    gate();
    await ra;
    expect(await A.get("out", "a")).toBe("v2");
  });

  it("B5: removing a cell that has queued work wedges run() forever", async () => {
    const store = new MemKV();
    const a: CellDef = {
      id: "a",
      inputs: ["docs"],
      outputs: ["A"],
      run(ctx) {
        ctx.emit("A", ctx.key, 1);
      },
    };
    const old: CellDef = {
      id: "old",
      inputs: ["docs"],
      outputs: ["O"],
      run(ctx) {
        ctx.emit("O", ctx.key, 1);
      },
    };
    const e1 = new BuildEngine({ store, cells: [a, old] });
    await e1.put("docs", "k", "x"); // queues a/k and old/k
    // new deploy drops `old`
    const e2 = new BuildEngine({ store, cells: [a] });
    let err: unknown;
    try {
      await e2.run();
    } catch (x) {
      err = x;
    }
    try {
      await e2.run();
    } catch (x) {
      console.log("again:", String(x));
    }
    expect(err).toBeUndefined();
  });

  it("queue rows written under an old cell order are still run upstream-first after a reorder", async () => {
    const store = new MemKV();
    const a: CellDef = {
      id: "a",
      inputs: ["docs"],
      outputs: ["A"],
      run: (ctx) => ctx.emit("A", ctx.key, 1),
    };
    const b: CellDef = {
      id: "b",
      inputs: ["A"],
      outputs: ["B"],
      async run(ctx) {
        ctx.emit("B", ctx.key, Number(await ctx.get("A", ctx.key)) + 1);
      },
    };
    const extra: CellDef = {
      id: "extra",
      inputs: ["docs"],
      outputs: ["X"],
      run: (ctx) => ctx.emit("X", ctx.key, 0),
    };
    const e1 = new BuildEngine({ store, cells: [a, b] });
    await e1.put("docs", "k", "x"); // queued under a's old rank
    const ran: string[] = [];
    const tracked = [extra, a, b].map((c) => ({
      ...c,
      run(ctx: Parameters<CellDef["run"]>[0]) {
        ran.push(c.id);
        return c.run(ctx);
      },
    }));
    const e2 = new BuildEngine({ store, cells: tracked }); // ranks shift
    await e2.put("docs", "k", "y"); // re-queues a/k under its new rank
    await e2.run();
    expect(ran.filter((id) => id === "a")).toEqual(["a"]); // not twice (no duplicate rows)
    expect(await e2.get("B", "k")).toBe(2);
    expect(await e2.status()).toEqual({ queued: {}, deadLetters: 0 });
  });

  it("rejects incremental reduce cells on a shared store", () => {
    const r: CellDef = {
      id: "r",
      kind: "reduce",
      incremental: true,
      inputs: ["n"],
      outputs: ["o"],
      run() {},
    };
    expect(() => new BuildEngine({ store: new MemKV(), cells: [r], shared: true })).toThrow(
      /incremental reduce cells are not supported with shared: true/,
    );
  });

  it("put/remove reject keys with reserved characters", async () => {
    const e = new BuildEngine({ store: new MemKV(), cells: [] });
    await expect(e.put("docs", "a\u0001b", 1)).rejects.toThrow(/reserved control character/);
  });
});

describe("review: stores", () => {
  it("SqlKV and MemKV agree on delete-if-absent of a present key", async () => {
    for (const kv of [new MemKV(), new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:")))]) {
      await kv.commit([{ key: "k", value: "v" }]);
      expect(await kv.commit([{ key: "k", ifValue: null }])).toEqual([false]);
      expect(await kv.get("k")).toBe("v");
      expect(await kv.commit([{ key: "gone", ifValue: null }])).toEqual([true]);
    }
  });

  it("guarded writes apply only while the guard key holds its value, in order", async () => {
    for (const kv of [new MemKV(), new SqlKV(new NodeSqlDriver(new DatabaseSync(":memory:")))]) {
      await kv.commit([{ key: "q", value: "claim" }]);
      const guard = { key: "q", value: "claim" };
      expect(
        await kv.commit([
          { key: "out", value: "1", guard },
          { key: "q", ifValue: "claim" }, // dequeue last
          { key: "late", value: "x", guard }, // guard no longer holds
        ]),
      ).toEqual([true, true, false]);
      expect(await kv.get("out")).toBe("1");
      expect(await kv.get("late")).toBeUndefined();
      expect(await kv.commit([{ key: "out", guard }])).toEqual([false]);
      expect(await kv.get("out")).toBe("1");
    }
  });

  it("FilesKV refuses a corrupt snapshot instead of replaying onto empty state", async () => {
    const files = new MemFilesApi();
    const kv = await FilesKV.open(files, "s", { compactEvery: 2 });
    for (let i = 0; i < 3; i++) await kv.commit([{ key: `k${i}`, value: "v" }]);
    await writeText(files, "s/snapshot.json", "{ not json");
    await expect(FilesKV.open(files, "s")).rejects.toThrow(/corrupt/);
  });
});
