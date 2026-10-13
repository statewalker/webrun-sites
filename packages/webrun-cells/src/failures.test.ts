import { describe, expect, it } from "vitest";
import { CellEngine } from "./engine.js";
import { mapCell, memDb } from "./test-helpers.js";
import type { Cell } from "./types.js";

const copy = (fail: (key: string) => boolean) =>
  mapCell("copy", ["docs"], ["out"], (i) => {
    if (fail(i.key)) throw new Error("boom");
    return [{ signal: "out", key: i.key, value: i.value }];
  });

describe("failures", () => {
  it("retries a throwing input, dead-letters it, and commits the rest", async () => {
    let calls = 0;
    const c = copy((key) => {
      if (key !== "bad") return false;
      calls++;
      return true;
    });
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 3 });
    await engine.put("docs", "good", 1);
    await engine.put("docs", "bad", 2);
    expect(await engine.run()).toEqual({ committed: 1, failed: 3, deadLettered: 1 });
    expect(calls).toBe(3);
    expect(await engine.list("out")).toEqual([{ key: "good", value: 1 }]);
    expect(await engine.deadLetters()).toEqual([
      { cell: "copy", signal: "docs", key: "bad", attempts: 3, error: "Error: boom" },
    ]);
  });

  it("requeues a dead letter", async () => {
    let broken = true;
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => broken)], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    broken = false;
    await engine.requeue("copy", "docs", "a");
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "a")).toBe(1);
    expect(await engine.deadLetters()).toEqual([]);
    await expect(engine.requeue("nope", "docs", "a")).rejects.toThrow(/Unknown cell "nope"/);
  });

  it("refuses to requeue a signal the cell does not consume", async () => {
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => false)] });
    await expect(engine.requeue("copy", "other", "a")).rejects.toThrow(
      'Cell "copy" does not consume "other"',
    );
  });

  it("gives a dead-lettered input a fresh try when its source changes, and clears the dead letter", async () => {
    let broken = true;
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => broken)], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    expect(await engine.deadLetters()).toHaveLength(1);
    broken = false;
    await engine.put("docs", "a", 2); // a new value enqueues the input again
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "a")).toBe(2);
    expect(await engine.deadLetters()).toEqual([]);
  });

  it("keeps the old outputs of a failing input", async () => {
    let broken = false;
    const engine = new CellEngine({ db: memDb(), cells: [copy(() => broken)], maxAttempts: 1 });
    await engine.put("docs", "a", "v1");
    await engine.run();
    broken = true;
    await engine.put("docs", "a", "v2");
    await engine.run();
    expect(await engine.get("out", "a")).toBe("v1");
  });

  it("commits input 1 even when input 2 of the same batch throws", async () => {
    const engine = new CellEngine({
      db: memDb(),
      cells: [copy((key) => key === "b")],
      maxAttempts: 1,
    });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 2);
    await engine.run();
    expect(await engine.list("out")).toEqual([{ key: "a", value: 1 }]);
  });

  it("fails an input whose cell emits to an undeclared signal", async () => {
    const c = mapCell("c", ["docs"], ["out"], (i) => [{ signal: "other", key: i.key, value: 1 }]);
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    expect((await engine.deadLetters())[0]?.error).toMatch(/undeclared signal "other"/);
  });

  it("records the input's failure when the cell's cleanup throws too", async () => {
    const c: Cell = {
      id: "c",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        try {
          for await (const i of inputs) yield { signal: "nope", key: i.key, value: 1 };
        } finally {
          // biome-ignore lint/correctness/noUnsafeFinally: a cell whose cleanup throws
          throw new Error("cleanup failed");
        }
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    expect(await engine.run()).toEqual({ committed: 0, failed: 1, deadLettered: 1 });
    expect((await engine.deadLetters())[0]?.error).toMatch(/undeclared signal "nope"/);
  });

  it("treats a cell throwing undefined as a failure, not a success", async () => {
    let fail = false;
    const c: Cell = {
      id: "c",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const i of inputs) {
          yield { signal: "out", key: "x", value: i.value };
          if (fail) throw undefined;
          yield { signal: "out", key: "y", value: i.value };
        }
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    fail = true;
    await engine.put("docs", "a", 2);
    expect(await engine.run()).toEqual({ committed: 0, failed: 1, deadLettered: 1 });
    expect(await engine.list("out")).toEqual([
      { key: "x", value: 1 },
      { key: "y", value: 1 },
    ]);
    expect((await engine.deadLetters())[0]?.error).toBe("undefined");
  });

  it("fails an input whose emission conflicts with another input's", async () => {
    const c = mapCell("c", ["docs"], ["out"], (i) => [
      { signal: "out", key: "same", value: i.value },
    ]);
    const engine = new CellEngine({ db: memDb(), cells: [c], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 2);
    await engine.run();
    expect(await engine.get("out", "same")).toBe(1);
    const [dead] = await engine.deadLetters();
    expect(dead?.key).toBe("b");
    expect(dead?.error).toMatch(/^ConflictingEmission: /);
  });

  it("converges a shared output when every producer changes it together", async () => {
    let shared = 1;
    const c = mapCell("c", ["docs"], ["out"], () => [
      { signal: "out", key: "shared", value: shared },
    ]);
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 1);
    await engine.run();
    shared = 2;
    await engine.put("docs", "a", 2);
    await engine.put("docs", "b", 2);
    expect(await engine.run()).toEqual({ committed: 2, failed: 0, deadLettered: 0 });
    expect(await engine.get("out", "shared")).toBe(2);
    expect(await engine.deadLetters()).toEqual([]);
  });

  it("fails the first input when a cell yields before pulling one", async () => {
    const eager: Cell = {
      id: "eager",
      inputs: ["docs"],
      outputs: ["out"],
      async *run() {
        yield { signal: "out", key: "x", value: 1 };
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [eager], maxAttempts: 1 });
    await engine.put("docs", "a", 1);
    await engine.run();
    expect((await engine.deadLetters())[0]?.error).toMatch(/before pulling an input/);
  });

  it("leaves inputs queued for the next run when a cell returns without pulling", async () => {
    let lazy = true;
    const c: Cell = {
      id: "c",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        if (lazy) return;
        for await (const i of inputs) yield { signal: "out", key: i.key, value: i.value };
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [c] });
    await engine.put("docs", "a", 1);
    expect(await engine.run()).toEqual({ committed: 0, failed: 0, deadLettered: 0 });
    lazy = false;
    expect(await engine.run()).toEqual({ committed: 1, failed: 0, deadLettered: 0 });
  });

  it("finishes the batch in the same run when a cell pulls one input per invocation", async () => {
    const one: Cell = {
      id: "one",
      inputs: ["docs"],
      outputs: ["out"],
      async *run(inputs) {
        for await (const i of inputs) {
          yield { signal: "out", key: i.key, value: i.value };
          return;
        }
      },
    };
    const engine = new CellEngine({ db: memDb(), cells: [one] });
    await engine.put("docs", "a", 1);
    await engine.put("docs", "b", 2);
    expect(await engine.run()).toEqual({ committed: 2, failed: 0, deadLettered: 0 });
  });
});
