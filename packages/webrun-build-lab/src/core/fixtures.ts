/**
 * Cell fixtures shared by the conformance suite and the benchmark. Every cell
 * is a pure function of what it reads; executions are recorded in `log`.
 */
import type { CellDef, Engine, Json } from "./types.js";

export interface Recorder {
  /** `cell/key` of every execution, in order. */
  log: string[];
  count(cell: string, key?: string): number;
  reset(): void;
}

export function recorder(): Recorder {
  const log: string[] = [];
  return {
    log,
    count(cell, key) {
      const exact = key === undefined ? undefined : `${cell}/${key}`;
      return log.filter((e) => (exact ? e === exact : e.startsWith(`${cell}/`))).length;
    },
    reset() {
      log.length = 0;
    },
  };
}

/** Wrap cells so each execution is appended to `rec.log`. */
export function recorded(rec: Recorder, cells: CellDef[]): CellDef[] {
  return cells.map((c) => ({
    ...c,
    run(ctx) {
      rec.log.push(`${c.id}/${ctx.key}`);
      return c.run(ctx);
    },
  }));
}

/** docs/<k> = "w1 w2" → chunks/<k>#<n> = "wn" */
export const split: CellDef = {
  id: "split",
  inputs: ["docs"],
  outputs: ["chunks"],
  async run(ctx) {
    const text = await ctx.get("docs", ctx.key);
    String(text)
      .split(" ")
      .forEach((w, n) => {
        ctx.emit("chunks", `${ctx.key}#${n}`, w);
      });
  },
};

/** chunks/<k> → upper/<k> */
export const upper: CellDef = {
  id: "upper",
  inputs: ["chunks"],
  outputs: ["upper"],
  async run(ctx) {
    ctx.emit("upper", ctx.key, String(await ctx.get("chunks", ctx.key)).toUpperCase());
  },
};

/** docs/<k> → len/<k> = text length (an early cut-off point). */
export const len: CellDef = {
  id: "len",
  inputs: ["docs"],
  outputs: ["len"],
  async run(ctx) {
    ctx.emit("len", ctx.key, String(await ctx.get("docs", ctx.key)).length);
  },
};

/** len/<k> → len2/<k> = len * 2 (downstream of the cut-off point). */
export const double: CellDef = {
  id: "double",
  inputs: ["len"],
  outputs: ["len2"],
  async run(ctx) {
    ctx.emit("len2", ctx.key, Number(await ctx.get("len", ctx.key)) * 2);
  },
};

/** reduce over len: stats/total = { count, sum } */
export const stats: CellDef = {
  id: "stats",
  kind: "reduce",
  inputs: ["len"],
  outputs: ["stats"],
  async run(ctx) {
    const rows = await ctx.list("len");
    ctx.emit("stats", "total", {
      count: rows.length,
      sum: rows.reduce((a, r) => a + Number(r.value), 0),
    });
  },
};

/** Diamond: docs → left (l), right (r) → join (j). */
export const left: CellDef = {
  id: "left",
  inputs: ["docs"],
  outputs: ["l"],
  async run(ctx) {
    ctx.emit("l", ctx.key, `L(${await ctx.get("docs", ctx.key)})`);
  },
};
export const right: CellDef = {
  id: "right",
  inputs: ["docs"],
  outputs: ["r"],
  async run(ctx) {
    ctx.emit("r", ctx.key, `R(${await ctx.get("docs", ctx.key)})`);
  },
};
export const join: CellDef = {
  id: "join",
  inputs: ["l", "r"],
  outputs: ["j"],
  async run(ctx) {
    ctx.emit("j", ctx.key, `${await ctx.get("l", ctx.key)}+${await ctx.get("r", ctx.key)}`);
  },
};

/**
 * Dynamic dependencies, like a compiler following imports:
 * mods/<k> = { code, imports: [k2…] } → compiled/<k> = code + imported codes.
 * Which rows a task reads depends on the value it read first.
 */
export interface Mod {
  code: string;
  imports: string[];
}
export const compile: CellDef = {
  id: "compile",
  inputs: ["mods"],
  outputs: ["compiled"],
  async run(ctx) {
    const mod = (await ctx.get("mods", ctx.key)) as unknown as Mod;
    const parts = [mod.code];
    for (const dep of mod.imports) {
      const d = (await ctx.get("mods", dep)) as unknown as Mod | undefined;
      parts.push(d ? `${dep}:${d.code}` : `${dep}:missing`);
    }
    ctx.emit("compiled", ctx.key, parts.join("|"));
  },
};

/** compiled/<k> → bundle/<k>: a second stage reading the first stage's outputs dynamically. */
export const bundle: CellDef = {
  id: "bundle",
  inputs: ["compiled"],
  reads: ["mods"],
  outputs: ["bundle"],
  async run(ctx) {
    const self = String(await ctx.get("compiled", ctx.key));
    const mod = (await ctx.get("mods", ctx.key)) as unknown as Mod | undefined;
    const deps: string[] = [];
    for (const dep of mod?.imports ?? []) {
      deps.push(String(await ctx.get("compiled", dep)));
    }
    ctx.emit("bundle", ctx.key, [self, ...deps].join(" ; "));
  },
};

/** Snapshot of the given signals, for comparing engines. */
export async function snapshot(
  engine: Engine,
  signals: readonly string[],
): Promise<Record<string, Record<string, Json>>> {
  const out: Record<string, Record<string, Json>> = {};
  for (const s of signals) {
    out[s] = Object.fromEntries((await engine.list(s)).map((r) => [r.key, r.value]));
  }
  return out;
}

/** Deterministic PRNG (mulberry32) for property tests and benchmarks. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
