/**
 * The README's "several inputs, several outputs" examples, executed:
 * configs + files → content + screenshots.
 */
import { describe, expect, it } from "vitest";
import { BuildEngine, type BuilderDef, type Json, MemKV } from "../src/index.js";

interface RenderConfig {
  viewports: string[];
  uppercase?: boolean;
}

/** Shared configuration: every file reads `configs/render`. */
function renderBuilder(ran: string[]): BuilderDef {
  return {
    id: "render",
    inputs: ["files"], // one task per file
    reads: ["configs"], // plus a dynamic read of the shared config row
    outputs: ["content", "screenshots"], // two output collections
    async run(ctx) {
      ran.push(ctx.key);
      const text = String(await ctx.get("files", ctx.key));
      const config = ((await ctx.get("configs", "render")) ?? {
        viewports: [],
      }) as unknown as RenderConfig;
      ctx.emit("content", ctx.key, config.uppercase ? text.toUpperCase() : text);
      for (const viewport of config.viewports) {
        // In a real build: render, write the PNG somewhere, emit its fingerprint.
        ctx.emit("screenshots", `${ctx.key}@${viewport}`, { viewport, width: text.length });
      }
    },
  };
}

/** Per-file configuration: tasks keyed by the same key in both inputs (a join). */
const pageBuilder: BuilderDef = {
  id: "page",
  inputs: ["configs", "files"], // a task exists while the key is in either collection
  outputs: ["content", "screenshots"],
  async run(ctx) {
    const text = await ctx.get("files", ctx.key);
    const config = (await ctx.get("configs", ctx.key)) as unknown as RenderConfig | undefined;
    if (text === undefined) return; // config without a file yet: nothing to render
    ctx.emit("content", ctx.key, String(text));
    for (const viewport of config?.viewports ?? ["default"]) {
      ctx.emit("screenshots", `${ctx.key}@${viewport}`, { viewport });
    }
  },
};

describe("several inputs, several outputs: configs + files → content + screenshots", () => {
  it("shared config: a config change re-renders every file; a file change only that file", async () => {
    const ran: string[] = [];
    const engine = new BuildEngine({ store: new MemKV(), builders: [renderBuilder(ran)] });
    await engine.put("configs", "render", { viewports: ["desktop", "mobile"] } as unknown as Json);
    await engine.put("files", "a.html", "alpha");
    await engine.put("files", "b.html", "beta");
    await engine.run();
    expect(await engine.keys("screenshots")).toEqual([
      "a.html@desktop",
      "a.html@mobile",
      "b.html@desktop",
      "b.html@mobile",
    ]);

    ran.length = 0;
    await engine.put("files", "a.html", "alpha two");
    await engine.run();
    expect(ran).toEqual(["a.html"]);

    // Fewer viewports: every file re-renders; the dropped screenshots are retracted.
    ran.length = 0;
    await engine.put("configs", "render", {
      viewports: ["desktop"],
      uppercase: true,
    } as unknown as Json);
    await engine.run();
    expect(ran.sort()).toEqual(["a.html", "b.html"]);
    expect(await engine.keys("screenshots")).toEqual(["a.html@desktop", "b.html@desktop"]);
    expect(await engine.get("content", "b.html")).toBe("BETA");

    // Removing a file retracts its rows in both output collections.
    await engine.remove("files", "b.html");
    await engine.run();
    expect(await engine.keys("content")).toEqual(["a.html"]);
    expect(await engine.keys("screenshots")).toEqual(["a.html@desktop"]);
  });

  it("per-file config (join on the key): either input changing re-runs that key only", async () => {
    const engine = new BuildEngine({ store: new MemKV(), builders: [pageBuilder] });
    await engine.put("files", "a", "alpha");
    await engine.put("files", "b", "beta");
    await engine.put("configs", "a", { viewports: ["desktop", "mobile"] } as unknown as Json);
    await engine.run();
    expect(await engine.keys("screenshots")).toEqual(["a@desktop", "a@mobile", "b@default"]);

    await engine.put("configs", "b", { viewports: ["print"] } as unknown as Json);
    await engine.run();
    expect(await engine.keys("screenshots")).toEqual(["a@desktop", "a@mobile", "b@print"]);

    await engine.remove("files", "a"); // config a remains: the task lives, emits nothing
    await engine.run();
    expect(await engine.keys("content")).toEqual(["b"]);
    expect(await engine.keys("screenshots")).toEqual(["b@print"]);
  });
});
