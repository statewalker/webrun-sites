/**
 * Tests for the limits documented in the first version of the engine, and for
 * a race found while analysing them.
 */
import { DatabaseSync } from "node:sqlite";
import { NodeSqlDriver } from "@statewalker/webrun-files-sqlite";
import { describe, expect, it } from "vitest";
import {
  BuildEngine,
  type CellDef,
  CrashError,
  CrashingKV,
  type Json,
  MemKV,
  SqlKV,
} from "./index.js";

const log = (cells: CellDef[], out: string[]): CellDef[] =>
  cells.map((c) => ({
    ...c,
    run(ctx) {
      out.push(`${c.id}/${ctx.key}`);
      return c.run(ctx);
    },
  }));

const upper: CellDef = {
  id: "upper",
  inputs: ["docs"],
  outputs: ["up"],
  async run(ctx) {
    ctx.emit("up", ctx.key, String(await ctx.get("docs", ctx.key)).toUpperCase());
  },
};

/** mods/<k> = { code, imports } → compiled/<k> = code + imported codes (dynamic reads). */
const compile: CellDef = {
  id: "compile",
  inputs: ["mods"],
  outputs: ["compiled"],
  async run(ctx) {
    const mod = (await ctx.get("mods", ctx.key)) as { code: string; imports: string[] };
    const parts = [mod.code];
    for (const d of mod.imports) {
      const dep = (await ctx.get("mods", d)) as { code: string } | undefined;
      parts.push(dep?.code ?? "?");
    }
    ctx.emit("compiled", ctx.key, parts.join("|"));
  },
};

describe("net no-op changes do not re-run tasks (verify before execute)", () => {
  it("remove + put back the same value before a run executes nothing", async () => {
    const ran: string[] = [];
    const engine = new BuildEngine({ store: new MemKV(), cells: log([upper], ran) });
    await engine.put("docs", "a", "x");
    await engine.run();
    ran.length = 0;
    await engine.remove("docs", "a");
    await engine.put("docs", "a", "x");
    expect(await engine.run()).toMatchObject({ executed: 0 });
    expect(ran).toEqual([]);
    expect(await engine.status()).toEqual({ queued: {}, deadLetters: 0 });
  });

  it("a dependency changed and changed back does not re-run its readers", async () => {
    const ran: string[] = [];
    const engine = new BuildEngine({ store: new MemKV(), cells: log([compile], ran) });
    await engine.put("mods", "main", { code: "M", imports: ["util"] });
    await engine.put("mods", "util", { code: "U", imports: [] });
    await engine.run();
    ran.length = 0;
    await engine.put("mods", "util", { code: "U2", imports: [] });
    await engine.put("mods", "util", { code: "U", imports: [] });
    await engine.run();
    expect(ran).toEqual([]);
  });

  it("still runs a task whose reads really changed", async () => {
    const ran: string[] = [];
    const engine = new BuildEngine({ store: new MemKV(), cells: log([compile], ran) });
    await engine.put("mods", "main", { code: "M", imports: ["util"] });
    await engine.put("mods", "util", { code: "U", imports: [] });
    await engine.run();
    ran.length = 0;
    await engine.put("mods", "util", { code: "U3", imports: [] });
    await engine.run();
    expect(ran.sort()).toEqual(["compile/main", "compile/util"]);
    expect(await engine.get("compiled", "main")).toBe("M|U3");
  });
});

describe("a write that lands while a task runs is never lost", () => {
  it("a dynamically read source row changed mid-task re-runs the task", async () => {
    let engine: BuildEngine;
    let raced = false;
    const racing: CellDef = {
      ...compile,
      async run(ctx) {
        await compile.run(ctx);
        if (ctx.key === "main" && !raced) {
          raced = true; // main has read util; util changes before main commits
          await engine.put("mods", "util", { code: "U2", imports: [] });
        }
      },
    };
    engine = new BuildEngine({ store: new MemKV(), cells: [racing] });
    await engine.put("mods", "main", { code: "M", imports: ["util"] });
    await engine.put("mods", "util", { code: "U", imports: [] });
    while ((await engine.run()).pending) {}
    expect(await engine.get("compiled", "main")).toBe("M|U2");
    expect(await engine.status()).toEqual({ queued: {}, deadLetters: 0 });
  });
});

