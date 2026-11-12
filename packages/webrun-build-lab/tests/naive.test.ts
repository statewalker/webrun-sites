import { describe, expect, it } from "vitest";
import { len, snapshot, split, stats, upper } from "../src/core/fixtures.js";
import { MemKV } from "../src/core/kv.js";
import { NaiveEngine } from "../src/prototypes/naive.js";

describe("P0 naive — reference semantics", () => {
  it("computes, retracts, and skips a run when no source changed", async () => {
    const kv = new MemKV();
    const e = new NaiveEngine({ kv, cells: [stats, upper, split, len] });
    await e.put("docs", "a", "hello world");
    await e.put("docs", "b", "x");
    expect((await e.run()).executed).toBe(8); // split×2 + len×2 + upper×3 + stats
    expect(await snapshot(e, ["upper", "stats"])).toEqual({
      upper: { "a#0": "HELLO", "a#1": "WORLD", "b#0": "X" },
      stats: { total: { count: 2, sum: 12 } },
    });
    expect((await e.run()).executed).toBe(0);
    await e.remove("docs", "a");
    await e.run();
    expect(await snapshot(e, ["upper", "stats"])).toEqual({
      upper: { "b#0": "X" },
      stats: { total: { count: 1, sum: 1 } },
    });
  });
});