describe("ownership hand-over inside one run", () => {
  it("a task takes over a row from a stale (queued) owner without failing", async () => {
    // `early` (upstream rank) and `late` both may emit out/shared, depending on their input.
    const early: CellDef = {
      id: "early",
      inputs: ["a"],
      outputs: ["out"],
      async run(ctx) {
        if ((await ctx.get("a", ctx.key)) === "claim") ctx.emit("out", "shared", "from-early");
      },
    };
    const late: CellDef = {
      id: "late",
      inputs: ["b"],
      outputs: ["out", "late-done"],
      async run(ctx) {
        if ((await ctx.get("b", ctx.key)) === "claim") ctx.emit("out", "shared", "from-late");
        ctx.emit("late-done", ctx.key, true);
      },
    };
    const engine = new BuildEngine({ store: new MemKV(), cells: [early, late], maxAttempts: 1 });
    await engine.put("a", "k", "idle");
    await engine.put("b", "k", "claim");
    await engine.run();
    expect(await engine.get("out", "shared")).toBe("from-late");
    // Hand-over in one run: late lets go, early takes it; early runs first.
    await engine.put("a", "k", "claim");
    await engine.put("b", "k", "idle");
    const stats = await engine.run();
    expect(stats).toMatchObject({ failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "shared")).toBe("from-early");
    expect(await engine.deadLetters()).toEqual([]);
  });

  it("a genuine conflict (both keep emitting) still fails the later task", async () => {
    const both = (id: string, input: string): CellDef => ({
      id,
      inputs: [input],
      outputs: ["out"],
      run: (ctx) => ctx.emit("out", "shared", id),
    });
    const engine = new BuildEngine({
      store: new MemKV(),
      cells: [both("one", "a"), both("two", "b")],
      maxAttempts: 1,
    });
    await engine.put("a", "k", 1);
    await engine.put("b", "k", 1);
    const stats = await engine.run();
    expect(stats.deadLettered).toBe(1);
    expect((await engine.deadLetters())[0]?.error).toMatch(/ConflictingEmission/);
  });
});

describe("incremental reduce", () => {
  /** sum/count over len rows, folded from changes; counts full listings. */
  const make = (listed: { n: number }): CellDef => ({
    id: "total",
    kind: "reduce",
    incremental: true,
    inputs: ["len"],
    outputs: ["total"],
    async run(ctx) {
      let state = ctx.state as { sum: number; count: number } | undefined;
      if (!state) {
        listed.n++;
        const rows = await ctx.list("len");
        state = { sum: rows.reduce((a, r) => a + Number(r.value), 0), count: rows.length };
      } else {
        for (const c of await ctx.changes("len")) {
          if (c.previous !== undefined) {
            state.sum -= Number(c.previous);
            state.count--;
          }
          if (c.value !== undefined) {
            state.sum += Number(c.value);
            state.count++;
          }
        }
      }
      ctx.setState(state as unknown as Json);
      ctx.emit("total", "all", state as unknown as Json);
    },
  });
  const len: CellDef = {
    id: "len",
    inputs: ["docs"],
    outputs: ["len"],
    async run(ctx) {
      ctx.emit("len", ctx.key, String(await ctx.get("docs", ctx.key)).length);
    },
  };

  it("folds changes (with previous values) instead of re-listing the input", async () => {
    const listed = { n: 0 };
    const store = new MemKV();
    const engine = new BuildEngine({ store, cells: [len, make(listed)] });
    for (const [k, v] of [
      ["a", "xx"],
      ["b", "yyy"],
      ["c", "z"],
    ])
      await engine.put("docs", k as string, v as string);
    await engine.run();
    expect(await engine.get("total", "all")).toEqual({ sum: 6, count: 3 });
    expect(listed.n).toBe(1);

    await engine.put("docs", "a", "xxxxx"); // 2 → 5
    await engine.remove("docs", "b"); // −3
    await engine.put("docs", "d", "qq"); // +2
    await engine.run();
    expect(await engine.get("total", "all")).toEqual({ sum: 8, count: 3 });
    expect(listed.n).toBe(1);

    // State and pending changes survive a new engine instance.
    await engine.put("docs", "c", "zzzz"); // 1 → 4
    const again = new BuildEngine({ store, cells: [len, make(listed)] });
    await again.run();
    expect(await again.get("total", "all")).toEqual({ sum: 11, count: 3 });
    expect(listed.n).toBe(1);
  });

  it("invalidate resets the state (full recompute)", async () => {
    const listed = { n: 0 };
    const engine = new BuildEngine({ store: new MemKV(), cells: [len, make(listed)] });
    await engine.put("docs", "a", "xx");
    await engine.run();
    await engine.invalidate("total");
    await engine.run();
    expect(listed.n).toBe(2);
    expect(await engine.get("total", "all")).toEqual({ sum: 2, count: 1 });
  });

  it("rejects incremental on map cells", () => {
    expect(
      () => new BuildEngine({ store: new MemKV(), cells: [{ ...upper, incremental: true }] }),
    ).toThrow(/only reduce cells can be incremental/);
  });
});

describe("several engines (processes) on one store", () => {
  const slowUpper = (ran: string[]): CellDef => ({
    ...upper,
    async run(ctx) {
      ran.push(ctx.key);
      await new Promise((r) => setTimeout(r, 1));
      await upper.run(ctx);
    },
  });

  it("share the work without running a task twice (leases)", async () => {
    const db = new DatabaseSync(":memory:");
    const ran: string[] = [];
    const a = new BuildEngine({
      store: new SqlKV(new NodeSqlDriver(db)),
      cells: [slowUpper(ran)],
      batchSize: 8,
      shared: true,
    });
    const b = new BuildEngine({
      store: new SqlKV(new NodeSqlDriver(db)),
      cells: [slowUpper(ran)],
      batchSize: 8,
      shared: true,
    });
    for (let i = 0; i < 100; i++) await a.put("docs", `k${String(i).padStart(3, "0")}`, `v${i}`);
    const drain = async (e: BuildEngine) => {
      for (let n = 0; n < 100; n++) {
        if (!(await e.run()).pending) return;
        await new Promise((r) => setTimeout(r, 2));
      }
    };
    await Promise.all([drain(a), drain(b)]);
    expect(ran.length).toBe(100);
    expect(new Set(ran).size).toBe(100);
    expect((await b.list("up")).length).toBe(100);
    expect(await a.status()).toEqual({ queued: {}, deadLetters: 0 });
  });

  it("a crashed process's leases expire and another process takes over", async () => {
    let now = 1_000;
    const store = new MemKV();
    const ran: string[] = [];
    const seed = new BuildEngine({ store, cells: [upper] });
    for (const k of ["a", "b", "c"]) await seed.put("docs", k, k);
    // Process A claims a batch, then dies at its next commit (the batch commit).
    const crashing = new BuildEngine({
      store: new CrashingKV(store, 2),
      cells: [upper],
      shared: true,
      leaseMs: 5_000,
      now: () => now,
    });
    await expect(crashing.run()).rejects.toBeInstanceOf(CrashError);
    // Process B: the rows are leased by the dead process — nothing to do yet.
    const b = new BuildEngine({
      store,
      cells: log([upper], ran),
      shared: true,
      leaseMs: 5_000,
      now: () => now,
    });
    expect(await b.run()).toMatchObject({ executed: 0, pending: true });
    now += 6_000;
    expect(await b.run()).toMatchObject({ executed: 3, pending: false });
    expect(ran.sort()).toEqual(["upper/a", "upper/b", "upper/c"]);
  });
});
